const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use(express.static(path.join(__dirname, '../public')));

// Force Supabase Connection Pooler (Ignoring Vercel ENV which might contain the wrong IPv4 direct url that fails on serverless)
let PG_URL = process.env.DATABASE_URL || 'postgresql://postgres.wdddjdckmzxbtnozxcat:hackelqulob%40gmail@aws-1-eu-west-1.pooler.supabase.com:6543/postgres';

// Auto-fix Vercel ENV if the user copied the direct connection URL instead of Pooler
if (PG_URL.includes('db.wdddjdckmzxbtnozxcat.supabase.co')) {
    PG_URL = PG_URL.replace('db.wdddjdckmzxbtnozxcat.supabase.co', 'aws-1-eu-west-1.pooler.supabase.com');
    PG_URL = PG_URL.replace(':5432', ':6543');
    if (!PG_URL.includes('postgres.wdddjdckmzxbtnozxcat')) {
        PG_URL = PG_URL.replace('postgres:', 'postgres.wdddjdckmzxbtnozxcat:');
    }
}

const pool = new Pool({
    connectionString: PG_URL,
    ssl: { rejectUnauthorized: false }
});

// ====== DB HELPERS ====== //
function replaceParams(sql) {
    let i = 1;
    return sql.replace(/\?/g, () => `$${i++}`);
}

async function dbRun(sql, params = []) {
    const pgSql = replaceParams(sql);
    let finalSql = pgSql;
    // Add RETURNING id if it's an insert to mimic SQLite's lastID
    if (finalSql.trim().toUpperCase().startsWith('INSERT') && !finalSql.toUpperCase().includes('RETURNING')) {
        finalSql += ' RETURNING id';
    }
    const res = await pool.query(finalSql, params);
    return { lastID: res.rows[0]?.id, changes: res.rowCount };
}

async function dbAll(sql, params = []) {
    const res = await pool.query(replaceParams(sql), params);
    return res.rows.map(row => {
        for (const key in row) {
            if (row[key] instanceof Date) {
                const d = row[key];
                const pad = n => String(n).padStart(2, '0');
                row[key] = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            }
        }
        return row;
    });
}

async function dbGet(sql, params = []) {
    const res = await pool.query(replaceParams(sql), params);
    let row = res.rows[0];
    if (row) {
        for (const key in row) {
            if (row[key] instanceof Date) {
                const d = row[key];
                const pad = n => String(n).padStart(2, '0');
                row[key] = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            }
        }
    }
    return row;
}

// ==== INIT DB TABLES ==== //
async function initDB() {
    const tableQueries = [
        `CREATE TABLE IF NOT EXISTS owners (
            id SERIAL PRIMARY KEY,
            phone TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            name TEXT,
            plan TEXT,
            renewal_day INTEGER DEFAULT 7,
            total_gigabytes INTEGER DEFAULT 0,
            status TEXT DEFAULT 'نشط',
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`,
        `CREATE TABLE IF NOT EXISTS bookings (
            id SERIAL PRIMARY KEY,
            owner_id INTEGER,
            owner_phone TEXT,
            name TEXT,
            phone TEXT NOT NULL,
            password TEXT,
            gigabytes INTEGER NOT NULL DEFAULT 0,
            renewal_day INTEGER NOT NULL DEFAULT 7,
            status TEXT DEFAULT 'محجوز',
            last_usage_data JSONB,
            last_usage_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            owner_tg TEXT,
            owner_username TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS monthly_payments (
            id SERIAL PRIMARY KEY,
            booking_id INTEGER,
            renewal_day INTEGER NOT NULL DEFAULT 7,
            year_month TEXT NOT NULL,
            paid INTEGER DEFAULT 0,
            paid_at TIMESTAMP,
            activated INTEGER DEFAULT 0,
            activated_at TIMESTAMP,
            UNIQUE(booking_id, year_month)
        );`,
        `CREATE TABLE IF NOT EXISTS bot_admins (
            id SERIAL PRIMARY KEY,
            tg_id TEXT UNIQUE NOT NULL,
            name TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS booking_chats (
            id SERIAL PRIMARY KEY,
            booking_id INTEGER,
            sender TEXT,
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`,
        `CREATE TABLE IF NOT EXISTS customer_payments (
            id SERIAL PRIMARY KEY,
            booking_id INTEGER,
            year_month TEXT NOT NULL,
            amount NUMERIC(10,2) NOT NULL DEFAULT 0,
            method TEXT DEFAULT 'vodafone_cash',
            sender_phone TEXT,
            transaction_ref TEXT,
            screenshot_url TEXT,
            status TEXT DEFAULT 'pending',
            payment_type TEXT DEFAULT 'renewal',
            phone TEXT,
            password TEXT,
            gigabytes INTEGER,
            renewal_day INTEGER,
            verification_attempts INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            verified_at TIMESTAMP,
            notes TEXT,
            sender_name TEXT,
            reject_reason TEXT,
            owner_tg TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS admin_notifications (
            id SERIAL PRIMARY KEY,
            type TEXT DEFAULT 'invitation_accepted',
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            data JSONB,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`
    ];

    for (const q of tableQueries) {
        try {
            await pool.query(q);
        } catch (e) {
            console.warn('Table create warning:', e.message);
        }
    }

    // Add columns individually so NO failure cascades or aborts others
    const columnQueries = [
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invitation_accepted_at TIMESTAMP;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS total_gigabytes INTEGER DEFAULT 0;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS plan TEXT;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS renewal_day INTEGER DEFAULT 7;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS notes TEXT;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'نشط';`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS password_valid BOOLEAN DEFAULT TRUE;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS password_error TEXT;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
        `ALTER TABLE owners ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,

        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_id INTEGER;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_phone TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_name TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS name TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS password TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS password_valid BOOLEAN DEFAULT TRUE;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS password_error TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS next_gigabytes INTEGER;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS next_quota_notes TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gigabytes INTEGER DEFAULT 0;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS renewal_day INTEGER DEFAULT 7;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'محجوز';`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_tg TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_username TEXT;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_usage_data JSONB;`,
        `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_usage_at TIMESTAMP;`,
        `ALTER TABLE bookings ALTER COLUMN password DROP NOT NULL;`,

        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS screenshot_url TEXT;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'renewal';`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS phone TEXT;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS password TEXT;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS gigabytes INTEGER;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS renewal_day INTEGER;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS sender_name TEXT;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS reject_reason TEXT;`,
        `ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS owner_tg TEXT;`
    ];

    for (const q of columnQueries) {
        try {
            await pool.query(q);
        } catch (e) {
            // column might already exist or minor difference
        }
    }

    try {
        await pool.query(`INSERT INTO bot_admins (tg_id, name) VALUES ('1255885099', 'Super Admin') ON CONFLICT (tg_id) DO NOTHING;`);
    } catch (_) {}

    try {
        await pool.query(`
            INSERT INTO settings(key, value) VALUES (
                'sixth_month_reminder_template', 
                '"⚠️ *تنبيه دورة التجديد السادسة والأخيرة*\n\nعزيزي العميل،\nنحيطك علماً بأن باقة الخط {phone} قد وصلت إلى *الشهر السادس* (نهاية دورة الـ 6 شهور).\nهذا هو الشهر الأخير في دورتك الحالية.\nبعد انتهاء هذا الشهر، يمكنك اختيار الخروج من النظام أو تجديد دورة جديدة لمدة 6 شهور أخرى.\n\nلأي استفسار يرجى التواصل مع الدعم الفني."'
            ) ON CONFLICT (key) DO NOTHING;
        `);
    } catch (_) {}
}

let dbInitPromise = null;
function ensureDB() {
    if (!dbInitPromise) {
        dbInitPromise = initDB().catch(err => {
            console.error('ensureDB failed:', err);
            dbInitPromise = null;
        });
    }
    return dbInitPromise;
}

// Call on startup
ensureDB();

// Middleware to await DB initialization on all API requests
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api')) {
        await ensureDB();
    }
    next();
});

// ==== UTILS ==== //
function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtMonth(ym) {
    const [y, m] = ym.split('-');
    const names = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${names[parseInt(m) - 1]} ${y}`;
}
function toEnglish(s) { return String(s).replace(/[\u0660-\u0669]/g, d => d.charCodeAt(0) - 0x0660); }
function getPaymentWindow(renewalDay) { return { start: 1, end: 31 }; } // Payment open anytime
function isInPaymentWindow(renewalDay) {
    return true; // Payment always open
}

// Package prices (Configurable dynamically by Super Admin)
const DEFAULT_PACKAGE_PRICES = { 20: 250, 30: 350, 40: 450, 60: 600, 70: 700, 85: 800 };
let packagePricesCache = null;
let packagePricesCacheTime = 0;

async function getPackagePrices() {
    const now = Date.now();
    if (packagePricesCache && (now - packagePricesCacheTime < 30000)) {
        return packagePricesCache;
    }
    try {
        const row = await dbGet(`SELECT value FROM settings WHERE key = 'package_prices'`);
        if (row && row.value) {
            let parsed = row.value;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch (_) {}
            }
            if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
                packagePricesCache = parsed;
                packagePricesCacheTime = now;
                return parsed;
            }
        }
    } catch (_) {}
    packagePricesCache = { ...DEFAULT_PACKAGE_PRICES };
    packagePricesCacheTime = now;
    return packagePricesCache;
}

async function getPackagePrice(gigs) {
    const prices = await getPackagePrices();
    const g = parseInt(gigs, 10);
    if (!isNaN(g)) {
        if (prices[g] !== undefined) return Number(prices[g]);
        if (prices[String(g)] !== undefined) return Number(prices[String(g)]);
    }
    return DEFAULT_PACKAGE_PRICES[g] || 0;
}

const STATUSES = ['محجوز', 'ضن', 'اتفعل', 'متأكتف', 'متكنسل'];
const STATUS_ICONS = { 'محجوز': '🔴', 'ضن': '🟡', 'اتفعل': '🔵', 'متأكتف': '🟢', 'متكنسل': '⚫' };

// Synchronize or backfill past monthly payments for a booking
async function syncPastRenewals(bookingId, renewalDay, startDate, count) {
    if (!count || Number(count) <= 0) return;
    const n = Math.min(Number(count), 48); // cap at 48 months
    const curYm = currentMonth();
    let start = startDate ? new Date(startDate) : new Date();
    if (isNaN(start.getTime())) start = new Date();

    // If start date is in current or future month but count > 1, shift start backwards
    const startYm = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    if (startYm >= curYm && n > 1) {
        start = new Date(start.getFullYear(), start.getMonth() - (n - 1), 1);
    }

    let y = start.getFullYear();
    let m = start.getMonth() + 1;

    for (let i = 0; i < n; i++) {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        if (ym <= curYm) {
            const existing = await dbGet(`SELECT id, paid FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [bookingId, ym]);
            if (!existing) {
                await dbRun(
                    `INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at, activated, activated_at) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
                    [bookingId, renewalDay, ym]
                );
            } else if (existing.paid !== 1) {
                await dbRun(
                    `UPDATE monthly_payments SET paid = 1, paid_at = CURRENT_TIMESTAMP, activated = 1 WHERE id = ?`,
                    [existing.id]
                );
            }
        }
        m++;
        if (m > 12) {
            m = 1;
            y++;
        }
    }
}

// ============================================ //
//                  REST API                    //
// ============================================ //

// ============================================ //
//          OWNERS & MEMBERS REST API           //
// ============================================ //

// 1. Get all owners with their members
app.get('/api/owners', async (req, res) => {
    try {
        const owners = await dbAll(`SELECT * FROM owners ORDER BY id DESC`);
        const ownersWithMembers = await Promise.all(owners.map(async (o) => {
            const members = await dbAll(
                `SELECT b.*, 
                 (SELECT COUNT(*)::int FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as renewal_count
                 FROM bookings b 
                 WHERE (b.owner_id = ? OR b.owner_phone = ?) AND b.deleted_at IS NULL 
                 ORDER BY b.id DESC`,
                [o.id, o.phone]
            );
            const assignedGigs = parseFloat(members.reduce((sum, m) => sum + (Number(m.gigabytes) || 0), 0).toFixed(1));
            const nextAssignedGigs = parseFloat(members.reduce((sum, m) => sum + (Number(m.next_gigabytes || m.gigabytes) || 0), 0).toFixed(1));
            let totalPkgGigs = parseFloat((Number(o.total_gigabytes) || assignedGigs).toFixed(1));
            if (totalPkgGigs === 200 || (totalPkgGigs > 195 && totalPkgGigs < 205) || (!totalPkgGigs && o.plan?.includes('3000'))) {
                totalPkgGigs = 204.8;
            }
            const remainingGigs = parseFloat(Math.max(0, totalPkgGigs - assignedGigs).toFixed(1));
            const nextRemainingGigs = parseFloat(Math.max(0, totalPkgGigs - nextAssignedGigs).toFixed(1));
            return {
                ...o,
                members,
                members_count: members.length,
                assigned_gigabytes: assignedGigs,
                next_assigned_gigabytes: nextAssignedGigs,
                package_gigabytes: totalPkgGigs,
                total_gigabytes: totalPkgGigs,
                remaining_gigabytes: remainingGigs,
                next_remaining_gigabytes: nextRemainingGigs
            };
        }));
        res.json({ success: true, data: ownersWithMembers });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Get single owner by id
app.get('/api/owners/:id', async (req, res) => {
    try {
        const o = await dbGet(`SELECT * FROM owners WHERE id = ?`, [req.params.id]);
        if (!o) return res.status(404).json({ success: false, error: 'الأونر غير موجود' });
        const members = await dbAll(
            `SELECT b.*, 
             (SELECT COUNT(*)::int FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as renewal_count
             FROM bookings b 
             WHERE (b.owner_id = ? OR b.owner_phone = ?) AND b.deleted_at IS NULL 
             ORDER BY b.id DESC`,
            [o.id, o.phone]
        );
        const assignedGigs = members.reduce((sum, m) => sum + (Number(m.gigabytes) || 0), 0);
        let totalPkgGigs = parseFloat((Number(o.total_gigabytes) || assignedGigs).toFixed(1));
        if (totalPkgGigs === 200 || (totalPkgGigs > 195 && totalPkgGigs < 205) || (!totalPkgGigs && o.plan?.includes('3000'))) {
            totalPkgGigs = 204.8;
        }
        res.json({
            success: true,
            data: {
                ...o,
                members,
                members_count: members.length,
                assigned_gigabytes: assignedGigs,
                package_gigabytes: totalPkgGigs,
                total_gigabytes: totalPkgGigs,
                remaining_gigabytes: parseFloat(Math.max(0, totalPkgGigs - assignedGigs).toFixed(1))
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Add new Owner (Verifies with Vodafone first!)
app.post('/api/owners', async (req, res) => {
    try {
        let { phone, password, name, renewal_day, notes } = req.body || {};
        if (!phone || !password) {
            return res.status(400).json({ success: false, error: 'رقم الأونر وكلمة المرور مطلوبان' });
        }
        phone = toEnglish(String(phone).trim().replace(/[\s-]/g, ''));
        password = String(password).trim();
        renewal_day = Number(renewal_day) || 7;

        // 1. Verify with Vodafone First!
        const vf = await fastVodafoneCheck(phone, password);
        if (!vf.valid) {
            return res.status(400).json({
                success: false,
                error: vf.message || 'الباسورد غير صحيح لدى فودافون ❌ تأكد من باسورد أنا فودافون الخاص بالأونر'
            });
        }

        const vfData = vf.details || {};
        const resolvedName = name || vfData.name || 'أونر فودافون';
        const resolvedPlan = vfData.currentPlan || null;
        const resolvedRenewalDay = vfData.renewal_day || (renewal_day && Number(renewal_day) !== 7 ? Number(renewal_day) : 11);
        let resolvedTotalGB = vfData.total_gigabytes || 0;
        resolvedTotalGB = Number(resolvedTotalGB) || 0;
        if (resolvedTotalGB === 200 || (resolvedTotalGB >= 195 && resolvedTotalGB <= 205) || (!resolvedTotalGB && String(resolvedPlan || '').includes('3000'))) {
            resolvedTotalGB = 204.8;
        }

        // 2. Save or update Owner
        try {
            await pool.query('ALTER TABLE owners ADD COLUMN IF NOT EXISTS total_gigabytes INTEGER DEFAULT 0;').catch(() => {});
            await pool.query('ALTER TABLE owners ADD COLUMN IF NOT EXISTS plan TEXT;').catch(() => {});
            await pool.query('ALTER TABLE owners ADD COLUMN IF NOT EXISTS renewal_day INTEGER DEFAULT 7;').catch(() => {});
            await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_id INTEGER;').catch(() => {});
            await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS owner_phone TEXT;').catch(() => {});
        } catch (_) {}

        const existing = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [phone]);
        let ownerId;
        try {
            if (existing) {
                await dbRun(
                    `UPDATE owners SET password = ?, name = ?, plan = ?, renewal_day = ?, total_gigabytes = ?, status = 'نشط', notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [password, resolvedName, resolvedPlan, resolvedRenewalDay, resolvedTotalGB, notes || existing.notes || null, existing.id]
                );
                ownerId = existing.id;
            } else {
                const result = await dbRun(
                    `INSERT INTO owners (phone, password, name, plan, renewal_day, total_gigabytes, status, notes) VALUES (?, ?, ?, ?, ?, ?, 'نشط', ?)`,
                    [phone, password, resolvedName, resolvedPlan, resolvedRenewalDay, resolvedTotalGB, notes || null]
                );
                ownerId = result.lastID;
            }
        } catch (dbErr) {
            if (String(dbErr.message).includes('total_gigabytes') || String(dbErr.message).includes('column')) {
                await pool.query('ALTER TABLE owners ADD COLUMN IF NOT EXISTS total_gigabytes INTEGER DEFAULT 0;').catch(() => {});
                if (existing) {
                    await dbRun(
                        `UPDATE owners SET password = ?, name = ?, plan = ?, renewal_day = ?, total_gigabytes = ?, status = 'نشط', notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [password, resolvedName, resolvedPlan, resolvedRenewalDay, resolvedTotalGB, notes || existing.notes || null, existing.id]
                    );
                    ownerId = existing.id;
                } else {
                    const result = await dbRun(
                        `INSERT INTO owners (phone, password, name, plan, renewal_day, total_gigabytes, status, notes) VALUES (?, ?, ?, ?, ?, ?, 'نشط', ?)`,
                        [phone, password, resolvedName, resolvedPlan, resolvedRenewalDay, resolvedTotalGB, notes || null]
                    );
                    ownerId = result.lastID;
                }
            } else {
                throw dbErr;
            }
        }

        // 3. Auto-import all discovered Family Members (الأفراد) under this Owner!
        const autoImported = [];
        if (Array.isArray(vfData.familyMembers) && vfData.familyMembers.length > 0) {
            for (const m of vfData.familyMembers) {
                if (!m.phone) continue;
                const mGigs = m.gigabytes || 20;
                const existingMember = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [m.phone]);
                if (existingMember) {
                    await dbRun(
                        `UPDATE bookings SET owner_id = ?, owner_phone = ?, gigabytes = ?, renewal_day = ?, status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [ownerId, phone, mGigs, resolvedRenewalDay, existingMember.id]
                    );
                    autoImported.push(m.phone);
                } else {
                    await dbRun(
                        `INSERT INTO bookings (owner_id, owner_phone, phone, gigabytes, renewal_day, status, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'متأكتف', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [ownerId, phone, m.phone, mGigs, resolvedRenewalDay, `فرد (${m.phone.slice(-4)})`]
                    );
                    autoImported.push(m.phone);
                }
            }
        }

        const savedOwner = await dbGet(`SELECT * FROM owners WHERE id = ?`, [ownerId]);
        const members = await dbAll(`SELECT * FROM bookings WHERE (owner_id = ? OR owner_phone = ?) AND deleted_at IS NULL ORDER BY id ASC`, [ownerId, phone]);

        res.json({
            success: true,
            message: autoImported.length > 0 
                ? `تم التحقق من الأونر واستيراد ${autoImported.length} أفراد تلقائياً بنجاح! 🎉`
                : 'تم التحقق من الأونر وحفظه بنجاح ✅',
            data: {
                ...savedOwner,
                members,
                members_count: members.length,
                auto_imported_count: autoImported.length,
                vfDetails: vfData
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. Update Owner
app.put('/api/owners/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const owner = await dbGet(`SELECT * FROM owners WHERE id = ?`, [id]);
        if (!owner) return res.status(404).json({ success: false, error: 'الأونر غير موجود' });

        let { phone, password, name, renewal_day, status, notes } = req.body || {};
        phone = phone ? toEnglish(String(phone).trim().replace(/[\s-]/g, '')) : owner.phone;
        password = password !== undefined ? String(password).trim() : owner.password;
        name = name !== undefined ? name : owner.name;
        renewal_day = renewal_day ? Number(renewal_day) : owner.renewal_day;
        status = status || owner.status;
        notes = notes !== undefined ? notes : owner.notes;

        if (password && password !== owner.password) {
            const shouldChangeVodafone = req.body?.changeVodafone !== false;
            if (shouldChangeVodafone) {
                const vfChange = await changeVodafoneOwnerPassword(owner, owner.password, password);
                if (!vfChange.success) {
                    return res.status(400).json({ success: false, error: vfChange.error });
                }
            } else {
                const vf = await fastVodafoneCheck(phone, password);
                if (!vf.valid) {
                    return res.status(400).json({ success: false, error: vf.message || 'الباسورد الجديد غير صحيح لدى فودافون' });
                }
            }
        }

        await dbRun(
            `UPDATE owners SET phone = ?, password = ?, name = ?, renewal_day = ?, status = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [phone, password, name, renewal_day, status, notes, id]
        );

        if (phone !== owner.phone) {
            await dbRun(`UPDATE bookings SET owner_phone = ? WHERE owner_id = ?`, [phone, id]);
        }

        const updated = await dbGet(`SELECT * FROM owners WHERE id = ?`, [id]);
        res.json({ success: true, message: 'تم تحديث بيانات الأونر بنجاح', data: updated });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. Delete Owner
app.delete('/api/owners/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun(`DELETE FROM bookings WHERE owner_id = ?`, [id]);
        const result = await dbRun(`DELETE FROM owners WHERE id = ?`, [id]);
        if (result.changes === 0) return res.status(404).json({ success: false, error: 'الأونر غير موجود' });
        res.json({ success: true, message: 'تم حذف الأونر وجميع أفراده بنجاح' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================ //
//     VODAFONE RED FAMILY DXL ENGINE          //
// ============================================ //

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const ownerTokenCache = new Map();

function displayMsisdn(m) {
    if (!m) return '';
    let s = String(m).replace(/[^0-9]/g, '');
    if (s.startsWith('20') && s.length === 12) s = s.substring(2);
    if (!s.startsWith('0') && s.length === 10) s = '0' + s;
    return s;
}

function extractVodafoneCookies(resp, cookieMap) {
    const getSetCookie = resp.headers.getSetCookie;
    let rawCookies = [];
    if (typeof getSetCookie === 'function') {
        rawCookies = resp.headers.getSetCookie() || [];
    } else {
        const sc = resp.headers.get('set-cookie');
        if (sc) rawCookies = [sc];
    }
    for (const rc of rawCookies) {
        const parts = rc.split(';')[0].split('=');
        if (parts.length >= 2) {
            const k = parts[0].trim();
            const v = parts.slice(1).join('=').trim();
            if (k && v && v !== 'deleted') {
                cookieMap[k] = v;
            }
        }
    }
}

function serializeCookieMap(cookieMap) {
    return Object.entries(cookieMap)
        .filter(([_, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

async function authenticateVodafoneOwner(phone, password) {
    const normPhone = displayMsisdn(phone);
    const cookieMap = {};

    const authUrl = "https://web.vodafone.com.eg/auth/realms/vf-realm/protocol/openid-connect/auth?client_id=website&redirect_uri=https%3A%2F%2Fweb.vodafone.com.eg%2Fspa%2FmyHome&response_type=code&scope=openid";

    console.log(`[AUTH] Authenticating Vodafone line ${normPhone}...`);

    let currentUrl = authUrl;
    let pageResp = await fetch(currentUrl, {
        headers: { 'User-Agent': BROWSER_UA },
        redirect: 'manual'
    });
    extractVodafoneCookies(pageResp, cookieMap);

    while ([301, 302, 303, 307, 308].includes(pageResp.status)) {
        const loc = pageResp.headers.get('location');
        if (!loc) break;
        currentUrl = new URL(loc, currentUrl).toString();
        pageResp = await fetch(currentUrl, {
            headers: {
                'User-Agent': BROWSER_UA,
                'Cookie': serializeCookieMap(cookieMap)
            },
            redirect: 'manual'
        });
        extractVodafoneCookies(pageResp, cookieMap);
    }

    const pageHtml = await pageResp.text();
    const formActionMatch = pageHtml.match(/<form[^>]*id=["']kc-form-login["'][^>]*action=["']([^"']+)["']/i)
        || pageHtml.match(/action=["'](https:\/\/web\.vodafone\.com\.eg\/auth\/realms\/vf-realm\/login-actions\/authenticate[^"']+)["']/i)
        || pageHtml.match(/action=["']([^"']*\/login-actions\/authenticate[^"']*)["']/i);

    if (!formActionMatch) {
        return { success: false, message: 'تعذر العثور على نموذج تسجيل الدخول في فودافون' };
    }

    let actionUrl = formActionMatch[1].replace(/&amp;/g, '&');
    if (actionUrl.startsWith('/')) {
        actionUrl = new URL(actionUrl, currentUrl).toString();
    }

    const postParams = new URLSearchParams({
        username: normPhone,
        password: password,
        rememberMe: 'on',
        login: ''
    });

    const postResp = await fetch(actionUrl, {
        method: 'POST',
        headers: {
            'User-Agent': BROWSER_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': currentUrl,
            'Cookie': serializeCookieMap(cookieMap)
        },
        body: postParams.toString(),
        redirect: 'manual'
    });

    extractVodafoneCookies(postResp, cookieMap);

    const postText = await postResp.text();
    const locationHeader = postResp.headers.get('location') || '';

    if (postText.includes('invalid') || postText.includes('error') || postText.includes('كلمة المرور غير صحيحة')) {
        return { success: false, message: 'رقم الموبايل أو كلمة السر غير صحيحة على شبكة فودافون' };
    }

    if (postText.includes('otp') || postText.includes('verification') || postText.includes('كود التحقق')) {
        return { success: false, message: 'فودافون تطلب كود التحقق (OTP) المرسل للهاتف' };
    }

    if (!locationHeader) {
        return { success: false, message: 'فشل التحقق من الحساب: لم يتم تحويل الجلسة' };
    }

    const codeMatch = locationHeader.match(/[?&]code=([^&]+)/);
    if (!codeMatch) {
        return { success: false, message: 'فشل استلام كود التفويض من بوابة الدخول' };
    }

    const tokenUrl = "https://web.vodafone.com.eg/auth/realms/vf-realm/protocol/openid-connect/token";
    const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'website',
        redirect_uri: 'https://web.vodafone.com.eg/spa/myHome',
        code: codeMatch[1]
    });

    const tokenResp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'User-Agent': BROWSER_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': serializeCookieMap(cookieMap)
        },
        body: tokenParams.toString()
    });

    let tokenJson = null;
    try {
        tokenJson = await tokenResp.json();
    } catch (e) {
        return { success: false, message: 'استجابة غير صحيحة من سيرفر التوكن' };
    }

    if (!tokenJson || !tokenJson.access_token) {
        return { success: false, message: 'لم يتم استلام access_token من فودافون' };
    }

    let profile = { name: "مالك فودافون", planName: "Vodafone RED", accountNumber: "N/A" };
    try {
        const parts = tokenJson.access_token.split('.');
        const claims = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (claims.userInfo) {
            profile.name = `${claims.userInfo.firstName || ''} ${claims.userInfo.lastName || ''}`.trim() || profile.name;
            profile.planName = claims.userInfo.tariffModelName || profile.planName;
            profile.accountNumber = claims.userInfo.accountNumber || profile.accountNumber;
            const rawDate = claims.userInfo.billCycleDate ? claims.userInfo.billCycleDate.split('T')[0] : null;
            let day = 17;
            if (claims.userInfo.billCycleCode) {
                const parsedCode = parseInt(claims.userInfo.billCycleCode, 10);
                if (parsedCode >= 1 && parsedCode <= 31) day = parsedCode;
            } else if (rawDate) {
                const p = rawDate.split('-');
                if (p.length === 3) {
                    const parsedDay = parseInt(p[2], 10);
                    if (parsedDay >= 1 && parsedDay <= 31) day = parsedDay;
                }
            }
            profile.billCycleDate = rawDate || '2026-11-11';
            profile.renewalDay = day;
        }
    } catch (_) {}

    return {
        success: true,
        token: tokenJson,
        cookieStr: serializeCookieMap(cookieMap),
        profile
    };
}

async function getValidTokenForOwner(owner) {
    const cleanPhone = displayMsisdn(owner.phone);
    const cached = ownerTokenCache.get(cleanPhone);
    const now = Math.floor(Date.now() / 1000);

    if (cached && cached.token && cached.token.access_token) {
        try {
            const parts = cached.token.access_token.split('.');
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            if (payload.exp && payload.exp - now > 120) {
                return { token: cached.token.access_token, cookieStr: cached.cookieStr, tokenObj: cached.token };
            }
        } catch (_) {}
    }

    if (!owner.password) {
        throw new Error('يرجى إعادة إدخال كلمة سر الأونر لتجديد الجلسة');
    }

    const res = await authenticateVodafoneOwner(owner.phone, owner.password);
    if (!res.success) {
        throw new Error(res.message);
    }

    ownerTokenCache.set(cleanPhone, {
        token: res.token,
        cookieStr: res.cookieStr,
        profile: res.profile
    });

    return { token: res.token.access_token, cookieStr: res.cookieStr, tokenObj: res.token };
}

async function callVodafoneForOwner(owner, url, method = 'GET', body = null) {
    let { token, cookieStr } = await getValidTokenForOwner(owner);

    const headers = {
        'Authorization': `Bearer ${token}`,
        'clientId': 'WebsiteConsumer',
        'msisdn': displayMsisdn(owner.phone),
        'Accept-Language': 'AR',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Referer': 'https://web.vodafone.com.eg/spa/myHome',
        'User-Agent': BROWSER_UA
    };

    if (cookieStr) headers['Cookie'] = cookieStr;

    const fetchOpts = { method, headers };
    if (body && method !== 'GET') {
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let resp = await fetch(url, fetchOpts);
    let text = await resp.text();

    if ((resp.status === 401 || resp.status === 403) && owner.password) {
        console.log(`[AUTH] Session expired (${resp.status}) for owner ${owner.phone}. Re-authenticating...`);
        try {
            ownerTokenCache.delete(displayMsisdn(owner.phone));
            const authRes = await authenticateVodafoneOwner(owner.phone, owner.password);
            if (authRes && authRes.success && authRes.token) {
                ownerTokenCache.set(displayMsisdn(owner.phone), {
                    token: authRes.token,
                    cookieStr: authRes.cookieStr,
                    profile: authRes.profile
                });
                headers['Authorization'] = `Bearer ${authRes.token.access_token}`;
                if (authRes.cookieStr) headers['Cookie'] = authRes.cookieStr;
                resp = await fetch(url, fetchOpts);
                text = await resp.text();
            }
        } catch (retryErr) {
            console.warn('[AUTH] Silent re-auth error:', retryErr.message);
        }
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        parsed = { raw: text };
    }

    return { data: parsed, status: resp.status, ok: resp.ok };
}

function extractVodafoneError(respData, status) {
    if (!respData) return null;
    let raw = "";
    if (typeof respData === "string") raw = respData;
    else if (respData.message) raw = respData.message;
    else if (respData.description) raw = respData.description;
    else if (respData.error_description) raw = respData.error_description;
    else if (respData.error) raw = typeof respData.error === "string" ? respData.error : JSON.stringify(respData.error);
    else if (respData.raw) raw = respData.raw;

    if (!raw && respData.errors && Array.isArray(respData.errors) && respData.errors[0]) {
        raw = respData.errors[0].message || respData.errors[0].description || "";
    }

    if (!raw && (status < 200 || status >= 300)) {
        raw = `فشل الطلب مع كود ${status}`;
    }

    if (!raw) return null;

    const lower = raw.toLowerCase();
    if (lower.includes("different billing accounts")) {
        return "رقم الفرد يتبع حساب فواتير مختلف ولا يمكن ضمه لنفس باقة العائلة";
    }
    if (lower.includes("rate limit exceeded") || lower.includes("too many requests")) {
        return "تم تجاوز حد الطلبات في فودافون مؤقتاً، يرجى الانتظار نصف دقيقة والمحاولة ثانية";
    }
    if (lower.includes("already a member") || lower.includes("already exists") || lower.includes("duplicate")) {
        return "هذا الرقم مضاف بالفعل أو لديه دعوة قائمة في باقة العائلة";
    }
    if (lower.includes("not eligible") || lower.includes("ineligible")) {
        return "الرقم غير مؤهل للانضمام لباقة العائلة (تأكد أن الخط فودافون وشغال)";
    }
    if (lower.includes("insufficient") || lower.includes("quota")) {
        return "حصة الباقة المتبقية لدى الأونر غير كافية لإضافة هذا الفرد";
    }
    return raw;
}

async function acceptVodafoneFamilyInvitation(memberObj, ownerPhone, memberPhone, planName) {
    const cleanOwner = displayMsisdn(ownerPhone);
    const cleanMember = displayMsisdn(memberPhone);
    const formattedOwner = `20${cleanOwner.replace(/^0/, '')}`;
    const formattedMember = `20${cleanMember.replace(/^0/, '')}`;

    let roleName = "EnterpriseRedFamily";
    if (planName && planName.toLowerCase().includes("flex")) {
        roleName = "FlexFamily";
    }

    const groupCategory = [
        { value: "8805", listHierarchyId: "TierID" },
        { value: "8805", listHierarchyId: "PackageID" },
        { value: "880", listHierarchyId: "TemplateID" }
    ];

    const primaryPayload = {
        name: roleName,
        type: "FamilyAcceptInvitation",
        category: groupCategory,
        parts: {
            member: [
                { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
            ]
        }
    };

    console.log(`[ACCEPT_INVITE] Member ${cleanMember} accepting invite from owner ${cleanOwner}...`);
    try {
        const accRes = await callVodafoneForOwner(
            memberObj,
            "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup",
            "POST",
            primaryPayload
        );

        const err = extractVodafoneError(accRes.data, accRes.status);
        if ((accRes.ok || accRes.status === 200 || accRes.status === 201) && !err) {
            console.log(`[ACCEPT_INVITE] Successfully accepted via FamilyAcceptInvitation!`);
            return { accepted: true, lastErr: '' };
        }

        if (err && err.includes('تجاوز حد الطلبات')) {
            return { accepted: false, lastErr: err };
        }

        console.log(`[ACCEPT_INVITE] Primary attempt error: ${err}. Waiting 1200ms before fallback...`);
        await new Promise(r => setTimeout(r, 1200));

        const fallbackPayload = {
            name: roleName,
            type: "AcceptInvitation",
            category: groupCategory,
            parts: {
                member: [
                    { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                    { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
                ]
            }
        };

        const fbRes = await callVodafoneForOwner(
            memberObj,
            "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup",
            "POST",
            fallbackPayload
        );

        const fbErr = extractVodafoneError(fbRes.data, fbRes.status);
        if ((fbRes.ok || fbRes.status === 200 || fbRes.status === 201) && !fbErr) {
            console.log(`[ACCEPT_INVITE] Successfully accepted via fallback AcceptInvitation!`);
            return { accepted: true, lastErr: '' };
        }

        return { accepted: false, lastErr: fbErr || err || `كود ${accRes.status}` };
    } catch (callErr) {
        return { accepted: false, lastErr: callErr.message };
    }
}

async function sendVodafoneFamilyInvitation(owner, memberPhone, quotaGB, minutes, sms) {
    const cleanMemberPhone = displayMsisdn(memberPhone);
    const cleanOwnerPhone = displayMsisdn(owner.phone);
    const formattedMember = `20${cleanMemberPhone.replace(/^0/, '')}`;
    const formattedOwner = `20${cleanOwnerPhone.replace(/^0/, '')}`;

    try {
        const cgUrl = "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup?type=Family&$.parts.member.type=owner";
        const cgRes = await callVodafoneForOwner(owner, cgUrl);
        const fg = Array.isArray(cgRes.data) ? cgRes.data[0] : cgRes.data;
        const currentMembers = fg?.parts?.member || [];
        const existingMember = currentMembers.find(m => {
            const val = displayMsisdn(m.id?.[0]?.value || '');
            return val === cleanMemberPhone;
        });
        if (existingMember && existingMember.status === '1') {
            return {
                success: false,
                error: `الرقم ${cleanMemberPhone} مضاف بالفعل كعضو نشط في باقة عائلة فودافون!`
            };
        }
    } catch (_) {}

    const miMB = (Number(quotaGB) || 20) * 1024;
    const voiceMinutes = Number(minutes) || 1500;

    let roleName = "EnterpriseRedFamily";
    if (owner.plan && owner.plan.toLowerCase().includes("flex")) {
        roleName = "FlexFamily";
    }

    const payload = {
        name: roleName,
        type: "SendInvitation",
        category: [
            { value: "8805", listHierarchyId: "TierID" },
            { value: "8805", listHierarchyId: "PackageID" },
            { value: "880", listHierarchyId: "TemplateID" }
        ],
        parts: {
            member: [
                { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
            ],
            characteristicsValue: {
                characteristicsValue: [
                    { characteristicName: "MI", value: String(miMB) },
                    { characteristicName: "Voice", value: String(voiceMinutes) }
                ]
            }
        }
    };

    console.log(`[ADD_MEMBER] Dispatching Vodafone DXL invitation to ${cleanMemberPhone}...`);
    const resp = await callVodafoneForOwner(
        owner,
        "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup",
        "POST",
        payload
    );

    const err = extractVodafoneError(resp.data, resp.status);
    if ((resp.ok || resp.status === 200 || resp.status === 201) && !err) {
        return { success: true, result: resp.data };
    }
    return { success: false, error: err || `فشل إرسال الدعوة بكود ${resp.status}` };
}

async function removeVodafoneFamilyMember(owner, memberPhone) {
    const cleanMemberPhone = displayMsisdn(memberPhone);
    const cleanOwnerPhone = displayMsisdn(owner.phone);
    const formattedMember = `20${cleanMemberPhone.replace(/^0/, '')}`;
    const formattedOwner = `20${cleanOwnerPhone.replace(/^0/, '')}`;

    let roleName = "EnterpriseRedFamily";
    if (owner.plan && owner.plan.toLowerCase().includes("flex")) {
        roleName = "FlexFamily";
    }

    const payload = {
        name: roleName,
        type: "FamilyRemoveMember",
        category: [{ value: "880", listHierarchyId: "TemplateID" }],
        parts: {
            member: [
                { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
            ],
            characteristicsValue: {
                characteristicsValue: [
                    { characteristicName: "Disconnect", value: "0" },
                    { characteristicName: "LastMemberDeletion", value: "1" }
                ]
            }
        }
    };

    console.log(`[REMOVE_MEMBER] Owner ${cleanOwnerPhone} removing member ${cleanMemberPhone} from Vodafone...`);
    const resp = await callVodafoneForOwner(
        owner,
        "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup",
        "POST",
        payload
    );

    const err = extractVodafoneError(resp.data, resp.status);
    if (!resp.ok && resp.status !== 200 && resp.status !== 201 && err) {
        if (/not found|لا توجد|already|غير موجود/i.test(err)) {
            return { success: true, alreadyRemoved: true };
        }
        return { success: false, error: err };
    }
    return { success: true, result: resp.data };
}

async function updateOwnerNameOnVodafone(owner, newName) {
    if (!owner || !owner.phone || !owner.password) return { success: false, error: 'بيانات الأونر غير مكتملة' };
    const cleanName = String(newName || '').trim();
    if (!cleanName) return { success: false, error: 'الاسم مطلوب' };

    const nameParts = cleanName.split(/\s+/);
    const firstName = nameParts[0] || cleanName;
    const lastName = nameParts.slice(1).join(' ') || '.';

    let vfUpdated = false;

    // 1. Try Keycloak account update
    try {
        const keycloakUrl = "https://web.vodafone.com.eg/auth/realms/vf-realm/account";
        const kcRes = await callVodafoneForOwner(owner, keycloakUrl, "POST", {
            firstName: firstName,
            lastName: lastName,
            email: `${displayMsisdn(owner.phone)}@vodafone.com.eg`
        });
        if (kcRes.ok || kcRes.status === 200 || kcRes.status === 204) {
            vfUpdated = true;
        }
    } catch (_) {}

    // 2. Try DXL party individual update
    if (!vfUpdated) {
        try {
            const dxlPartyUrl = "https://web.vodafone.com.eg/services/dxl/party/individual";
            const partyRes = await callVodafoneForOwner(owner, dxlPartyUrl, "PATCH", {
                givenName: firstName,
                familyName: lastName,
                formattedName: cleanName
            });
            if (partyRes.ok || partyRes.status === 200 || partyRes.status === 204) {
                vfUpdated = true;
            }
        } catch (_) {}
    }

    // 3. Try DXL userProfile update
    if (!vfUpdated) {
        try {
            const dxlProfileUrl = "https://web.vodafone.com.eg/services/dxl/profile/userProfile";
            const profRes = await callVodafoneForOwner(owner, dxlProfileUrl, "PATCH", {
                firstName: firstName,
                lastName: lastName,
                fullName: cleanName
            });
            if (profRes.ok || profRes.status === 200 || profRes.status === 204) {
                vfUpdated = true;
            }
        } catch (_) {}
    }

    return { success: true, vfUpdated };
}

async function changeVodafoneOwnerPassword(owner, oldPassword, newPassword) {
    if (!owner || !owner.phone) {
        return { success: false, error: 'بيانات الأونر غير موجودة' };
    }
    const cleanPhone = displayMsisdn(owner.phone);
    const oldPass = String(oldPassword || owner.password || '').trim();
    const newPass = String(newPassword || '').trim();

    if (!newPass) {
        return { success: false, error: 'كلمة المرور الجديدة مطلوبة' };
    }

    if (oldPass === newPass) {
        return { success: false, error: 'كلمة المرور الجديدة مطابقة لكلمة المرور الحالية' };
    }

    // 1. Check if new password already works on Vodafone
    try {
        const checkNew = await fastVodafoneCheck(cleanPhone, newPass);
        if (checkNew.valid) {
            return { success: true, message: 'كلمة المرور تعمل بالفعل على فودافون', alreadyActive: true };
        }
    } catch (_) {}

    // 2. Authenticate with current password to get fresh session & access token
    let authRes = null;
    try {
        authRes = await authenticateVodafoneOwner(cleanPhone, oldPass);
    } catch (e) {
        return { success: false, error: `فشل تسجيل الدخول بالباسورد الحالي: ${e.message}` };
    }

    if (!authRes || !authRes.success || !authRes.token || !authRes.token.access_token) {
        return { success: false, error: authRes?.message || 'فشل تسجيل الدخول بكلمة المرور الحالية لدى فودافون' };
    }

    const accessToken = authRes.token.access_token;
    const cookieStr = authRes.cookieStr;

    // 3. Dispatch PATCH to Vodafone DXL serviceAccountManagement endpoint
    const dxlUrl = "https://web.vodafone.com.eg/services/dxl/sam/serviceAccountManagement/v1/serviceAccount";
    const body = {
        "@type": "userPrefsUpdate",
        customerAccount: {
            authentication: {
                password: oldPass,
                newPassword: newPass
            }
        },
        resources: [
            {
                resourceType: "MSISDN",
                IDs: [{ value: cleanPhone }]
            }
        ]
    };

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'clientId': 'WebsiteConsumer',
        'msisdn': cleanPhone,
        'Accept-Language': 'AR',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Referer': 'https://web.vodafone.com.eg/spa/myHome',
        'Origin': 'https://web.vodafone.com.eg',
        'User-Agent': BROWSER_UA
    };
    if (cookieStr) headers['Cookie'] = cookieStr;

    let patchRes;
    try {
        patchRes = await fetch(dxlUrl, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body)
        });
    } catch (e) {
        return { success: false, error: `فشل الاتصال بسيرفر فودافون: ${e.message}` };
    }

    let respText = '';
    try { respText = await patchRes.text(); } catch (_) {}
    let respJson = null;
    try { respJson = JSON.parse(respText); } catch (_) {}

    if (patchRes.status === 200 || patchRes.status === 204) {
        ownerTokenCache.delete(cleanPhone);
        return { success: true, message: 'تم تغيير كلمة المرور على فودافون بنجاح 100%' };
    }

    // Parse Vodafone error
    let errorMsg = '';
    if (respJson) {
        if (respJson.code === "1042" || /repeated|used before/i.test(respJson.message || respJson.reason)) {
            errorMsg = 'فودافون: كلمة المرور هذه تم استخدامها من قبل، يرجى اختيار كلمة سر جديدة تماماً';
        } else if (/invalid.*password|authentication/i.test(respJson.message || respJson.reason)) {
            errorMsg = 'فودافون: كلمة المرور الحالية غير مطابقة للسجلات';
        } else {
            errorMsg = respJson.message || respJson.reason || respJson.description || `خطأ من فودافون (${respJson.code || patchRes.status})`;
        }
    } else {
        errorMsg = `فودافون رفضت التغيير (رمز الحالة ${patchRes.status})`;
    }

    return { success: false, error: errorMsg, raw: respText };
}

// ============================================ //
//  SUPER ADMIN NOTIFICATION & INVITATION SYNC  //
// ============================================ //

async function notifyAdminsOnTelegram(message, options = {}) {
    try {
        const botInstance = await getBot();
        if (!botInstance) return;
        const admins = await dbAll(`SELECT tg_id FROM bot_admins`).catch(() => []);
        const adminIds = new Set(['1255885099']);
        if (Array.isArray(admins)) {
            for (const a of admins) {
                if (a.tg_id) adminIds.add(String(a.tg_id).trim());
            }
        }
        for (const chatId of adminIds) {
            try {
                await botInstance.sendMessage(chatId, message, { parse_mode: 'Markdown', ...options });
            } catch (e) {
                console.warn(`Failed to notify admin ${chatId}:`, e.message);
            }
        }
    } catch (e) {
        console.error('Error in notifyAdminsOnTelegram:', e.message);
    }
}

async function onMemberInvitationAccepted(booking, owner, ownerName, gigabytes, renewalDay) {
    if (!booking || !booking.id) return;
    const cleanMemberPhone = displayMsisdn(booking.phone);
    const cleanOwnerPhone = displayMsisdn(owner?.phone || booking.owner_phone || '');
    const resolvedOwnerName = ownerName || owner?.name || booking.owner_name || 'الأونر';
    const resolvedGigs = gigabytes || booking.gigabytes || 20;
    const resolvedDay = renewalDay || booking.renewal_day || 7;

    console.log(`[INVITATION_ACCEPTED] Member ${cleanMemberPhone} accepted! Notifying Super Admin...`);

    // 1. Update DB booking status to 'متأكتف'
    try {
        await dbRun(
            `UPDATE bookings SET status = 'متأكتف', invitation_accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [booking.id]
        );
    } catch (e) {
        console.warn('Could not update booking status:', e.message);
    }

    // 2. Insert in admin_notifications
    try {
        const notifTitle = `🎉 قبول دعوة فودافون للرقم ${cleanMemberPhone}`;
        const notifMsg = `وافق العميل على الدعوة بنجاح وأصبح الخط مفعلاً في باقة العائلة للأونر ${resolvedOwnerName}. يرجى إبلاغ الفرد وإضافة كلمة المرور.`;
        const notifData = JSON.stringify({
            booking_id: booking.id,
            phone: cleanMemberPhone,
            owner_phone: cleanOwnerPhone,
            owner_name: resolvedOwnerName,
            gigabytes: resolvedGigs,
            renewal_day: resolvedDay
        });
        await dbRun(
            `INSERT INTO admin_notifications (type, title, message, data, created_at) VALUES ('invitation_accepted', ?, ?, ?, CURRENT_TIMESTAMP)`,
            [notifTitle, notifMsg, notifData]
        );
    } catch (e) {
        console.warn('Could not insert admin_notification:', e.message);
    }

    // 3. Send Telegram Notification to Super Admin and all bot admins
    try {
        const webAppUrl = (process.env.WEBAPP_URL || 'https://vodared.vercel.app').trim();
        const adminMsg = 
`🎉 *إشعار قبول دعوة فودافون ريد جديدة!*
━━━━━━━━━━━━━━━━━━
📱 *رقم الفرد:* \`${cleanMemberPhone}\`
👑 *الأونر التابع له:* *${resolvedOwnerName}* (\`${cleanOwnerPhone}\`)
📦 *كوتة الباقة:* *${resolvedGigs} GB*
📅 *يوم التجديد:* يوم *${resolvedDay}*

✅ *حالة الدعوة:* وافق العميل على الدعوة والخط أصبح *مفعلاً ونشطاً* في باقة العائلة.

💡 *المطلوب الآن:*
1️⃣ التواصل مع الفرد وإبلاغه بتفعيل باقته.
2️⃣ طلب كلمة سر تطبيق (أنا فودافون) الخاص به وإضافتها في النظام لتفعيل الاستهلاك ومتابعة التجديد.

📌 *يمكنك إضافة الباسورد فوراً من هنا:*
ارسل في الشات: \`/setpass ${cleanMemberPhone} الباسورد\`
أو اضغط على الزر بالأسفل لفتح لوحة التحكم:
━━━━━━━━━━━━━━━━━━`;

        const inlineKeyboard = {
            inline_keyboard: [
                [{ text: '🔑 إضافة باسورد الفرد في لوحة التحكم', web_app: { url: webAppUrl } }]
            ]
        };

        await notifyAdminsOnTelegram(adminMsg, { reply_markup: inlineKeyboard });
    } catch (tgErr) {
        console.warn('Error sending invitation accepted telegram notification:', tgErr.message);
    }
}

let isCheckingPendingInvitations = false;
let lastPendingCheckTime = 0;

async function checkPendingInvitations() {
    if (isCheckingPendingInvitations) return { skipped: true };
    const now = Date.now();
    if (now - lastPendingCheckTime < 25000) return { throttled: true };
    lastPendingCheckTime = now;
    isCheckingPendingInvitations = true;

    let acceptedCount = 0;
    try {
        const pendingBookings = await dbAll(
            `SELECT b.*, o.phone AS owner_phone_db, o.password AS owner_password_db, o.name AS owner_name_db
             FROM bookings b
             JOIN owners o ON (b.owner_id = o.id OR b.owner_phone = o.phone)
             WHERE b.status IN ('محجوز', 'معلق') AND b.deleted_at IS NULL`
        );

        if (!pendingBookings || pendingBookings.length === 0) {
            isCheckingPendingInvitations = false;
            return { checked: 0, accepted: 0 };
        }

        const ownerMap = new Map();
        for (const pb of pendingBookings) {
            const oPhone = pb.owner_phone || pb.owner_phone_db;
            if (!oPhone) continue;
            if (!ownerMap.has(oPhone)) {
                ownerMap.set(oPhone, {
                    owner: {
                        id: pb.owner_id,
                        phone: oPhone,
                        password: pb.owner_password_db,
                        name: pb.owner_name_db
                    },
                    bookings: []
                });
            }
            ownerMap.get(oPhone).bookings.push(pb);
        }

        for (const [ownerPhone, { owner, bookings }] of ownerMap.entries()) {
            if (!owner.password) continue;
            try {
                const vf = await fastVodafoneCheck(owner.phone, owner.password);
                if (!vf.valid || !vf.details) continue;

                const familyMembers = vf.details.familyMembers || [];
                for (const pb of bookings) {
                    const cleanPhone = displayMsisdn(pb.phone);
                    const vfMember = familyMembers.find(fm => displayMsisdn(fm.phone) === cleanPhone);
                    if (vfMember && vfMember.status === 'active') {
                        acceptedCount++;
                        await onMemberInvitationAccepted(
                            pb,
                            owner,
                            vf.details.name || owner.name,
                            vfMember.gigabytes || pb.gigabytes,
                            vf.details.renewal_day || pb.renewal_day
                        );
                    }
                }
            } catch (err) {
                console.warn(`[CHECK_PENDING] Error checking owner ${ownerPhone}:`, err.message);
            }
        }
    } catch (e) {
        console.error('[CHECK_PENDING] General error:', e.message);
    } finally {
        isCheckingPendingInvitations = false;
    }

    return { checked: true, accepted: acceptedCount };
}

async function redistributeMemberQuotaOnVodafone(owner, memberPhone, newGB) {
    if (!owner || !owner.phone || !owner.password) return { success: false, error: 'بيانات الأونر غير مكتملة' };
    const cleanMember = displayMsisdn(memberPhone);
    const cleanOwner = displayMsisdn(owner.phone);
    const formattedMember = `20${cleanMember.replace(/^0/, '')}`;
    const formattedOwner = `20${cleanOwner.replace(/^0/, '')}`;
    const miMB = (Number(newGB) || 20) * 1024;

    let roleName = "EnterpriseRedFamily";
    if (owner.plan && owner.plan.toLowerCase().includes("flex")) {
        roleName = "FlexFamily";
    }

    const payload = {
        name: roleName,
        type: "QuotaRedistribution",
        category: [{ value: "880", listHierarchyId: "TemplateID" }],
        parts: {
            member: [
                { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
            ],
            characteristic: {
                characteristicsValue: [
                    { characteristicName: "MI", value: String(miMB) },
                    { characteristicName: "Voice", value: "1500" },
                    { characteristicName: "SMS", value: "200" }
                ]
            }
        }
    };

    console.log(`[REDISTRIBUTE] Owner ${cleanOwner} redistributing ${cleanMember} to ${newGB} GB (${miMB} MB)...`);
    const resp = await callVodafoneForOwner(
        owner,
        "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup",
        "PATCH",
        payload
    );

    const err = extractVodafoneError(resp.data, resp.status);
    if ((resp.ok || resp.status === 200 || resp.status === 204) && !err) {
        return { success: true, result: resp.data };
    }
    return { success: false, error: err || `كود ${resp.status}` };
}

// 6. Add Member under Owner (With real Vodafone invitation & auto-activation)
async function handleAddMember(req, res) {
    try {
        let { owner_id, owner_phone, ownerPhone, memberPhone, memberMsisdn, phone, password, name, memberName, gigabytes, quotaGB, renewal_day, minutes, voice, sms, status } = req.body || {};
        
        phone = toEnglish(String(phone || memberPhone || memberMsisdn || '').trim().replace(/[\s-]/g, ''));
        if (!phone) return res.status(400).json({ success: false, error: 'رقم الفرد مطلوب' });
        
        password = password ? String(password).trim() : '';
        name = (name || memberName || '').trim();
        gigabytes = Number(gigabytes || quotaGB) || 20;
        minutes = Number(minutes || voice) || 1500;
        sms = Number(sms) || 200;
        renewal_day = Number(renewal_day) || 7;
        status = status || 'متأكتف';

        let resolvedOwnerId = owner_id ? Number(owner_id) : null;
        let resolvedOwnerPhone = (owner_phone || ownerPhone) ? toEnglish(String(owner_phone || ownerPhone).trim().replace(/[\s-]/g, '')) : null;

        let owner = null;
        if (resolvedOwnerId) {
            owner = await dbGet(`SELECT * FROM owners WHERE id = ?`, [resolvedOwnerId]);
            if (owner && !resolvedOwnerPhone) resolvedOwnerPhone = owner.phone;
        }
        if (!owner && resolvedOwnerPhone) {
            owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [resolvedOwnerPhone]);
            if (owner && !resolvedOwnerId) resolvedOwnerId = owner.id;
        }

        const cleanMemberPhone = displayMsisdn(phone);
        let autoAccepted = false;
        let verifiedName = name;

        // If owner exists and has password, communicate with Vodafone network!
        if (owner && owner.password) {
            let memberAuthRes = null;
            if (password) {
                console.log(`[ADD_MEMBER] Verifying member credentials with Vodafone for ${cleanMemberPhone}...`);
                memberAuthRes = await authenticateVodafoneOwner(cleanMemberPhone, password);
                if (!memberAuthRes.success) {
                    return res.status(400).json({
                        success: false,
                        error: `تعذر التحقق من باسورد الفرد في فودافون: ${memberAuthRes.message}`
                    });
                }
                if (!verifiedName && memberAuthRes.profile?.name && memberAuthRes.profile.name !== 'مالك فودافون') {
                    verifiedName = memberAuthRes.profile.name;
                }
            }

            // Send real Vodafone DXL Invitation
            const inviteRes = await sendVodafoneFamilyInvitation(owner, cleanMemberPhone, gigabytes, minutes, sms);
            if (!inviteRes.success) {
                return res.status(400).json({
                    success: false,
                    error: `رفضت شبكة فودافون إرسال الدعوة: ${inviteRes.error}`
                });
            }

            // If member credentials were verified, auto-accept invitation
            if (memberAuthRes && memberAuthRes.token?.access_token) {
                try {
                    console.log(`[AUTO_ACCEPT] Waiting 1500ms before accepting invitation for ${cleanMemberPhone}...`);
                    await new Promise(r => setTimeout(r, 1500));
                    const memberObj = {
                        phone: cleanMemberPhone,
                        password: password,
                        token: memberAuthRes.token,
                        cookieStr: memberAuthRes.cookieStr
                    };
                    const accRes = await acceptVodafoneFamilyInvitation(memberObj, owner.phone, cleanMemberPhone, owner.plan);
                    if (accRes.accepted) {
                        autoAccepted = true;
                        status = 'متأكتف';
                    }
                } catch (e) {
                    console.warn('[AUTO_ACCEPT] Error auto-accepting:', e.message);
                }
            } else {
                status = 'محجوز';
            }
        }

        // Save in DB
        const existing = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [cleanMemberPhone]);
        let bookingId;
        if (existing) {
            await dbRun(
                `UPDATE bookings SET owner_id = ?, owner_phone = ?, name = COALESCE(?, name), password = COALESCE(?, password), gigabytes = ?, renewal_day = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [resolvedOwnerId, resolvedOwnerPhone, verifiedName || null, password || null, gigabytes, renewal_day, status, existing.id]
            );
            bookingId = existing.id;
        } else {
            const result = await dbRun(
                `INSERT INTO bookings (owner_id, owner_phone, name, phone, password, gigabytes, renewal_day, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [resolvedOwnerId, resolvedOwnerPhone, verifiedName || `فرد (${cleanMemberPhone.slice(-4)})`, cleanMemberPhone, password || null, gigabytes, renewal_day, status]
            );
            bookingId = result.lastID;
        }

        const ym = currentMonth();
        await dbRun(
            `INSERT INTO monthly_payments (booking_id, renewal_day, year_month, paid, paid_at, activated, activated_at) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
            [bookingId, renewal_day, ym]
        );

        const member = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
        res.json({
            success: true,
            autoAccepted,
            message: autoAccepted
                ? 'تم إرسال الدعوة وتفعيل الفرد في باقة العائلة فورياً بنجاح! 🎉'
                : 'تم تسجيل الدعوة بسيرفرات فودافون بنجاح! يمكن للفرد قبولها فوراً بطلب *41# أو من تطبيق أنا فودافون. 📨',
            data: member
        });
    } catch (e) {
        console.error('handleAddMember error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
}

app.post('/api/members', handleAddMember);
app.post('/api/family/add-member', handleAddMember);

// 7. Update Member Password (with live Vodafone verification)
app.put('/api/members/:id/password', async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        if (!password) return res.status(400).json({ success: false, error: 'كلمة المرور مطلوبة' });

        const member = await dbGet(`SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`, [id]);
        if (!member) return res.status(404).json({ success: false, error: 'الفرد غير موجود' });

        const cleanPass = String(password).trim();
        const vf = await fastVodafoneCheck(member.phone, cleanPass);
        if (!vf.valid) {
            return res.status(400).json({ success: false, error: vf.message || 'الباسورد غير صحيح لدى فودافون ❌' });
        }

        let usageData = vf.details ? JSON.stringify(vf.details) : null;
        let memberName = vf.details?.name || null;
        await dbRun(
            `UPDATE bookings SET password = ?, name = COALESCE(?, name), last_usage_data = COALESCE(?, last_usage_data), last_usage_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [cleanPass, memberName, usageData, id]
        );

        const updated = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [id]);
        res.json({ success: true, message: 'تم التحقق من باسورد الفرد وحفظه بنجاح ✅', data: updated });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8. Delete Member (With real Vodafone DXL removal & quota return)
async function handleDeleteMember(req, res) {
    try {
        const id = req.params?.id || req.body?.id || req.body?.memberId;
        let memberPhone = req.body?.memberPhone || req.body?.memberMsisdn || req.body?.phone;
        let ownerPhone = req.body?.ownerPhone;

        let member = null;
        if (id) {
            member = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [id]);
        }
        if (!member && memberPhone) {
            const clean = displayMsisdn(memberPhone);
            member = await dbGet(`SELECT * FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [clean]);
        }

        if (member) {
            memberPhone = member.phone;
            if (!ownerPhone && member.owner_phone) ownerPhone = member.owner_phone;
            if (!ownerPhone && member.owner_id) {
                const o = await dbGet(`SELECT phone FROM owners WHERE id = ?`, [member.owner_id]);
                if (o) ownerPhone = o.phone;
            }
        }

        if (!member && !memberPhone) {
            return res.status(404).json({ success: false, error: 'الفرد غير موجود' });
        }

        // If owner exists, perform real removal on Vodafone DXL network!
        let owner = null;
        if (ownerPhone) {
            owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [displayMsisdn(ownerPhone)]);
        }

        if (owner && owner.password) {
            const remRes = await removeVodafoneFamilyMember(owner, memberPhone);
            if (!remRes.success) {
                return res.status(400).json({
                    success: false,
                    error: `رفضت شبكة فودافون إزالة العضو: ${remRes.error}`
                });
            }
        }

        // Remove from DB
        if (member) {
            await dbRun(`DELETE FROM bookings WHERE id = ?`, [member.id]);
        } else if (memberPhone) {
            await dbRun(`DELETE FROM bookings WHERE phone = ?`, [displayMsisdn(memberPhone)]);
        }

        res.json({
            success: true,
            message: `تمت إزالة العضو ${memberPhone} رسمياً من شبكة فودافون واسترجاع حصصه للأونر بنجاح! 🗑️`
        });
    } catch (e) {
        console.error('handleDeleteMember error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
}

app.delete('/api/members/:id', handleDeleteMember);
app.post('/api/family/remove-member', handleDeleteMember);
app.post('/api/family/cancel-invite', handleDeleteMember);

// 8a-1. Modify Member Next-Month Quota (إعادة تقسيم الباقة للشهر القادم)
app.post('/api/members/:id/next-quota', async (req, res) => {
    try {
        const { id } = req.params;
        const { next_gigabytes, notes, applyNow, apply_now } = req.body || {};
        const isApplyNow = Boolean(applyNow || apply_now);
        const member = await dbGet(`SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`, [id]);
        if (!member) return res.status(404).json({ success: false, error: 'الفرد غير موجود' });

        const owner = await dbGet(`SELECT * FROM owners WHERE id = ? OR phone = ?`, [member.owner_id, member.owner_phone]);

        if (next_gigabytes === null || next_gigabytes === undefined || next_gigabytes === '' || Number(next_gigabytes) <= 0) {
            // Cancel upcoming quota change and stay with current quota
            await dbRun(`UPDATE bookings SET next_gigabytes = NULL, next_quota_notes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
            return res.json({
                success: true,
                message: `تم إلغاء تغيير كوتة الشهر القادم للفرد ${member.phone} والعودة للكوتة الأصلية (${member.gigabytes} GB) بنجاح ✅`,
                data: { id, gigabytes: member.gigabytes, next_gigabytes: null }
            });
        }

        const newGB = Number(next_gigabytes);
        if (isNaN(newGB) || newGB <= 0) {
            return res.status(400).json({ success: false, error: 'قيمة الجيجات للشهر القادم غير صحيحة' });
        }

        // Validate that owner's total package quota can accommodate this
        if (owner) {
            const otherMembers = await dbAll(
                `SELECT id, gigabytes, next_gigabytes FROM bookings WHERE (owner_id = ? OR owner_phone = ?) AND id != ? AND deleted_at IS NULL`,
                [owner.id, owner.phone, id]
            );
            const otherAssignedNext = otherMembers.reduce((sum, m) => sum + Number(m.next_gigabytes || m.gigabytes || 0), 0);
            let maxOwnerGB = Number(owner.total_gigabytes) || 0;
            if (maxOwnerGB === 200 || (maxOwnerGB >= 195 && maxOwnerGB <= 205) || (!maxOwnerGB && String(owner.plan || '').includes('3000'))) {
                maxOwnerGB = 204.8;
            }
            if (!maxOwnerGB) maxOwnerGB = (otherAssignedNext + Number(member.gigabytes));
            if (otherAssignedNext + newGB > maxOwnerGB) {
                const rem = Math.max(0, maxOwnerGB - otherAssignedNext);
                return res.status(400).json({
                    success: false,
                    error: `باقة الأونر (${maxOwnerGB} GB) لا تكفي لتخصيص ${newGB} GB. الحد الأقصى المتاح لهذا الفرد للشهر القادم هو ${rem} GB.`
                });
            }
        }

        if (isApplyNow) {
            // Immediately apply to active quota and push to Vodafone DXL
            await dbRun(
                `UPDATE bookings SET gigabytes = ?, next_gigabytes = NULL, next_quota_notes = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [newGB, id]
            );
            let vfNote = '';
            if (owner && owner.password) {
                const vfRes = await redistributeMemberQuotaOnVodafone(owner, member.phone, newGB);
                if (vfRes.success) vfNote = ' وتم تطبيق التقسيم الجديد على شبكة فودافون بنجاح';
            }
            return res.json({
                success: true,
                message: `تم تطبيق كوتة الباقة (${newGB} GB) فورياً${vfNote} ✅`,
                data: { id, gigabytes: newGB, next_gigabytes: null }
            });
        }

        // Schedule for next month
        await dbRun(
            `UPDATE bookings SET next_gigabytes = ?, next_quota_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [newGB, notes ? String(notes).trim() : null, id]
        );

        res.json({
            success: true,
            message: `تم تحديد كوتة الشهر القادم (${newGB} GB) بنجاح. ستُسحب من باقة الأونر وتنعكس في الفاتورة والتجديد القادم ✅`,
            data: { id, phone: member.phone, gigabytes: member.gigabytes, next_gigabytes: newGB }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8a-2. Update Owner Name (with real Vodafone network update & DB sync)
app.put('/api/owners/:id/name', async (req, res) => {
    try {
        const { id } = req.params;
        let { name, updateVodafone = true, syncVodafone } = req.body || {};
        if (typeof name === 'object' && name !== null) {
            if (name.syncVodafone !== undefined) updateVodafone = name.syncVodafone;
            if (name.updateVodafone !== undefined) updateVodafone = name.updateVodafone;
            name = name.name;
        }
        if (syncVodafone !== undefined) updateVodafone = syncVodafone;
        const cleanName = String(name || '').trim();
        if (!cleanName) return res.status(400).json({ success: false, error: 'الاسم الجديد مطلوب' });

        const owner = await dbGet(`SELECT * FROM owners WHERE id = ?`, [id]);
        if (!owner) return res.status(404).json({ success: false, error: 'الأونر غير موجود' });

        let vfStatus = null;
        if (updateVodafone !== false && owner.password) {
            vfStatus = await updateOwnerNameOnVodafone(owner, cleanName);
        }

        await dbRun(`UPDATE owners SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [cleanName, id]);
        await dbRun(`UPDATE bookings SET owner_name = ?, updated_at = CURRENT_TIMESTAMP WHERE (owner_id = ? OR owner_phone = ?)`, [cleanName, owner.id, owner.phone]);
        ownerTokenCache.delete(displayMsisdn(owner.phone));

        res.json({
            success: true,
            message: vfStatus?.vfUpdated 
                ? 'تم تحديث اسم الأونر على فودافون وفي قاعدة البيانات بنجاح ✅' 
                : 'تم حفظ وتحديث اسم الأونر في النظام وجميع الأرقام التابعة له بنجاح ✅',
            data: { id: owner.id, name: cleanName, vfUpdated: Boolean(vfStatus?.vfUpdated) }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8a-3. Package Prices Management (Super Admin)
app.get('/api/settings/package-prices', async (req, res) => {
    try {
        const prices = await getPackagePrices();
        res.json({ success: true, data: prices });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/settings/package-prices', async (req, res) => {
    try {
        const { prices } = req.body || {};
        if (!prices || typeof prices !== 'object') {
            return res.status(400).json({ success: false, error: 'قائمة الأسعار غير صحيحة' });
        }
        const cleanPrices = {};
        for (const [k, v] of Object.entries(prices)) {
            const numKey = parseInt(k, 10);
            const numVal = Number(v);
            if (!isNaN(numKey) && numKey > 0 && !isNaN(numVal) && numVal >= 0) {
                cleanPrices[numKey] = numVal;
            }
        }
        await dbRun(`INSERT INTO settings (key, value) VALUES ('package_prices', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(cleanPrices)]);
        packagePricesCache = cleanPrices;
        packagePricesCacheTime = Date.now();
        res.json({ success: true, message: 'تم حفظ وتحديث أسعار الباقات بنجاح ✅', data: cleanPrices });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8a-4. Trigger Telegram Renewal Reminders (3 days before renewal + unpaid check)
app.post('/api/admin/send-renewal-reminders', async (req, res) => {
    try {
        const result = (await sendDailyRenewalReminders()) || { sent: 0, skippedPaid: 0, sentList: [] };
        const sent = Number(result?.sent) || 0;
        const skippedPaid = Number(result?.skippedPaid) || 0;
        const sentList = Array.isArray(result?.sentList) ? result.sentList : [];
        res.json({
            success: true,
            message: `تم إرسال ${sent} تذكيرات تجديد بنجاح عبر تليجرام 🔔 (تخطي ${skippedPaid} أرقام مسددة بالفعل)`,
            sent,
            skippedPaid,
            sentList,
            data: {
                sent,
                skippedPaid,
                sentList
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message || 'فشل إرسال التذكيرات' });
    }
});

// 8b. Accept family invitation using member password
app.post('/api/family/accept-invite', async (req, res) => {
    try {
        const { ownerPhone, memberPhone, phone, password } = req.body || {};
        const cleanMember = displayMsisdn(memberPhone || phone);
        const pass = String(password || '').trim();

        if (!cleanMember || !pass) {
            return res.status(400).json({ success: false, error: 'رقم الفرد وكلمة المرور مطلوبان' });
        }

        let resolvedOwner = null;
        if (ownerPhone) {
            resolvedOwner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [displayMsisdn(ownerPhone)]);
        }
        if (!resolvedOwner) {
            const b = await dbGet(`SELECT owner_phone, owner_id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [cleanMember]);
            if (b && b.owner_phone) resolvedOwner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [b.owner_phone]);
            else if (b && b.owner_id) resolvedOwner = await dbGet(`SELECT * FROM owners WHERE id = ?`, [b.owner_id]);
        }

        if (!resolvedOwner) {
            return res.status(400).json({ success: false, error: 'تعذر تحديد الأونر المرتبط بهذا الفرد' });
        }

        const authRes = await authenticateVodafoneOwner(cleanMember, pass);
        if (!authRes.success) {
            return res.status(400).json({ success: false, error: `فشل التحقق من باسورد الفرد في فودافون: ${authRes.message}` });
        }

        const memberObj = {
            phone: cleanMember,
            password: pass,
            token: authRes.token,
            cookieStr: authRes.cookieStr
        };

        const accRes = await acceptVodafoneFamilyInvitation(memberObj, resolvedOwner.phone, cleanMember, resolvedOwner.plan);
        if (!accRes.accepted) {
            return res.status(400).json({ success: false, error: `رفضت فودافون قبول الدعوة: ${accRes.lastErr}` });
        }

        await dbRun(`UPDATE bookings SET status = 'متأكتف', password = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`, [pass, cleanMember]);

        res.json({ success: true, message: 'تم قبول الدعوة وتفعيل الفرد في باقة العائلة بنجاح! 🎉' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8c. Live Sync Family Group from Vodafone into DB
app.post('/api/family/sync-live', async (req, res) => {
    try {
        const { ownerId, ownerPhone } = req.body || {};
        let owner = null;
        if (ownerId) owner = await dbGet(`SELECT * FROM owners WHERE id = ?`, [ownerId]);
        if (!owner && ownerPhone) owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [displayMsisdn(ownerPhone)]);
        if (!owner) {
            return res.status(400).json({ success: false, error: 'الأونر غير موجود' });
        }

        const vf = await fastVodafoneCheck(owner.phone, owner.password);
        if (!vf.valid) {
            const errMsg = vf.message || 'الباسورد غير صحيح لدى فودافون ❌';
            await dbRun(
                `UPDATE owners SET password_valid = FALSE, password_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [errMsg, owner.id]
            );
            return res.status(400).json({ success: false, error: errMsg });
        }

        const vfData = vf.details || {};
        const resolvedName = vfData.name || owner.name;
        const resolvedPlan = vfData.currentPlan || owner.plan;
        const resolvedRenewalDay = vfData.renewal_day || owner.renewal_day;
        let resolvedTotalGB = vfData.total_gigabytes || owner.total_gigabytes;
        resolvedTotalGB = Number(resolvedTotalGB) || 0;
        if (resolvedTotalGB === 200 || (resolvedTotalGB >= 195 && resolvedTotalGB <= 205) || (!resolvedTotalGB && String(resolvedPlan || owner.plan || '').includes('3000'))) {
            resolvedTotalGB = 204.8;
        }

        await dbRun(
            `UPDATE owners SET name = ?, plan = ?, renewal_day = ?, total_gigabytes = ?, password_valid = TRUE, password_error = NULL, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [resolvedName, resolvedPlan, resolvedRenewalDay, resolvedTotalGB, owner.id]
        );

        // Update owner_name on all bookings belonging to this owner
        await dbRun(
            `UPDATE bookings SET owner_name = ?, updated_at = CURRENT_TIMESTAMP WHERE (owner_id = ? OR owner_phone = ?)`,
            [resolvedName, owner.id, owner.phone]
        );

        let syncedCount = 0;
        if (Array.isArray(vfData.familyMembers)) {
            for (const m of vfData.familyMembers) {
                if (!m.phone) continue;
                const mGigs = m.gigabytes || 20;
                const existing = await dbGet(`SELECT id, status, phone, gigabytes, renewal_day, name, owner_id, owner_phone FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [m.phone]);
                if (existing) {
                    const wasPending = (existing.status === 'محجوز' || existing.status === 'معلق');
                    await dbRun(
                        `UPDATE bookings SET owner_id = ?, owner_phone = ?, owner_name = ?, gigabytes = ?, renewal_day = ?, status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [owner.id, owner.phone, resolvedName, mGigs, resolvedRenewalDay, existing.id]
                    );
                    if (wasPending) {
                        await onMemberInvitationAccepted(existing, owner, resolvedName, mGigs, resolvedRenewalDay);
                    }
                } else {
                    await dbRun(
                        `INSERT INTO bookings (owner_id, owner_phone, owner_name, phone, gigabytes, renewal_day, status, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'متأكتف', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [owner.id, owner.phone, resolvedName, m.phone, mGigs, resolvedRenewalDay, `فرد (${m.phone.slice(-4)})`]
                    );
                }
                syncedCount++;
            }
        }

        // Also check passwords for this owner's members who have a password
        const ownerMembers = await dbAll(
            `SELECT id, phone, password FROM bookings WHERE (owner_id = ? OR owner_phone = ?) AND password IS NOT NULL AND TRIM(password) != '' AND deleted_at IS NULL`,
            [owner.id, owner.phone]
        );
        for (const m of ownerMembers) {
            try {
                const mvf = await fastVodafoneCheck(m.phone, m.password.trim());
                if (!mvf.valid) {
                    await dbRun(
                        `UPDATE bookings SET password_valid = FALSE, password_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [mvf.message || 'الباسورد خطأ ❌', m.id]
                    );
                } else {
                    let usageData = mvf.details ? JSON.stringify(mvf.details) : null;
                    let memberName = mvf.details?.name || null;
                    await dbRun(
                        `UPDATE bookings SET password_valid = TRUE, password_error = NULL, name = COALESCE(?, name), last_usage_data = COALESCE(?, last_usage_data), last_usage_at = CURRENT_TIMESTAMP, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [memberName, usageData, m.id]
                    );
                }
            } catch (_) {}
        }

        const updatedMembers = await dbAll(`SELECT * FROM bookings WHERE (owner_id = ? OR owner_phone = ?) AND deleted_at IS NULL ORDER BY id ASC`, [owner.id, owner.phone]);
        res.json({
            success: true,
            message: `تمت مزامنة ${syncedCount} أفراد وتحديث بيانات الأونر من فودافون بنجاح! 🔄`,
            data: {
                owner: await dbGet(`SELECT * FROM owners WHERE id = ?`, [owner.id]),
                members: updatedMembers
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8c-2. BATCH SYNC ALL OWNERS & MEMBERS FROM VODAFONE
app.post('/api/owners/sync-all', async (req, res) => {
    try {
        const owners = await dbAll(`SELECT * FROM owners ORDER BY id ASC`);
        if (!owners || owners.length === 0) {
            return res.json({ success: true, message: 'لا يوجد أونرز مسجلين للمزامنة', ownersCount: 0 });
        }

        let ownersSynced = 0;
        let ownersFailed = 0;
        let membersSynced = 0;
        let membersFailed = 0;
        const invalidNumbers = [];

        for (const owner of owners) {
            try {
                const vf = await fastVodafoneCheck(owner.phone, owner.password);
                if (!vf.valid) {
                    ownersFailed++;
                    const errMsg = vf.message || 'الباسورد خطأ ❌';
                    await dbRun(
                        `UPDATE owners SET password_valid = FALSE, password_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                        [errMsg, owner.id]
                    );
                    invalidNumbers.push({ phone: owner.phone, role: 'أونر', error: errMsg });
                    continue;
                }

                ownersSynced++;
                const vfData = vf.details || {};
                const resolvedName = vfData.name || owner.name;
                const resolvedPlan = vfData.currentPlan || owner.plan;
                const resolvedRenewalDay = vfData.renewal_day || owner.renewal_day;
                let resolvedTotalGB = vfData.total_gigabytes || owner.total_gigabytes;
                resolvedTotalGB = Number(resolvedTotalGB) || 0;
                if (resolvedTotalGB === 200 || (resolvedTotalGB >= 195 && resolvedTotalGB <= 205) || (!resolvedTotalGB && String(resolvedPlan || owner.plan || '').includes('3000'))) {
                    resolvedTotalGB = 204.8;
                }

                await dbRun(
                    `UPDATE owners SET name = ?, plan = ?, renewal_day = ?, total_gigabytes = ?, password_valid = TRUE, password_error = NULL, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [resolvedName, resolvedPlan, resolvedRenewalDay, resolvedTotalGB, owner.id]
                );

                // Update owner_name on all bookings linked to this owner
                await dbRun(
                    `UPDATE bookings SET owner_name = ?, updated_at = CURRENT_TIMESTAMP WHERE (owner_id = ? OR owner_phone = ?)`,
                    [resolvedName, owner.id, owner.phone]
                );

                // Sync family members returned from Vodafone
                if (Array.isArray(vfData.familyMembers)) {
                    for (const m of vfData.familyMembers) {
                        if (!m.phone) continue;
                        const mGigs = m.gigabytes || 20;
                        const existing = await dbGet(`SELECT id, status, phone, gigabytes, renewal_day, name, owner_id, owner_phone FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [m.phone]);
                        if (existing) {
                            const wasPending = (existing.status === 'محجوز' || existing.status === 'معلق');
                            await dbRun(
                                `UPDATE bookings SET owner_id = ?, owner_phone = ?, owner_name = ?, gigabytes = ?, renewal_day = ?, status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [owner.id, owner.phone, resolvedName, mGigs, resolvedRenewalDay, existing.id]
                            );
                            if (wasPending) {
                                await onMemberInvitationAccepted(existing, owner, resolvedName, mGigs, resolvedRenewalDay);
                            }
                        } else {
                            await dbRun(
                                `INSERT INTO bookings (owner_id, owner_phone, owner_name, phone, gigabytes, renewal_day, status, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'متأكتف', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                                [owner.id, owner.phone, resolvedName, m.phone, mGigs, resolvedRenewalDay, `فرد (${m.phone.slice(-4)})`]
                            );
                        }
                    }
                }

                // Check passwords for members of this owner who have a password
                const members = await dbAll(
                    `SELECT id, phone, password FROM bookings WHERE (owner_id = ? OR owner_phone = ?) AND password IS NOT NULL AND TRIM(password) != '' AND deleted_at IS NULL`,
                    [owner.id, owner.phone]
                );

                for (const member of members) {
                    try {
                        const mvf = await fastVodafoneCheck(member.phone, member.password.trim());
                        if (!mvf.valid) {
                            membersFailed++;
                            const mErr = mvf.message || 'الباسورد خطأ ❌';
                            await dbRun(
                                `UPDATE bookings SET password_valid = FALSE, password_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [mErr, member.id]
                            );
                            invalidNumbers.push({ phone: member.phone, role: 'فرد', error: mErr });
                        } else {
                            membersSynced++;
                            let usageData = mvf.details ? JSON.stringify(mvf.details) : null;
                            let memberName = mvf.details?.name || null;
                            await dbRun(
                                `UPDATE bookings SET password_valid = TRUE, password_error = NULL, name = COALESCE(?, name), last_usage_data = COALESCE(?, last_usage_data), last_usage_at = CURRENT_TIMESTAMP, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                                [memberName, usageData, member.id]
                            );
                        }
                    } catch (mErr) {
                        membersFailed++;
                        await dbRun(
                            `UPDATE bookings SET password_valid = FALSE, password_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [mErr.message, member.id]
                        );
                        invalidNumbers.push({ phone: member.phone, role: 'فرد', error: mErr.message });
                    }
                }
            } catch (oErr) {
                ownersFailed++;
                await dbRun(
                    `UPDATE owners SET password_valid = FALSE, password_error = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [oErr.message, owner.id]
                );
                invalidNumbers.push({ phone: owner.phone, role: 'أونر', error: oErr.message });
            }
        }

        const msgParts = [];
        if (ownersSynced > 0) msgParts.push(`تم تحديث ${ownersSynced} أونر بنجاح 👑`);
        if (membersSynced > 0) msgParts.push(`وتحديث ${membersSynced} فرد 📱`);
        if (ownersFailed > 0 || membersFailed > 0) {
            msgParts.push(`⚠️ تنبيه: تم اكتشاف ${ownersFailed + membersFailed} أرقام بها الباسورد غلط ❌`);
        }

        res.json({
            success: true,
            message: msgParts.join(' | ') || 'تمت مزامنة الكل بنجاح 🔄',
            summary: { ownersSynced, ownersFailed, membersSynced, membersFailed },
            invalidNumbers: invalidNumbers.length > 0 ? invalidNumbers : undefined
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8d. GET /api/family - Live Family Details (Compatible with Owner Red UI)
app.get('/api/family', async (req, res) => {
    try {
        let ownerPhone = req.query.owner || req.headers['x-owner-phone'];
        let owner = null;
        if (ownerPhone) {
            owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [displayMsisdn(ownerPhone)]);
        }
        if (!owner) {
            owner = await dbGet(`SELECT * FROM owners ORDER BY id ASC LIMIT 1`);
        }
        if (!owner) {
            return res.status(404).json({ success: false, error: 'لا يوجد أونر مسجل' });
        }

        const members = await dbAll(`SELECT * FROM bookings WHERE (owner_id = ? OR owner_phone = ?) AND deleted_at IS NULL ORDER BY id ASC`, [owner.id, owner.phone]);
        const assignedGigs = members.reduce((sum, m) => sum + (Number(m.gigabytes) || 0), 0);
        let totalGigs = Number(owner.total_gigabytes) || 0;
        if (totalGigs === 200 || (totalGigs >= 195 && totalGigs <= 205) || (!totalGigs && String(owner.plan || '').includes('3000'))) {
            totalGigs = 204.8;
        }
        if (!totalGigs) totalGigs = (assignedGigs + 100);

        res.json({
            success: true,
            owner: {
                id: owner.phone,
                name: owner.name || 'أونر فودافون',
                msisdn: owner.phone,
                phone: owner.phone,
                ratePlan: owner.plan || 'Vodafone RED',
                planName: owner.plan || 'Vodafone RED',
                billingAccount: 'N/A',
                billCycleDate: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(owner.renewal_day || 7).padStart(2, '0')}`,
                renewalDay: owner.renewal_day || 7,
                totalGB: totalGigs,
                allocatedGB: assignedGigs,
                freeGB: Math.max(0, totalGigs - assignedGigs),
                activeMembers: members.length,
                maxMembers: 7,
                loyaltyPoints: 0,
                loyaltyCash: 0
            },
            members: members.map(m => ({
                id: m.phone,
                msisdn: m.phone,
                phone: m.phone,
                name: m.name || `فرد ${m.phone.slice(-4)}`,
                ownerId: owner.phone,
                type: 'Member',
                status: m.status === 'متأكتف' ? 'Active' : 'Pending',
                isPending: m.status !== 'متأكتف',
                allocatedMI: (Number(m.gigabytes) || 20) * 1024,
                allocatedVoice: 1500,
                allocatedSMS: 200,
                allocatedGB: Number(m.gigabytes) || 20,
                quotaGB: Number(m.gigabytes) || 20,
                extraGB: 0,
                hasPassword: Boolean(m.password && m.password.trim())
            }))
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8e. Modify Base Quota (Redistribute)
app.post('/api/family/redistribute', async (req, res) => {
    try {
        const { ownerPhone, targetMemberPhone, memberPhone, memberMsisdn, mi, voice, sms } = req.body || {};
        const cleanMember = displayMsisdn(memberPhone || memberMsisdn || targetMemberPhone);
        const cleanOwner = displayMsisdn(ownerPhone);

        let owner = null;
        if (cleanOwner) owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [cleanOwner]);
        if (!owner) owner = await dbGet(`SELECT * FROM owners ORDER BY id ASC LIMIT 1`);

        if (owner && owner.password) {
            const formattedMember = `20${cleanMember.replace(/^0/, '')}`;
            const formattedOwner = `20${owner.phone.replace(/^0/, '')}`;
            const payload = {
                name: "EnterpriseRed",
                type: "QuotaRedistribution",
                category: [{ value: "880", listHierarchyId: "TemplateID" }],
                parts: {
                    member: [
                        { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                        { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
                    ],
                    characteristic: {
                        characteristicsValue: [
                            { characteristicName: "MI", value: String(mi || 20480) },
                            { characteristicName: "Voice", value: String(voice || "1500") },
                            { characteristicName: "SMS", value: String(sms || "200") }
                        ]
                    }
                }
            };
            await callVodafoneForOwner(owner, "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup", "PATCH", payload);
        }

        if (mi) {
            const gigs = Math.round(Number(mi) / 1024);
            await dbRun(`UPDATE bookings SET gigabytes = ? WHERE phone = ?`, [gigs, cleanMember]);
        }

        res.json({ success: true, message: 'تم تحديث توزيع الباقة بنجاح ✅' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8f. Add extra GB quota
app.post('/api/members/add-extra-quota', async (req, res) => {
    try {
        const { ownerPhone, memberPhone, extraGb } = req.body || {};
        const cleanMember = displayMsisdn(memberPhone);
        const extra = Number(extraGb) || 0;

        let owner = null;
        if (ownerPhone) owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [displayMsisdn(ownerPhone)]);
        if (!owner) owner = await dbGet(`SELECT * FROM owners ORDER BY id ASC LIMIT 1`);

        if (owner && owner.password && extra > 0) {
            const memberRecord = await dbGet(`SELECT gigabytes FROM bookings WHERE phone = ?`, [cleanMember]);
            const currentGB = Number(memberRecord?.gigabytes || 20);
            const newMI = (currentGB + extra) * 1024;
            const formattedMember = `20${cleanMember.replace(/^0/, '')}`;
            const formattedOwner = `20${owner.phone.replace(/^0/, '')}`;
            const payload = {
                name: "EnterpriseRed",
                type: "QuotaRedistribution",
                category: [{ value: "880", listHierarchyId: "TemplateID" }],
                parts: {
                    member: [
                        { id: [{ value: formattedOwner, schemeName: "MSISDN" }], type: "Owner" },
                        { id: [{ value: formattedMember, schemeName: "MSISDN" }], type: "Member" }
                    ],
                    characteristic: {
                        characteristicsValue: [
                            { characteristicName: "MI", value: String(newMI) },
                            { characteristicName: "Voice", value: "1500" },
                            { characteristicName: "SMS", value: "200" }
                        ]
                    }
                }
            };
            await callVodafoneForOwner(owner, "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup", "PATCH", payload);
            await dbRun(`UPDATE bookings SET gigabytes = gigabytes + ? WHERE phone = ?`, [extra, cleanMember]);
        }

        res.json({ success: true, message: `تمت إضافة +${extra} GB بنجاح ✅` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 8g. Member name update & activity logs
app.post('/api/members/name', async (req, res) => {
    try {
        const { phone, name } = req.body || {};
        if (phone && name) {
            await dbRun(`UPDATE bookings SET name = ? WHERE phone = ?`, [name.trim(), displayMsisdn(phone)]);
        }
        res.json({ success: true, message: 'تم تحديث اسم الفرد بنجاح' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/owners/select', (req, res) => res.json({ success: true }));

app.post('/api/owners/update-password', async (req, res) => {
    try {
        const { phone, password, oldPassword, changeVodafone } = req.body || {};
        if (!phone || !password) return res.status(400).json({ success: false, error: 'رقم الأونر وكلمة المرور مطلوبان' });
        const clean = displayMsisdn(phone);
        const newPass = String(password).trim();
        const shouldChangeVodafone = changeVodafone !== false;

        const owner = await dbGet(`SELECT * FROM owners WHERE phone = ?`, [clean]);
        if (!owner) return res.status(404).json({ success: false, error: 'الأونر غير موجود بالنظام' });

        if (shouldChangeVodafone) {
            const currentPass = oldPassword ? String(oldPassword).trim() : owner.password;
            const vfChange = await changeVodafoneOwnerPassword(owner, currentPass, newPass);
            if (!vfChange.success) {
                return res.status(400).json({ success: false, error: vfChange.error });
            }
        } else {
            const vf = await fastVodafoneCheck(clean, newPass);
            if (!vf.valid) return res.status(400).json({ success: false, error: vf.message || 'كلمة المرور غير صحيحة لدى فودافون' });
        }

        await dbRun(`UPDATE owners SET password = ?, password_valid = TRUE, password_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`, [newPass, clean]);
        ownerTokenCache.delete(clean);
        res.json({
            success: true,
            message: shouldChangeVodafone
                ? 'تم تغيير كلمة المرور فعلياً على فودافون 100% وتحديثها في النظام بنجاح ✅'
                : 'تم التحقق من كلمة المرور الجديدة وتحديثها بنجاح ✅'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/activity', (req, res) => {
    res.json({ success: true, events: [] });
});

app.get('/api/admin/notifications', async (req, res) => {
    try {
        // Fire-and-forget background check for pending invitations
        checkPendingInvitations().catch(() => {});

        const notifications = await dbAll(
            `SELECT * FROM admin_notifications ORDER BY id DESC LIMIT 30`
        ).catch(() => []);

        // Active members whose invitations were accepted but have no password yet
        const pendingPasswordMembers = await dbAll(
            `SELECT b.id, b.phone, b.name, b.gigabytes, b.renewal_day, b.invitation_accepted_at, b.created_at, b.updated_at,
                    b.owner_phone, COALESCE(o.name, b.owner_name) AS owner_name
             FROM bookings b
             LEFT JOIN owners o ON (b.owner_id = o.id OR b.owner_phone = o.phone)
             WHERE b.status = 'متأكتف'
               AND (b.password IS NULL OR TRIM(b.password) = '')
               AND b.deleted_at IS NULL
             ORDER BY b.invitation_accepted_at DESC NULLS LAST, b.updated_at DESC
             LIMIT 30`
        ).catch(() => []);

        res.json({
            success: true,
            notifications,
            pendingPasswordMembers
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/notifications/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun(`UPDATE admin_notifications SET is_read = TRUE WHERE id = ?`, [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/notifications/mark-all-read', async (req, res) => {
    try {
        await dbRun(`UPDATE admin_notifications SET is_read = TRUE`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/family/check-invitations', async (req, res) => {
    try {
        const result = await checkPendingInvitations();
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 9. Reset Entire Database (Wipe everything)
app.post('/api/admin/reset-database', async (req, res) => {
    try {
        console.log('⚠️ Resetting entire database...');
        try {
            await pool.query(`
                TRUNCATE TABLE customer_payments, monthly_payments, booking_chats, bookings, owners CASCADE;
                SELECT setval('bookings_id_seq', 1, false);
                SELECT setval('owners_id_seq', 1, false);
                SELECT setval('monthly_payments_id_seq', 1, false);
                SELECT setval('customer_payments_id_seq', 1, false);
                SELECT setval('booking_chats_id_seq', 1, false);
            `);
        } catch (pgErr) {
            console.error('PostgreSQL truncate error:', pgErr.message);
        }

        try {
            const sqlite3 = require('sqlite3').verbose();
            const dbPath = path.join(__dirname, '../bookings.db');
            if (fs.existsSync(dbPath)) {
                const sdb = new sqlite3.Database(dbPath);
                sdb.serialize(() => {
                    sdb.run(`DELETE FROM bookings`);
                    sdb.run(`DELETE FROM monthly_payments`);
                    sdb.run(`DELETE FROM bot_admins`);
                    sdb.run(`INSERT OR IGNORE INTO bot_admins (tg_id, name) VALUES ('1255885099', 'Super Admin')`);
                    sdb.close();
                });
            }
        } catch (sqlErr) {
            console.error('SQLite reset error:', sqlErr.message);
        }

        res.json({ success: true, message: 'تم تصفير الداتا بيز القديمة بالكامل بنجاح 🗑️✅' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'خطأ أثناء التصفير: ' + e.message });
    }
});

app.get('/api/bookings', async (req, res) => {
    try {
        const { renewal_day, status, search, include_deleted } = req.query;
        let sql = `SELECT b.*, 
            COALESCE(o.name, b.owner_name, b.owner_phone, 'أونر فودافون') as owner_name,
            COALESCE(b.owner_phone, o.phone) as owner_phone,
            (SELECT COUNT(id)::int FROM booking_chats WHERE booking_id = b.id) as chats_count,
            GREATEST(1, COALESCE((SELECT COUNT(*)::int FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) + 1, 1)) as renewal_count,
            (SELECT MIN(mp.year_month) FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as first_paid_month,
            (SELECT MAX(mp.year_month) FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as latest_paid_month
            FROM bookings b 
            LEFT JOIN owners o ON (b.owner_id = o.id OR b.owner_phone = o.phone)
            WHERE 1=1`;
        const params = [];

        if (!include_deleted) {
            sql += ` AND b.deleted_at IS NULL`;
        } else {
            sql += ` AND b.deleted_at IS NOT NULL`;
        }

        if (renewal_day && renewal_day !== 'all') { sql += ` AND b.renewal_day = ?`; params.push(Number(renewal_day)); }
        if (status && status !== 'all') { sql += ` AND b.status = ?`; params.push(status); }
        if (search) { sql += ` AND (b.phone LIKE ? OR b.gigabytes::text LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
        sql += ` ORDER BY b.created_at DESC`;
        res.json({ success: true, data: await dbAll(sql, params) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        const stats = {};
        for (const day of [7, 11, 25]) {
            const today = new Date().getDate();

            // Cycle logic: 
            // 7 and 11 reset on 15th (so they are active 1-14)
            // 25 resets on 1st (so they are active 15-31)
            let in_cycle = true;
            if ((day === 7 || day === 11) && today >= 15) in_cycle = false;
            if (day === 25 && today < 15) in_cycle = false;

            const total = await dbGet(`SELECT COUNT(*)::int as count FROM bookings WHERE renewal_day = ? AND deleted_at IS NULL`, [day]);
            const byStatus = await dbAll(`SELECT status, COUNT(*)::int as count FROM bookings WHERE renewal_day = ? AND deleted_at IS NULL GROUP BY status`, [day]);

            let byGig = [];
            if (in_cycle) {
                byGig = await dbAll(`SELECT gigabytes, COUNT(*)::int as count FROM bookings WHERE renewal_day = ? AND status = 'متأكتف' AND deleted_at IS NULL GROUP BY gigabytes ORDER BY gigabytes`, [day]);
            }
            const inWindow = isInPaymentWindow(day);
            const unpaidCount = inWindow
                ? await dbGet(`SELECT COUNT(*)::int as count FROM bookings b WHERE b.renewal_day = ? AND b.status = 'متأكتف' AND NOT EXISTS(
            SELECT 1 FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.year_month = ? AND mp.paid = 1
        )`, [day, currentMonth()])
                : null;
            stats[day] = { total: total.count, byStatus, byGig, inWindow, unpaidCount: unpaidCount?.count ?? null };
        }
        res.json({ success: true, data: stats });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bookings', async (req, res) => {
    try {
        const { phone, password, gigabytes, renewal_day, added_month_override, created_at, previous_renewals_count, status, owner_id, owner_phone, name } = req.body;
        if (!phone || !gigabytes || !renewal_day) return res.status(400).json({ success: false, error: 'رقم الخط والباقة ويوم التجديد مطلوبة' });

        const existing = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone.trim()]);
        if (existing) return res.status(400).json({ success: false, error: 'هذا الرقم محجوز مسبقاً' });

        let createdAtVal = new Date().toISOString();
        if (created_at) {
            createdAtVal = new Date(created_at).toISOString();
        } else if (added_month_override) {
            createdAtVal = new Date(`${added_month_override}-01T00:00:00Z`).toISOString();
        }

        const initialStatus = status || 'محجوز';
        const result = await dbRun(
            `INSERT INTO bookings(owner_id, owner_phone, name, phone, password, gigabytes, renewal_day, status, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [owner_id ? Number(owner_id) : null, owner_phone || null, name || null, phone.trim(), password ? password.trim() : null, Number(gigabytes), Number(renewal_day), initialStatus, createdAtVal]
        );
        const newBookingId = result.lastID;

        // Determine how many past renewals to backfill
        const pCount = Number(previous_renewals_count) > 0 ? Number(previous_renewals_count) : 1;
        await syncPastRenewals(newBookingId, Number(renewal_day), createdAtVal, pCount);

        const b = await dbGet(`SELECT b.*, 
            (SELECT COUNT(id)::int FROM booking_chats WHERE booking_id = b.id) as chats_count,
            (SELECT COUNT(*)::int FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as renewal_count
            FROM bookings b WHERE b.id = ?`, [newBookingId]);

        // 🔴 Webhook: Send to Bilal's Central Hub
        try {
            const bilalUrl = process.env.BILAL_HUB_URL || 'http://localhost:3000';
            fetch(bilalUrl + '/api/sync/external-booking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    merchant_name: 'هاك القلوب',
                    merchant_phone: '01000000000',
                    booking: b
                })
            }).catch(e => console.error("Webhook Send Error:", e));
        } catch (e) { }

        res.json({ success: true, data: b });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 🔴 Webhook: Receive Status Updates from Bilal Central Hub
app.post('/api/sync/update-status', async (req, res) => {
    try {
        const { phone, status } = req.body;
        await dbRun(`UPDATE bookings SET status = ? WHERE phone = ?`, [status, phone]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/bookings/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const b = await dbGet(`SELECT * FROM bookings WHERE id = ? `, [id]);
        if (!b) return res.status(404).json({ success: false, error: 'الحجز غير موجود' });
        const { phone, password, gigabytes, renewal_day, status, owner_tg, owner_username, created_at, previous_renewals_count, owner_id, owner_phone, name } = req.body;

        let newCreatedAt = b.created_at;
        if (created_at) {
            newCreatedAt = new Date(created_at).toISOString();
        }

        const newRenewalDay = Number(renewal_day || b.renewal_day);
        const oldRenewalDay = Number(b.renewal_day);

        await dbRun(
            `UPDATE bookings SET phone =?, password =?, gigabytes =?, renewal_day =?, status =?, created_at =?, updated_at = CURRENT_TIMESTAMP, owner_tg = COALESCE(?, owner_tg), owner_username = COALESCE(?, owner_username), owner_id = COALESCE(?, owner_id), owner_phone = COALESCE(?, owner_phone), name = COALESCE(?, name) WHERE id =? `,
            [
                phone || b.phone, 
                password !== undefined ? password : b.password, 
                Number(gigabytes || b.gigabytes), 
                newRenewalDay, 
                status || b.status, 
                newCreatedAt,
                owner_tg || null, 
                owner_username || null,
                owner_id ? Number(owner_id) : null,
                owner_phone || null,
                name || null,
                id
            ]
        );

        if (newRenewalDay !== oldRenewalDay) {
            await dbRun(`UPDATE monthly_payments SET renewal_day = ? WHERE booking_id = ?`, [newRenewalDay, id]);
            await dbRun(`UPDATE customer_payments SET renewal_day = ? WHERE booking_id = ?`, [newRenewalDay, id]);
        }

        if (previous_renewals_count !== undefined && previous_renewals_count !== null && previous_renewals_count !== '') {
            await syncPastRenewals(id, newRenewalDay, newCreatedAt, Number(previous_renewals_count));
        }

        const updatedB = await dbGet(`SELECT b.*, 
            (SELECT COUNT(id)::int FROM booking_chats WHERE booking_id = b.id) as chats_count,
            (SELECT COUNT(*)::int FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as renewal_count
            FROM bookings b WHERE b.id = ?`, [id]);
        res.json({ success: true, data: updatedB });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/bookings/:id', async (req, res) => {
    try {
        await dbRun(`UPDATE bookings SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bookings/:id/restore', async (req, res) => {
    try {
        await dbRun(`UPDATE bookings SET deleted_at = NULL WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/bookings/:id/permanent', async (req, res) => {
    try {
        await dbRun(`DELETE FROM bookings WHERE id = $1`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// /api/customer/me is defined below (line ~1115) - single definition only



app.get('/api/renewals', async (req, res) => {
    try {
        const { renewal_day, year_month } = req.query;
        const ym = year_month || currentMonth();
        const isAll = !renewal_day || renewal_day === 'all';
        const day = isAll ? 'all' : Number(renewal_day);

        let sql = `SELECT * FROM bookings WHERE deleted_at IS NULL AND (status IS NULL OR status != 'متكنسل')`;
        const params = [];
        if (!isAll) {
            sql += ` AND renewal_day = ?`;
            params.push(day);
        }
        sql += ` ORDER BY created_at ASC`;
        const bookings = await dbAll(sql, params);

        if (bookings.length === 0) {
            return res.json({
                success: true, data: [],
                meta: {
                    year_month: ym, renewal_day: day, inWindow: true,
                    window: { start: 1, end: 31 }, total: 0,
                    paidCount: 0, unpaidCount: 0,
                    today: new Date().getDate()
                }
            });
        }

        const ids = bookings.map(b => b.id);
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');

        // Single batch queries
        const counts = await dbAll(`SELECT booking_id, COUNT(*)::int as cnt FROM monthly_payments WHERE booking_id IN (${placeholders}) AND paid = 1 GROUP BY booking_id`, ids);
        const firsts = await dbAll(`SELECT booking_id, MIN(year_month) as ym FROM monthly_payments WHERE booking_id IN (${placeholders}) AND paid = 1 GROUP BY booking_id`, ids);
        const currentPays = await dbAll(`SELECT * FROM monthly_payments WHERE booking_id IN (${placeholders}) AND year_month = $${ids.length + 1}`, [...ids, ym]);
        const allPaidMonths = await dbAll(`SELECT booking_id, year_month FROM monthly_payments WHERE booking_id IN (${placeholders}) AND paid = 1 ORDER BY year_month DESC`, ids);

        const countMap = {}; counts.forEach(r => countMap[r.booking_id] = r.cnt);
        const firstMap = {}; firsts.forEach(r => firstMap[r.booking_id] = r.ym);
        const payMap = {}; currentPays.forEach(r => payMap[r.booking_id] = r);
        const paidMonthsMap = {};
        allPaidMonths.forEach(r => {
            if (!paidMonthsMap[r.booking_id]) paidMonthsMap[r.booking_id] = [];
            paidMonthsMap[r.booking_id].push(r.year_month);
        });

        const fullResult = bookings.map(b => {
            const dateStr = b.created_at instanceof Date ? b.created_at.toISOString() : String(b.created_at || '');
            const addedMonth = dateStr.substring(0, 7);
            const payRow = payMap[b.id] || null;

            return {
                ...b,
                renewal_count: countMap[b.id] || 0,
                first_paid_month: firstMap[b.id] || null,
                paid_months: paidMonthsMap[b.id] || [],
                added_month: addedMonth,
                is_new_this_month: addedMonth === ym,
                payment: payRow,
                paid_this_month: payRow?.paid === 1
            };
        });

        // Ensure bookings who paid this month or were created before/during this month appear
        const result = fullResult.filter(r => r.paid_this_month || !r.added_month || r.added_month <= ym);
        const paidCount = result.filter(r => r.paid_this_month).length;
        res.json({
            success: true, data: result,
            meta: {
                year_month: ym, renewal_day: day, inWindow: true,
                window: { start: 1, end: 31 }, total: result.length,
                paidCount, unpaidCount: result.length - paidCount,
                today: new Date().getDate()
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/renewals/summary', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT year_month, 
                    COUNT(*)::int as total_records, 
                    SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END)::int as paid_count,
                    SUM(CASE WHEN activated = 1 THEN 1 ELSE 0 END)::int as activated_count
             FROM monthly_payments 
             WHERE year_month IS NOT NULL
             GROUP BY year_month 
             ORDER BY year_month DESC`
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/fix-db', async (req, res) => {
    try {
        await pool.query(`UPDATE monthly_payments SET year_month = substring(year_month from 1 for 5) || '0' || substring(year_month from 6) WHERE length(year_month) = 6 AND year_month LIKE '%-%'`);
        await pool.query(`UPDATE customer_payments SET year_month = substring(year_month from 1 for 5) || '0' || substring(year_month from 6) WHERE length(year_month) = 6 AND year_month LIKE '%-%'`);
        res.json({ success: true, message: 'Database dates padded and fixed!' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/renewals/advanced', async (req, res) => {
    try {
        const ym = currentMonth();
        const payments = await dbAll(
            `SELECT m.*, b.phone, b.gigabytes, b.renewal_day 
             FROM monthly_payments m 
             JOIN bookings b ON m.booking_id = b.id 
             WHERE m.year_month > ? AND m.paid = 1 AND b.deleted_at IS NULL
             ORDER BY m.year_month ASC, b.renewal_day ASC`, [ym]
        );
        res.json({ success: true, data: payments });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/renewals/toggle', async (req, res) => {
    try {
        const { booking_id, year_month, renewal_day } = req.body;
        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ? `, [booking_id]);
        if (!booking) return res.status(404).json({ success: false, error: 'غير موجود' });

        const existing = await dbGet(`SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ? `, [booking_id, year_month]);
        if (existing) {
            const newPaid = existing.paid === 1 ? 0 : 1;
            await dbRun(`UPDATE monthly_payments SET paid = ?, paid_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND year_month = ? `, [newPaid, booking_id, year_month]);
        } else {
            await dbRun(`INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP)`,
                [booking_id, renewal_day || booking.renewal_day, year_month]);
        }
        res.json({ success: true, data: await dbGet(`SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ? `, [booking_id, year_month]) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/renewals/activate', async (req, res) => {
    try {
        const { booking_id, year_month } = req.body;
        const existing = await dbGet(`SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [booking_id, year_month]);
        if (!existing) return res.status(404).json({ success: false, error: 'غير موجود' });

        const newAct = existing.activated === 1 ? 0 : 1;
        await dbRun(`UPDATE monthly_payments SET activated = ? WHERE booking_id = ? AND year_month = ?`, [newAct, booking_id, year_month]);

        if (newAct === 1) {
            // activate only
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/renewals/months', async (req, res) => {
    try {
        const rows = await dbAll(`SELECT DISTINCT to_char(created_at, 'YYYY-MM') as ym FROM bookings UNION SELECT DISTINCT year_month as ym FROM monthly_payments WHERE year_month IS NOT NULL ORDER BY ym DESC`);
        const dbMonths = rows.map(r => r.ym).filter(Boolean);
        const now = new Date();
        const generated = [];
        for (let i = 0; i < 24; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            generated.push(ym);
        }
        const cur = currentMonth();
        const allMonths = Array.from(new Set([...generated, ...dbMonths])).filter(m => m <= cur).sort().reverse();
        const sorted = [cur, ...allMonths.filter(m => m !== cur)];
        res.json({ success: true, data: sorted });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Chats specific to bookings
app.get('/api/bookings/:id/chats', async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM booking_chats WHERE booking_id = ? ORDER BY created_at ASC`, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/bookings/:id/chats', async (req, res) => {
    try {
        const { sender, message } = req.body;
        if (!message) return res.status(400).json({ success: false, error: 'Message cannot be empty' });
        const result = await dbRun(
            `INSERT INTO booking_chats (booking_id, sender, message) VALUES (?, ?, ?)`,
            [req.params.id, sender || 'Unknown', message]
        );
        res.json({ success: true, data: await dbGet(`SELECT * FROM booking_chats WHERE id = ?`, [result.lastID]) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Fast Real Vodafone Check using Web API (No Puppeteer)
const crypto = require('crypto');

function generateCodeVerifier() { return crypto.randomBytes(32).toString("base64url"); }
function generateCodeChallenge(v) { return crypto.createHash("sha256").update(v, "ascii").digest("base64url"); }
function extractFormAction(html) {
    const m = html.match(/action="([^"]+)"/);
    if (!m) return null;
    return m[1].replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}
function extractCodeFromUrl(url) {
    try { return new URL(url).searchParams.get("code"); } catch (e) { return null; }
}

function decodeJwt(token) {
    try {
        const p = token.split(".");
        if (p.length !== 3) return null;
        return JSON.parse(Buffer.from(p[1], "base64").toString("utf-8"));
    } catch (e) { return null; }
}

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value.replace(/,/g, ""));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return null;
}

function parseUsageConsumptionResponse(data) {
    if (!Array.isArray(data)) return [];
    const items = [];

    for (const entry of data) {
        if (!isRecord(entry)) continue;
        const entryType = asString(entry["@type"]) || "";
        const buckets = Array.isArray(entry.bucket) ? entry.bucket : [];

        for (const bucket of buckets) {
            if (!isRecord(bucket)) continue;
            const balances = Array.isArray(bucket.bucketBalance) ? bucket.bucketBalance : [];
            const counters = Array.isArray(bucket.bucketCounter) ? bucket.bucketCounter : [];
            const products = Array.isArray(bucket.product) ? bucket.product : [];

            const activeProducts = products
                .filter(isRecord)
                .map((p) => ({
                    id: asString(p.id) || "",
                    name: asString(p.name) || "",
                }))
                .filter((p) => p.name);

            const productName = activeProducts.length > 0 ? activeProducts[0].name : null;
            const usageType = asString(bucket.usageType) || productName || entryType || "Unknown";

            let remaining = null;
            let used = null;
            let unit = "UNIT";
            let renewableDate = null;

            if (balances.length > 0) {
                const b0 = balances[0];
                remaining = asNumber(b0.remainingValue?.amount);
                unit = asString(b0.remainingValue?.units) || unit;
                const rawDate = b0.validFor?.endDateTime || b0.validFor?.endDate || null;
                renewableDate = rawDate ? String(rawDate).split('T')[0] : null;
            }

            if (counters.length > 0) {
                const c0 = counters[0];
                used = asNumber(c0.value?.amount);
                unit = asString(c0.value?.units) || unit;
            }

            items.push({
                label: productName || usageType,
                usageType,
                entryType,
                unit,
                used: used ?? 0,
                remaining: remaining ?? 0,
                total: (used || 0) + (remaining || 0),
                renewableDate,
                products: activeProducts,
            });
        }
    }
    return items;
}

function buildUsageSummary(items) {
    const res = [];
    const rules = [
        {
            key: "data",
            title: "كوتة الإنترنت (الشهر الحالي)",
            category: "current",
            icon: "wifi",
            match: (i) => i.usageType?.toUpperCase() === "DATA" || i.entryType?.toUpperCase() === "DATA",
        },
        {
            key: "voice",
            title: "دقائق المكالمات (الشهر الحالي)",
            category: "current",
            icon: "phone",
            match: (i) => i.usageType?.toUpperCase() === "VOICE",
        },
        {
            key: "family",
            title: "دقائق العيلة",
            category: "current",
            icon: "users",
            match: (i) => i.usageType?.toUpperCase().includes("FAMILY") || i.entryType?.toUpperCase() === "FAMILY",
        },
        {
            key: "sms",
            title: "رسائل الشهر الحالي",
            category: "current",
            icon: "message",
            match: (i) => i.usageType?.toUpperCase() === "SMS",
        },
        {
            key: "nc_mi",
            title: "جيجات الشهر القادم",
            category: "next",
            icon: "calendar_data",
            match: (i) => i.usageType?.toLowerCase() === "nc - mi",
        },
        {
            key: "nc_voice",
            title: "دقائق الشهر القادم",
            category: "next",
            icon: "calendar_voice",
            match: (i) => i.usageType?.toLowerCase() === "nc - voice",
        },
        {
            key: "nc_sms",
            title: "رسائل الشهر القادم",
            category: "next",
            icon: "calendar_sms",
            match: (i) => i.usageType?.toLowerCase() === "nc - sms",
        },
    ];

    for (const r of rules) {
        const item = items.find(r.match);
        if (item) {
            res.push({
                key: r.key,
                title: r.title,
                category: r.category,
                icon: r.icon,
                ...item,
            });
        }
    }
    return res;
}

async function fastVodafoneCheck(msisdn, password) {
    let clean = String(msisdn).replace(/[\s-]/g, "");
    if (clean.startsWith("+2")) clean = clean.substring(2);
    else if (clean.startsWith("002")) clean = clean.substring(3);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const authUrl = new URL("https://web.vodafone.com.eg/auth/realms/vf-realm/protocol/openid-connect/auth");
    authUrl.searchParams.set("client_id", "website");
    authUrl.searchParams.set("redirect_uri", "https://web.vodafone.com.eg/spa/myHome");
    authUrl.searchParams.set("state", crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid");
    authUrl.searchParams.set("nonce", crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    authUrl.searchParams.set("ui_locales", "ar");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    // Cookie jar map to avoid duplicate cookie keys
    const cookieMap = new Map();
    const addCookies = (res) => {
        const getSetCookieFn = res.headers.getSetCookie;
        const rawCookies = (typeof getSetCookieFn === 'function')
            ? res.headers.getSetCookie()
            : [res.headers.get('set-cookie')].filter(Boolean);
        for (const sc of rawCookies) {
            if (sc) {
                const kv = sc.split(";")[0];
                const eq = kv.indexOf("=");
                if (eq > 0) cookieMap.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
            }
        }
    };
    const getCookieStr = () => Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join("; ");

    // 1. Initial Page
    const pageRes = await fetch(authUrl.toString(), { redirect: "manual", headers: { "User-Agent": ua, Accept: "text/html" } });
    addCookies(pageRes);

    const html = await pageRes.text();
    const formAction = extractFormAction(html);
    if (!formAction) return { valid: false, message: 'مؤقتًا، النظام لا يستجيب', error: 'No form action' };

    // 2. Submit Login
    const loginRes = await fetch(formAction, {
        method: "POST", redirect: "manual",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: getCookieStr(),
            "User-Agent": ua,
            Referer: authUrl.toString(),
            Origin: "https://web.vodafone.com.eg"
        },
        body: new URLSearchParams({ username: clean, password }).toString(),
    });
    addCookies(loginRes);
    const redir = loginRes.headers.get("location");

    if (!redir) {
        const b = await loginRes.text();
        if (b.includes("Invalid") || b.includes("invalid") || b.includes("خطأ") || b.includes('برجاء ادخال')) {
            return { valid: false, message: 'الباسورد خطأ ❌' };
        }
        return { valid: false, message: 'فشل تسجيل الدخول ❌', error: 'Unknown HTML' };
    }

    const code = extractCodeFromUrl(redir);
    if (!code) return { valid: false, message: 'لم يكتمل الفحص (بدون كود) ❌' };

    // 3. Token Exchange
    const tokenRes = await fetch("https://web.vodafone.com.eg/auth/realms/vf-realm/protocol/openid-connect/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: getCookieStr(), "User-Agent": ua },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "website",
            code,
            redirect_uri: "https://web.vodafone.com.eg/spa/myHome",
            code_verifier: codeVerifier
        }).toString(),
    });
    if (!tokenRes.ok) return { valid: true, message: 'الدخول صحيح لكن مسحوب أو توكن خطأ' };

    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;
    const jwt = decodeJwt(accessToken);
    const userInfo = jwt?.userInfo || null;

    // 4. Fetch Real-Time Usage Consumption Report (DXL API)
    // IMPORTANT: Do NOT send F5 BIG-IP /auth cookies to /services/dxl/usage or F5 WAF rejects with 555.
    // Instead send clientId: 'WebsiteConsumer' + msisdn header.
    let quotaItems = [];
    let quotaSummary = [];
    let renewableDate = null;
    try {
        const usageUrl = `https://web.vodafone.com.eg/services/dxl/usage/usageConsumptionReport?bucket.product.publicIdentifier=${clean}&@type=aggregated`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const usageRes = await fetch(usageUrl, {
            headers: {
                "User-Agent": ua,
                Authorization: `Bearer ${accessToken}`,
                clientId: "WebsiteConsumer",
                msisdn: clean,
                "Accept-Language": "AR",
                Accept: "application/json",
                "Content-Type": "application/json",
                Referer: "https://web.vodafone.com.eg/spa/myHome",
            },
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (usageRes.ok) {
            const rawUsage = await usageRes.json();
            quotaItems = parseUsageConsumptionResponse(rawUsage);
            quotaSummary = buildUsageSummary(quotaItems);
            const firstWithDate = quotaSummary.find((q) => q.renewableDate) || quotaItems.find((q) => q.renewableDate);
            if (firstWithDate) renewableDate = firstWithDate.renewableDate;
        }
    } catch (err) {
        console.error("Usage fetch warning:", err.message);
    }

    // 5. Fetch Family Customer Group (for Red Owners)
    let familyMembers = [];
    let familyTotalMI = 0;
    try {
        const familyUrl = "https://web.vodafone.com.eg/services/dxl/cg/customerGroupAPI/customerGroup?type=Family";
        const fController = new AbortController();
        const fTimeout = setTimeout(() => fController.abort(), 10000);
        const fRes = await fetch(familyUrl, {
            headers: {
                "User-Agent": ua,
                Authorization: `Bearer ${accessToken}`,
                clientId: "WebsiteConsumer",
                msisdn: clean,
                "Accept-Language": "AR",
                Accept: "application/json",
                "Content-Type": "application/json",
                Referer: "https://web.vodafone.com.eg/spa/familySharing",
            },
            signal: fController.signal,
        });
        clearTimeout(fTimeout);
        if (fRes.ok) {
            const fData = await fRes.json();
            const group0 = Array.isArray(fData) ? fData[0] : fData;
            const parts = group0?.parts || {};
            const chars = parts.characteristicsValue?.characteristicsValue || [];
            const totalMIChar = chars.find((c) => c.characteristicName === "totalMI");
            if (totalMIChar && totalMIChar.value) {
                familyTotalMI = Number(totalMIChar.value);
            }

            const rawMembers = parts.member || [];
            for (const rm of rawMembers) {
                const idVal = rm.id?.[0]?.value || "";
                let memberPhone = idVal.replace(/[\s-]/g, "");
                if (memberPhone.startsWith("201")) memberPhone = memberPhone.substring(1);
                else if (memberPhone.startsWith("+201")) memberPhone = memberPhone.substring(3);

                const isOwner = (rm.type?.toLowerCase() === "owner") || (memberPhone === clean);
                if (isOwner) continue;
                if (rm.status !== "1") continue;

                const mChars = rm.characteristic?.characteristicsValue || [];
                const miChar = mChars.find((c) => c.characteristicName === "MI");
                const voiceChar = mChars.find((c) => c.characteristicName === "Voice");
                const smsChar = mChars.find((c) => c.characteristicName === "SMS");

                const miMB = miChar ? Number(miChar.value) : 0;
                let miGB = 0;
                if (miMB > 0) {
                    if (miMB % 1000 === 0) {
                        miGB = Math.round(miMB / 1000);
                    } else if (miMB > 500) {
                        const d1000 = miMB / 1000;
                        miGB = Math.abs(d1000 - Math.round(d1000)) < 0.15 ? Math.round(d1000) : Math.round(miMB / 1024);
                    } else {
                        miGB = Math.round(miMB / 1024);
                    }
                }

                familyMembers.push({
                    phone: memberPhone,
                    type: rm.type || "Member",
                    status: rm.status === "1" ? "active" : "inactive",
                    gigabytes: miGB,
                    megabytes: miMB,
                    voice: voiceChar ? Number(voiceChar.value) : 0,
                    sms: smsChar ? Number(smsChar.value) : 0,
                });
            }
        }
    } catch (fErr) {
        console.error("Family group fetch warning:", fErr.message);
    }

    const tariffItem = quotaItems.find((i) => i.entryType?.toLowerCase() === "tariff" || i.usageType?.toLowerCase() === "tariff");

    let renewalDay = null;
    if (userInfo?.billCycleCode && !isNaN(parseInt(userInfo.billCycleCode, 10))) {
        renewalDay = parseInt(userInfo.billCycleCode, 10);
    } else if (renewableDate) {
        renewalDay = new Date(renewableDate).getDate();
    }

    let totalGB = 0;
    if (familyTotalMI > 0) {
        const gb1000 = familyTotalMI / 1000;
        const gb1024 = familyTotalMI / 1024;
        if (familyTotalMI === 204800 || familyTotalMI === 200000 || (gb1024 >= 195 && gb1024 <= 205) || (gb1000 >= 195 && gb1000 <= 205)) {
            totalGB = 204.8;
        } else if (familyTotalMI % 1000 === 0) {
            totalGB = Math.round(gb1000);
        } else if (Math.abs(gb1000 - Math.round(gb1000)) > 0.05) {
            totalGB = parseFloat(gb1000.toFixed(1));
        } else {
            totalGB = Math.round(gb1024);
        }
    } else {
        const dataItem = quotaSummary.find((q) => q.key === "data");
        if (dataItem && dataItem.total) {
            const rawMb = Number(dataItem.total);
            if (rawMb === 204800 || rawMb === 200000 || (rawMb >= 195000 && rawMb <= 205000)) {
                totalGB = 204.8;
            } else {
                totalGB = rawMb > 5000 && (rawMb % 1000 === 0 || Math.abs(rawMb / 1000 - Math.round(rawMb / 1000)) > 0.05)
                    ? parseFloat((rawMb / 1000).toFixed(1))
                    : Math.round(rawMb / 1024);
            }
        } else if (tariffItem && tariffItem.total) {
            const raw = Number(tariffItem.total) || 0;
            if (raw === 204800 || raw === 200000 || (raw >= 195000 && raw <= 205000)) {
                totalGB = 204.8;
            } else {
                totalGB = Math.round(raw / 1024);
            }
        }
    }

    const data = {
        name: userInfo ? `${userInfo.firstName || ""} ${userInfo.lastName || ""}`.trim() : null,
        msisdn: userInfo?.msisdn || clean,
        currentPlan: userInfo?.serviceClassName || userInfo?.contractSubType || null,
        customerType: userInfo?.customerType || null,
        contractStatus: userInfo?.contractStatus || "ACTIVE",
        paymentType: userInfo?.paymentType || null,
        loyaltyStatus: userInfo?.isLoyalAuthorized === "Y" ? "مؤهل" : "غير مؤهل",
        balance: tariffItem ? String(tariffItem.remaining ?? "") : null,
        renewableDate,
        renewal_day: renewalDay,
        total_gigabytes: totalGB,
        familyMembers,
        quotaSummary,
        quotaItems,
        rawUserInfo: userInfo,
        fetchedAt: new Date().toISOString()
    };

    return { valid: true, message: 'الباسورد صحيح وتم جلب الاستهلاك بنجاح ✅', details: data };
}

// Unified Real-time Usage Consumption Endpoint (for Customer Dashboard & Admin/Employee Panel)
app.post('/api/usage', async (req, res) => {
    try {
        let { booking_id, phone, password } = req.body || {};
        let bookingRow = null;

        if (booking_id && (!phone || !password)) {
            bookingRow = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [booking_id]);
            if (bookingRow) {
                phone = phone || bookingRow.phone;
                password = password || bookingRow.password;
            }
        }

        if (phone && !password) {
            const cleanPhone = toEnglish(String(phone).trim());
            bookingRow = await dbGet(`SELECT * FROM bookings WHERE phone = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [cleanPhone]);
            if (bookingRow) {
                password = bookingRow.password;
            }
        }

        if (!phone || !password) {
            return res.status(400).json({
                success: false,
                need_password: !password,
                error: !password ? 'باسورد الفرد غير مسجل. يرجى إضافة باسورد الفرد لعرض الاستهلاك بدون أي مشكلة.' : 'رقم الموبايل مطلوب.'
            });
        }

        const result = await fastVodafoneCheck(toEnglish(String(phone).trim()), String(password).trim());
        if (!result.valid) {
            return res.json({
                success: false,
                error: result.message || 'فشل تسجيل الدخول في فودافون (تأكد من صحة باسورد أنا فودافون).'
            });
        }

        // Cache usage and subscriber name in database
        if (bookingRow && result.details) {
            try {
                const memberName = result.details.name || null;
                await dbRun(`UPDATE bookings SET name = COALESCE(?, name), last_usage_data = ?, last_usage_at = CURRENT_TIMESTAMP WHERE id = ?`, [memberName, JSON.stringify(result.details), bookingRow.id]);
            } catch (cacheErr) {
                console.error('Usage cache error:', cacheErr.message);
            }
        }

        return res.json({
            success: true,
            message: result.message,
            data: {
                ...(result.details || {}),
                booking: bookingRow ? {
                    id: bookingRow.id,
                    phone: bookingRow.phone,
                    gigabytes: bookingRow.gigabytes,
                    renewal_day: bookingRow.renewal_day,
                    status: bookingRow.status
                } : null
            }
        });
    } catch (e) {
        console.error('Error in /api/usage:', e);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء جلب الاستهلاك: ' + e.message });
    }
});

app.post('/api/vf-check', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, error: 'أدخل الرقم والباسورد' });
    try {
        const result = await fastVodafoneCheck(phone, password);
        return res.json({ success: true, result: result.valid ? 'valid' : 'invalid', message: result.message, details: result.details || null });
    } catch (e) {
        return res.json({ success: false, error: 'خطأ: ' + e.message });
    }
});

// Self-registration: verify with Vodafone then return pricing
app.post('/api/customer/register-verify', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, error: 'أدخل الرقم والباسورد' });
    try {
        // Verify with Vodafone
        const result = await fastVodafoneCheck(phone, password);
        if (!result.valid) {
            return res.json({ success: false, verified: false, error: result.message || 'الباسورد خطأ ❌' });
        }

        // Return success with pricing
        const currentPrices = await getPackagePrices();
        return res.json({
            success: true,
            verified: true,
            message: 'تم التحقق من الرقم بنجاح ✅',
            packages: Object.entries(currentPrices).map(([gb, price]) => ({ gigabytes: parseInt(gb), price: Number(price) })),
            details: result.details || null
        });
    } catch (e) {
        return res.json({ success: false, error: 'خطأ: ' + e.message });
    }
});

// /api/admins routes are defined below (near line ~1591) - single definition only

app.post('/api/admin/check-password', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, error: 'Phone and password required' });

        const result = await fastVodafoneCheck(phone, password);
        res.json({ success: true, valid: result.valid, result: result.valid ? 'valid' : 'invalid', message: result.message, details: result.details });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== BOT TOKEN & WEBHOOK SETUP ======
app.post('/api/bot/setup', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ success: false, error: 'Token is required' });
        const result = await dbRun('UPDATE settings SET value = $2 WHERE key = $1', ['telegram_token', token]);
        if (result.changes === 0) {
            await dbRun('INSERT INTO settings (key, value) VALUES ($1, $2) RETURNING key', ['telegram_token', token]);
        }

        // Define webhook URL (from host)
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const webhookUrl = `${proto}://${host}/api/webhook`;

        const tempBot = new TelegramBot(token);
        await tempBot.setWebHook(webhookUrl);

        res.json({ success: true, message: `Webhook set to ${webhookUrl}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


// ============================================ //
//          TELEGRAM RENEWAL REMINDERS          //
// ============================================ //
async function sendDailyRenewalReminders() {
    const bot = await getBot();
    if (!bot) return { sent: 0, skippedPaid: 0, error: 'البوت غير مفعل' };

    const ym = currentMonth();
    const today = new Date().getDate();
    const prices = await getPackagePrices();

    let paymentMethodsText = '';
    try {
        const row = await dbGet(`SELECT value FROM settings WHERE key = 'payment_methods'`);
        if (row && row.value) {
            let methods = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
            if (Array.isArray(methods) && methods.length > 0) {
                paymentMethodsText = '\n💳 *طرق الدفع المعتمدة:*\n' + methods.map(m => `• ${m.name || 'طريقة دفع'}: \`${m.num || m.number}\``).join('\n');
            }
        }
    } catch (_) {}

    const bookings = await dbAll(
        `SELECT b.*, 
         COALESCE(o.name, b.owner_name, 'أونر فودافون') as owner_name
         FROM bookings b 
         LEFT JOIN owners o ON (b.owner_id = o.id OR b.owner_phone = o.phone)
         WHERE b.status = 'متأكتف' 
           AND b.deleted_at IS NULL 
           AND b.owner_tg IS NOT NULL 
           AND TRIM(b.owner_tg) != ''`
    );

    let sent = 0;
    let skippedPaid = 0;
    const sentList = [];

    for (const b of bookings) {
        // Skip if already paid this month
        const payRow = await dbGet(`SELECT paid FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [b.id, ym]);
        if (payRow && payRow.paid === 1) {
            skippedPaid++;
            continue;
        }

        // Skip if there's already a pending payment awaiting review
        const pendingPay = await dbGet(`SELECT id FROM customer_payments WHERE booking_id = ? AND year_month = ? AND status = 'pending'`, [b.id, ym]);
        if (pendingPay) {
            continue;
        }

        const daysToRenewal = b.renewal_day - today;

        // Reminder sent within 3 days before renewal (3, 2, 1), on renewal day (0), or up to 3 days late
        if (daysToRenewal >= -3 && daysToRenewal <= 3) {
            const effectiveGigs = b.next_gigabytes || b.gigabytes;
            const price = prices[effectiveGigs] || prices[String(effectiveGigs)] || (await getPackagePrice(effectiveGigs));

            let timeBadge = '';
            if (daysToRenewal === 3) timeBadge = 'متبقي 3 أيام على التجديد ⏳';
            else if (daysToRenewal === 2) timeBadge = 'متبقي يومان على موعد التجديد ⏳';
            else if (daysToRenewal === 1) timeBadge = '⚠️ التجديد غداً!';
            else if (daysToRenewal === 0) timeBadge = '🚨 اليوم موعد التجديد!';
            else timeBadge = `⚠️ متأخر عن التجديد بـ ${Math.abs(daysToRenewal)} أيام!`;

            let msg = `⚠️ *تنبيه اقتراب موعد التجديد - فودافون ريد*\n\n`;
            msg += `عزيزي العميل، نود تذكيرك بميعاد تجديد باقة خطك:\n`;
            msg += `📱 *رقم الخط:* \`${b.phone}\`\n`;
            msg += `📦 *حجم الباقة:* *${effectiveGigs} GB*${b.next_gigabytes ? ' (كوتة الشهر القادم 🔄)' : ''}\n`;
            msg += `💰 *المبلغ المطلوب:* *${price} جنيه مصري*\n`;
            msg += `🗓️ *الموعد:* *${timeBadge}* (يوم ${b.renewal_day} في الشهر)\n`;

            if (paymentMethodsText) {
                msg += paymentMethodsText + '\n';
            }

            msg += `\n📌 *يرجى سداد المبلغ ورفع إيصال التحويل عبر التطبيق لتجنب إيقاف الخدمة تلقائياً.*`;

            const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';

            try {
                await bot.sendMessage(b.owner_tg, msg, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 فتح التطبيق وسداد الفاتورة', web_app: { url: webAppUrl } }],
                            [{ text: '💬 الدعم الفني', url: 'https://t.me/hak_alqulub' }]
                        ]
                    }
                });
                sent++;
                sentList.push({ phone: b.phone, daysLeft: daysToRenewal, tg_id: b.owner_tg });
            } catch (sendErr) {
                console.error(`[REMINDER] Error sending to ${b.owner_tg} (${b.phone}):`, sendErr.message);
            }
        }
    }

    return { sent, skippedPaid, sentList };
}

// ============================================ //
//                  DAILY CRON                  //
// ============================================ //
async function runDailyTasks() {
    try {
        const bot = await getBot();
        if (!bot) return;

        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const lastNotif = await dbGet(`SELECT value FROM settings WHERE key = 'last_notif_date'`);
        if (lastNotif && lastNotif.value === dateStr) return; // Already did daily tasks

        // Send reminders to all unpaid lines due in 3 days
        await sendDailyRenewalReminders();

        // Clean up deleted items older than 10 days
        await dbRun(`DELETE FROM bookings WHERE deleted_at < NOW() - INTERVAL '10 days'`);

        // Record daily run
        const result = await dbRun(`UPDATE settings SET value = $1 WHERE key = 'last_notif_date'`, [dateStr]);
        if (result.changes === 0) {
            await dbRun(`INSERT INTO settings (key, value) VALUES ('last_notif_date', $1) RETURNING key`, [dateStr]);
        }
    } catch (e) {
        console.error('Daily Job Error:', e);
    }
}

// Run loop for non-serverless environments:
runDailyTasks();
setInterval(runDailyTasks, 1000 * 60 * 60);

// Automatically check pending member invitations periodically
setTimeout(() => checkPendingInvitations().catch(() => {}), 5000);
setInterval(() => checkPendingInvitations().catch(() => {}), 45000);

// Vercel Cron Endpoint:
app.get('/api/cron', async (req, res) => {
    await runDailyTasks();
    await checkPendingInvitations().catch(() => {});
    res.json({ success: true, message: 'Cron executed successfully' });
});

// ============================================ //
//             TELEGRAM BOT (WEBHOOK)         //
// ============================================ //

let activeBot = null;
let activeBotToken = null;
let webhookEnsuredForToken = null;

async function getBot() {
    let token = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
    if (!token) {
        try {
            const row = await dbGet(`SELECT value FROM settings WHERE key = 'telegram_token'`);
            if (row && row.value) {
                try {
                    token = JSON.parse(row.value);
                } catch {
                    token = row.value;
                }
            }
        } catch (e) { }
    }
    if (!token) return null;
    token = String(token).trim().replace(/^"|"$/g, '');

    if (!token) return null;
    if (activeBotToken !== token || !activeBot) {
        activeBotToken = token;
        activeBot = new TelegramBot(activeBotToken);
        bindBotEvents(activeBot);

        // Automatically ensure Telegram webhook is bound when running on Vercel
        if ((process.env.VERCEL || process.env.VERCEL_ENV) && webhookEnsuredForToken !== token) {
            webhookEnsuredForToken = token;
            const baseUrl = (process.env.WEBAPP_URL || 'https://vodared.vercel.app').trim().replace(/\/$/, '');
            activeBot.setWebHook(`${baseUrl}/api/webhook`).catch(err => {
                console.error('Auto webhook setup warning:', err.message);
            });
        }
    }
    return activeBot;
}

app.get('/api/sethook', async (req, res) => {
    try {
        const botInstance = await getBot();
        if (!botInstance) return res.json({ success: false, error: 'لم يتم العثور على توكن البوت في الإعدادات.' });

        let url = process.env.WEBAPP_URL || `https://${req.headers.host}`;
        if (url.endsWith('/')) url = url.substring(0, url.length - 1);

        await botInstance.setWebHook(`${url}/api/webhook`);
        res.json({ success: true, message: `تم تفعيل الويبهوك بنجاح 🚀 على: ${url}/api/webhook` });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// START POLLING IN LOCAL DEV MODE ONLY IF EXPLICITLY ENABLED
if (!process.env.VERCEL && !process.env.VERCEL_ENV && process.env.ENABLE_LOCAL_POLLING === 'true') {
    console.log('[Dev] Running locally. Switching from Webhook to Polling...');
    getBot().then(async (bot) => {
        if (bot) {
            await bot.deleteWebHook();
            bot.startPolling();
            console.log('[Dev] Polling started successfully!');
        }
    }).catch(console.error);
}

app.get('/api/test-start', async (req, res) => {
    try {
        const botInstance = await getBot();
        if (!botInstance) return res.json({ success: false, error: 'No Bot Instance' });

        const chatId = req.query.chat_id || '1255885099';
        const myBookings = await dbAll(`SELECT * FROM bookings WHERE owner_tg = ? AND deleted_at IS NULL`, [String(chatId)]);

        await botInstance.sendMessage(chatId, 'This is a test message from /api/test-start');

        res.json({ success: true, bookings: myBookings.length });
    } catch (e) {
        res.json({ success: false, error: e.toString() });
    }
});

// Helper functions for Bot
async function isAuth(msg) {
    if (!msg || !msg.from) return false;
    const tgId = String(msg.from.id);
    if (tgId === '1255885099') return true;
    const username = (msg.from.username || '').toLowerCase();
    const admin = await dbGet(`SELECT * FROM bot_admins WHERE LOWER(tg_id) = LOWER(?) OR LOWER(tg_id) = LOWER(?) OR tg_id = ?`, [username, tgId, tgId]);
    return !!admin;
}

function mainMenu(customUrl) {
    let url = (customUrl || process.env.WEBAPP_URL || 'https://vodared.vercel.app').trim();
    if (!url.startsWith('https://')) {
        url = 'https://' + url.replace(/^http:\/\//, '');
    }
    return {
        inline_keyboard: [
            [{ text: '🚀 فتح التطبيق', web_app: { url } }]
        ]
    };
}

function formatBooking(b) {
    let extra = '';
    if (b.renewal_count !== undefined) extra = `\n🔄 مرات التجديد: ${b.renewal_count} مرة`;
    return `📱 \`${b.phone}\`\n🔑 \`${b.password}\`\n📶 ${b.gigabytes} جيجا | 📅 يوم ${b.renewal_day}\nالحالة: ${STATUS_ICONS[b.status] || '⚪'} ${b.status}${extra}`;
}

function getAvailableStatusChanges(status, bId) {
    const btns = [];
    if (status === 'محجوز') {
        btns.push([{ text: '🟡 تحويل إلى: ضن', callback_data: `chstatus_${bId}_ضن` }]);
    } else if (status === 'اتفعل') {
        btns.push([{ text: '🟢 تحويل إلى: متأكتف', callback_data: `chstatus_${bId}_متأكتف` }]);
        btns.push([{ text: '⚫ تحويل إلى: متكنسل', callback_data: `chstatus_${bId}_متكنسل` }]);
    }
    return btns;
}

app.post('/api/webhook', async (req, res) => {
    // CRITICAL: Always return 200 to Telegram. If we return 500, Telegram retries infinitely.
    try {
        const botInstance = await getBot();
        if (!botInstance) {
            console.error('Webhook: No bot instance available');
            return res.status(200).send('OK');
        }

        // VERCEL FIX: Direct execution of /start without relying on event emitter queue
        if (req.body && req.body.message && req.body.message.text) {
            const text = req.body.message.text;
            const chatId = req.body.message.chat.id;
            const firstName = req.body.message.from?.first_name || 'صديقي';

            if (text.startsWith('/start')) {
                try {
                    const isAdmin = await isAuth(req.body.message);
                    let webAppUrl = (process.env.WEBAPP_URL || 'https://vodared.vercel.app').trim();
                    if (!webAppUrl.startsWith('https://')) {
                        webAppUrl = 'https://' + webAppUrl.replace(/^http:\/\//, '');
                    }

                    if (isAdmin) {
                        await botInstance.sendMessage(chatId, `👑 *مرحباً بك يا أونر في نظام فودافون ريد 🚀*\n\nاضغط على الزر أدناه لفتح لوحة التحكم والتطبيق ومتابعة الخطوط والأفراد:`, { parse_mode: 'Markdown', reply_markup: mainMenu(webAppUrl) });
                    } else {
                        const myBookings = await dbAll(`SELECT * FROM bookings WHERE owner_tg = ? AND deleted_at IS NULL`, [String(chatId)]);

                        if (myBookings.length > 0) {
                            let nums = myBookings.map(b => b.phone).join(' / ');
                            await botInstance.sendMessage(chatId, `👋 مرحباً بك يا ${firstName}!\nلقد تم العثور على حسابك المرتبط بالأرقام:\n📱 ${nums}\n\nلمتابعة باقاتك وتسديد الاشتراك، اضغط على الزر بالأسفل لفتح التطبيق:`, {
                                reply_markup: { inline_keyboard: [[{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }]] }
                            });
                        } else {
                            await botInstance.sendMessage(chatId, `👋 أهلاً بك في نظام فودافون ريد.\n\nيبدو أنك لم تقم بربط أي خط بعد.\nاضغط على الزر بالأسفل لـ "فتح التطبيق" وتسجيل الدخول برقمك ليتم حفظ حسابك ومعرفة مواعيد تجديدك تلقائياً:`, {
                                reply_markup: { inline_keyboard: [[{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }]] }
                            });
                        }
                    }
                } catch (startErr) {
                    console.error('Error in /start webhook handling:', startErr);
                    try {
                        await botInstance.sendMessage(chatId, '⚠️ حدث خطأ: ' + startErr.message);
                    } catch (e) { }
                }
                // /start handled directly - DO NOT call processUpdate to avoid double message
                return res.status(200).send('OK');
            }
        }

        // For non-/start updates, pass to bot's event system
        botInstance.processUpdate(req.body);
        // Small delay to allow outgoing API calls to complete before Vercel shuts down
        await new Promise(resolve => setTimeout(resolve, 1500));
        return res.status(200).send('OK');
    } catch (e) {
        console.error('Webhook error:', e);
        // CRITICAL: Still return 200 to prevent Telegram infinite retry loop
        return res.status(200).send('OK');
    }
});

// BOT LOGIC
function bindBotEvents(bot) {
    // Fallback for /start if it somehow bypasses the fast-path above (e.g. via polling)
    bot.onText(/\/start/, async (msg) => {
        try {
            const isAdmin = await isAuth(msg);
            let webAppUrl = (process.env.WEBAPP_URL || 'https://vodared.vercel.app').trim();
            if (!webAppUrl.startsWith('https://')) {
                webAppUrl = 'https://' + webAppUrl.replace(/^http:\/\//, '');
            }

            if (isAdmin) {
                return bot.sendMessage(msg.chat.id, `👑 *مرحباً بك يا أونر في نظام فودافون ريد 🚀*\n\nاضغط على الزر أدناه لفتح لوحة التحكم والتطبيق ومتابعة الخطوط والأفراد:`, { parse_mode: 'Markdown', reply_markup: mainMenu(webAppUrl) });
            }
            const tgId = String(msg.chat.id);
            const myBookings = await dbAll(`SELECT * FROM bookings WHERE owner_tg = ? AND deleted_at IS NULL`, [tgId]);

            if (myBookings.length > 0) {
                let nums = myBookings.map(b => b.phone).join(' / ');
                bot.sendMessage(msg.chat.id, `👋 مرحباً بك يا ${msg.from?.first_name || 'صديقي'}!\nلقد تم العثور على حسابك المرتبط بالأرقام:\n📱 ${nums}\n\nلمتابعة باقاتك وتسديد الاشتراك، اضغط على الزر بالأسفل لفتح التطبيق:`, {
                    reply_markup: { inline_keyboard: [[{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }]] }
                }).catch(() => { });
            } else {
                bot.sendMessage(msg.chat.id, `👋 أهلاً بك في نظام فودافون ريد.\n\nيبدو أنك لم تقم بربط أي خط بعد.\nاضغط على الزر بالأسفل لـ "فتح التطبيق" وتسجيل الدخول برقمك ليتم حفظ حسابك ومعرفة مواعيد تجديدك تلقائياً:`, {
                    reply_markup: { inline_keyboard: [[{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }]] }
                }).catch(() => { });
            }
        } catch (e) {
            console.error('Error in bindBotEvents /start:', e.message);
        }
    });

    // Handle incoming messages for Admin Dashboard (Search by phone & commands)
    bot.on('message', async (msg) => {
        if (msg.text && (msg.text.startsWith('/setpass') || msg.text.startsWith('/باسورد') || msg.text.startsWith('/كلمة_السر'))) {
            if (!(await isAuth(msg))) return;
            const parts = msg.text.trim().split(/\s+/);
            if (parts.length < 3) {
                return bot.sendMessage(msg.chat.id, '⚠️ طريقة الاستخدام:\n`/setpass <رقم_الفرد> <الباسورد>`\n\nمثال:\n`/setpass 01012345678 Pass123$`', { parse_mode: 'Markdown' });
            }
            const rawPhone = toEnglish(parts[1]);
            const targetPhone = displayMsisdn(rawPhone);
            const newPassword = parts.slice(2).join(' ').trim();

            const booking = await dbGet(`SELECT * FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [targetPhone]);
            if (!booking) {
                return bot.sendMessage(msg.chat.id, `❌ لم يتم العثور على فرد مسجل برقم \`${targetPhone}\`.`, { parse_mode: 'Markdown' });
            }

            await bot.sendMessage(msg.chat.id, `⏳ جاري فحص وتأكيد باسورد أنا فودافون للرقم \`${targetPhone}\`...`, { parse_mode: 'Markdown' });
            const vf = await fastVodafoneCheck(targetPhone, newPassword);
            if (!vf.valid) {
                return bot.sendMessage(msg.chat.id, `❌ الباسورد غير صحيح لدى فودافون:\n${vf.message || 'تأكد من كتابة كلمة المرور الصحيحة'}`);
            }

            await dbRun(
                `UPDATE bookings SET password = ?, password_valid = TRUE, password_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [newPassword, booking.id]
            );

            return bot.sendMessage(msg.chat.id, `✅ *تم حفظ وتأكيد باسورد الفرد بنجاح! 🎉*\n\n📱 *الرقم:* \`${targetPhone}\`\n🔑 *الباسورد:* \`${newPassword}\`\n✨ أصبح الخط مفعلاً ومتصلاً بالكامل بمتابعة الاستهلاك والتجديد.`, { parse_mode: 'Markdown' });
        }

        if (msg.text && msg.text.startsWith('/')) return;
        if (!(await isAuth(msg))) return;

        const chatId = msg.chat.id;
        const text = toEnglish(msg.text?.trim() || '');
        if (!/^\d+$/.test(text)) return;

        try {
            // Find bookings by phone
            const results = await dbAll(`SELECT * FROM bookings WHERE phone LIKE ? AND deleted_at IS NULL LIMIT 5`, [`%${text}%`]);
            if (!results.length) return bot.sendMessage(chatId, '❌ لم يتم العثور على أي حجز بهذا الرقم.');

            let reply = `🔍 *نتائج البحث:*\n\n`;
            const btns = [];
            results.forEach((b, i) => {
                reply += `${i + 1}. 📱 \`${b.phone}\` | ${b.gigabytes}G | ${STATUS_ICONS[b.status] || '⚪'}\n`;
                btns.push([{ text: `تعديل/عرض: ${b.phone}`, callback_data: `bdetail_${b.id}` }]);
            });

            bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        } catch (e) {
            console.error('Bot Message search error', e);
        }
    });

    // Handle completely Admin Dashboard Logic from Callback Queries
    bot.on('callback_query', async (query) => {
        const chatId = query.message?.chat?.id;
        const msgId = query.message?.message_id;
        const data = query.data;

        if (!chatId || !msgId) return;

        if (!(await isAuth(query))) {
            return bot.answerCallbackQuery(query.id, { text: '❌ صلاحياتك غير مسجلة كمدير', show_alert: true }).catch(() => { });
        }

        try {
            if (data === 'm_main') {
                await bot.editMessageText('👋 مرحباً بك في لوحة الموظفين.\nاختر من القائمة:', { chat_id: chatId, message_id: msgId, reply_markup: mainMenu() });
            }
            else if (data === 'm_bookings') {
                const total = await dbGet(`SELECT COUNT(*)::int as c FROM bookings WHERE deleted_at IS NULL`);
                const statuses = await dbAll(`SELECT status, COUNT(*)::int as c FROM bookings WHERE deleted_at IS NULL GROUP BY status`);

                let txt = `📋 *إجمالي الطلبات*: ${total.c}\n\n`;
                statuses.forEach(s => { txt += `${STATUS_ICONS[s.status] || '⚪'} ${s.status}: ${s.c}\n`; });
                txt += `\n*يمكنك البحث عن أي رقم مباشرة بإرسال الرقم في الشات.*`;

                await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'm_main' }]] } });
            }
            else if (data === 'm_achievements') {
                const ym = currentMonth();
                const sql = `
                    SELECT b.gigabytes, COUNT(*)::int as c 
                    FROM monthly_payments m 
                    JOIN bookings b ON m.booking_id = b.id 
                    WHERE m.year_month = ? AND m.activated = 1 AND b.deleted_at IS NULL
                    GROUP BY b.gigabytes
                    ORDER BY b.gigabytes
                `;
                const stats = await dbAll(sql, [ym]);

                let txt = `📈 *إنجازات هذا الشهر (${ym})*\n\n`;
                if (!stats.length) {
                    txt += `❌ لم يتم تفعيل أو تجديد أي باقات هذا الشهر حتى الآن.`;
                } else {
                    let totalPackages = 0;
                    stats.forEach(s => {
                        txt += `📶 ${s.gigabytes} جيجا: *${s.c} باقة*\n`;
                        totalPackages += s.c;
                    });
                    txt += `\n📊 *الإجمالي:* ${totalPackages} باقة متأكتفة.`;
                }

                await bot.editMessageText(txt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'm_main' }]] } });
            }
            else if (data === 'm_search') {
                await bot.sendMessage(chatId, '🔍 أرسل رقم الموبايل للبحث وتغيير الحالة.');
                await bot.answerCallbackQuery(query.id);
            }
            else if (data.startsWith('bdetail_')) {
                const bId = Number(data.split('_')[1]);
                const b = await dbGet('SELECT * FROM bookings WHERE id = $1', [bId]);
                if (!b) return bot.answerCallbackQuery(query.id, { text: 'غير موجود' });

                const pCount = await dbGet('SELECT COUNT(*)::int as c FROM monthly_payments WHERE booking_id = $1 AND paid = 1', [bId]);
                b.renewal_count = pCount ? pCount.c : 0;

                const btns = getAvailableStatusChanges(b.status, b.id);
                btns.push([{ text: '🔙 القائمة', callback_data: 'm_main' }]);

                await bot.editMessageText(`📦 *تفاصيل الحجز*\n\n${formatBooking(b)}`, {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: btns }
                });
            }
            else if (data.startsWith('chstatus_')) {
                const parts = data.split('_');
                const bId = Number(parts[1]);
                const newStatus = parts.slice(2).join('_');

                await dbRun('UPDATE bookings SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2', [newStatus, bId]);
                const b = await dbGet('SELECT * FROM bookings WHERE id = $1', [bId]);

                const pCount = await dbGet('SELECT COUNT(*)::int as c FROM monthly_payments WHERE booking_id = $1 AND paid = 1', [bId]);
                b.renewal_count = pCount ? pCount.c : 0;

                const btns = getAvailableStatusChanges(b.status, b.id);
                btns.push([{ text: '🔙 القائمة', callback_data: 'm_main' }]);

                await bot.answerCallbackQuery(query.id, { text: `✅ تم التحويل إلى ${newStatus}` });
                await bot.editMessageText(`✅ *تم تحديث الحالة*\n\n${formatBooking(b)}`, {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns }
                });
            }
            else if (data === 'm_renewals') {
                await bot.editMessageText(`📅 *سجلات التجديد*\n\nاختر اليوم لعرض كل الخطوط التي سددت اشتراكها هذا الشهر:`, {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'يوم 7', callback_data: 'renlist_7_0' }, { text: 'يوم 11', callback_data: 'renlist_11_0' }, { text: 'يوم 25', callback_data: 'renlist_25_0' }],
                            [{ text: '🔙 رجوع', callback_data: 'm_main' }]
                        ]
                    }
                });
            }
            else if (data.startsWith('renlist_')) {
                const day = Number(data.split('_')[1]);
                const page = Number(data.split('_')[2]);
                const PAGE_SIZE = 6;
                const ym = currentMonth();

                const querySql = `
                    SELECT b.*, m.id as pay_id, m.activated,
                           (SELECT COUNT(*) FROM monthly_payments m2 WHERE m2.booking_id = b.id AND m2.paid = 1) as renewal_count
                    FROM bookings b 
                    JOIN monthly_payments m ON b.id = m.booking_id 
                    WHERE b.renewal_day = $1 AND m.year_month = $2 AND m.paid = 1 AND b.deleted_at IS NULL
                    ORDER BY m.activated ASC, m.paid_at ASC
                `;
                const results = await dbAll(querySql, [day, ym]);

                if (!results.length) {
                    await bot.editMessageText(`ℹ️ لم يتم تسجيل أي مدفوعات ليوم ${day} لشهر (${ym}) حتى الآن.`, {
                        chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'm_renewals' }]] }
                    });
                    return;
                }

                const total = results.length;
                const unactivated = results.filter(r => r.activated === 0).length;
                const pages = Math.ceil(total / PAGE_SIZE);
                const slice = results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

                let txt = `📅 *تجديدات يوم ${day} لشهر (${ym})*\n`;
                txt += `📊 إجمالي المدفوعين: *${total}* | بانتظار التفعيل: *${unactivated}*\n\n`;
                const btns = [];
                slice.forEach(b => {
                    const statusIcon = b.activated === 1 ? '🟢 متأكتف' : '⏳ بانتظار التفعيل';
                    txt += `📱 \`${b.phone}\` | ${b.gigabytes}G | 🔄 تجديد رقم ${b.renewal_count || 1} (${statusIcon})\n`;
                    if (b.activated !== 1) {
                        btns.push([{ text: `✅ تأكيد تأكتف (${b.phone})`, callback_data: `activate_${b.id}_${day}` }]);
                    }
                });

                const nav = [];
                if (page > 0) nav.push({ text: '⬅️ السابق', callback_data: `renlist_${day}_${page - 1}` });
                if (page < pages - 1) nav.push({ text: 'التالي ➡️', callback_data: `renlist_${day}_${page + 1}` });
                if (nav.length) btns.push(nav);
                btns.push([{ text: '🔙 رجوع للأيام', callback_data: 'm_renewals' }]);

                await bot.editMessageText(txt, {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns }
                });
            }
            else if (data.startsWith('activate_')) {
                const bId = Number(data.split('_')[1]);
                const day = Number(data.split('_')[2]);
                const ym = currentMonth();

                await dbRun('UPDATE monthly_payments SET activated = 1, activated_at = CURRENT_TIMESTAMP WHERE booking_id = $1 AND year_month = $2 AND paid = 1', [bId, ym]);

                await bot.answerCallbackQuery(query.id, { text: '✅ تم تأكيد تفعيل الباقة لهذا الشهر!' });

                // Hacky simulation of clicking the day again, normally in bot.js it emitted an event
                // This simulates the refresh but we cannot emit here, so we will not refresh automatically.
                // Just let them click "Back".
            }

            bot.answerCallbackQuery(query.id).catch(() => { });
        } catch (err) {
            console.error(err);
            bot.answerCallbackQuery(query.id, { text: 'خطأ!' }).catch(() => { });
        }
    });
}

// ============================================ //
//          CUSTOMER SELF-SERVICE PAYMENT       //
// ============================================ //

// Customer login: authenticate by phone + vodafone password
app.post('/api/customer/login', async (req, res) => {
    try {
        let { phone, password, booking_id, tg_id, tg_username } = req.body || {};
        phone = phone ? toEnglish(String(phone).trim().replace(/[\s-]/g, '')) : '';
        password = password ? String(password).trim() : '';
        if ((!phone || !password) && !booking_id) return res.status(400).json({ success: false, error: 'البيانات مطلوبة' });

        let booking = null;
        if (booking_id && !req.body.is_owner) {
            if (phone) {
                booking = await dbGet(`SELECT * FROM bookings WHERE id = ? AND phone = ? AND deleted_at IS NULL`, [booking_id, phone]);
            } else {
                booking = await dbGet(`SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`, [booking_id]);
            }
        }
        if (!booking && phone && password) {
            booking = await dbGet(`SELECT * FROM bookings WHERE phone = ? AND password = ? AND deleted_at IS NULL`, [phone, password]);
        }

        if (!booking) {
            // Check if there's a pending first_time payment for this phone
            const pendingReg = phone ? await dbGet(
                `SELECT * FROM customer_payments WHERE phone = ? AND payment_type = 'first_time' AND status IN ('pending', 'needs_review')`,
                [phone]
            ) : null;
            if (pendingReg) {
                return res.json({
                    success: true,
                    data: {
                        id: null,
                        phone: pendingReg.phone,
                        gigabytes: pendingReg.gigabytes,
                        renewal_day: pendingReg.renewal_day,
                        status: 'قيد المراجعة',
                        created_at: pendingReg.created_at,
                        paid_this_month: false,
                        days_to_renewal: 0,
                        in_grace_period: false,
                        overdue: false,
                        pending_payment: pendingReg,
                        is_pending_registration: true,
                        payment_type: 'first_time'
                    }
                });
            }

            // Check if the phone is registered at all
            const bExists = phone ? await dbGet(`SELECT * FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone]) : null;
            if (bExists) {
                // Verify password against Vodafone directly
                const vf = await fastVodafoneCheck(phone, password);
                if (vf.valid) {
                    const vfName = vf.details?.name || null;
                    if (vfName) {
                        await dbRun(`UPDATE bookings SET password = ?, name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [password, vfName, bExists.id]);
                    } else {
                        await dbRun(`UPDATE bookings SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [password, bExists.id]);
                    }
                    booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [bExists.id]);
                } else {
                    return res.status(401).json({ success: false, not_found: false, error: vf.message || 'كلمة المرور غير صحيحة لدى فودافون.' });
                }
            } else {
                // Check if Owner logged in with owner credentials
                const owner = phone ? await dbGet(`SELECT * FROM owners WHERE phone = ?`, [phone]) : null;
                if (owner) {
                    let ownerValid = (owner.password === password);
                    let vfMsg = null;
                    if (!ownerValid && password) {
                        const vf = await fastVodafoneCheck(phone, password);
                        vfMsg = vf.message;
                        if (vf.valid) {
                            await dbRun(`UPDATE owners SET password = ? WHERE id = ?`, [password, owner.id]);
                            ownerValid = true;
                        }
                    }
                    if (ownerValid) {
                        return res.json({
                            success: true,
                            is_owner: true,
                            data: {
                                id: owner.id,
                                phone: owner.phone,
                                name: owner.name,
                                plan: owner.plan,
                                renewal_day: owner.renewal_day,
                                gigabytes: 0,
                                is_owner: true
                            }
                        });
                    }
                    return res.status(401).json({ success: false, not_found: false, error: vfMsg || 'كلمة المرور غير صحيحة لدى فودافون.' });
                }
                return res.status(401).json({ success: false, error: 'الرقم غير مسجل في النظام.', not_found: true });
            }
        }

        // Get renewal info
        const ym = currentMonth();
        const payRow = await dbGet(
            `SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ?`,
            [booking.id, ym]
        );

        // Get latest customer payment regardless of status
        const latestPayment = await dbGet(
            `SELECT * FROM customer_payments WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1`,
            [booking.id]
        );

        // Get renewal count and first subscription date
        const renewalCount = await dbGet(`SELECT COUNT(*)::int as cnt FROM monthly_payments WHERE booking_id = ? AND paid = 1`, [booking.id]);
        const firstPayment = await dbGet(`SELECT MIN(year_month) as first_month FROM monthly_payments WHERE booking_id = ? AND paid = 1`, [booking.id]);
        const latestPaidMonth = await dbGet(`SELECT MAX(year_month) as latest_month FROM monthly_payments WHERE booking_id = ? AND paid = 1`, [booking.id]);

        if (booking && (tg_id || req.body.owner_tg)) {
            const newTg = String(tg_id || req.body.owner_tg);
            const newUsername = tg_username || req.body.owner_username || null;
            await dbRun(
                'UPDATE bookings SET owner_tg = ?, owner_username = COALESCE(?, owner_username) WHERE id = ?',
                [newTg, newUsername, booking.id]
            ).catch(err => console.error('Error linking tg_id in customer login:', err));
            booking.owner_tg = newTg;
            if (newUsername) booking.owner_username = newUsername;
        }

        const todayDate = new Date();
        const todayDay = todayDate.getDate();
        let daysToRenewal = booking.renewal_day - todayDay;

        // If they haven't even paid last month, they are massively overdue (negative days).
        if (!payRow || payRow.paid !== 1) {
            if (latestPaidMonth && latestPaidMonth.latest_month) {
                if (latestPaidMonth.latest_month < ym) {
                    daysToRenewal = daysToRenewal - 30; // Force them to be overdue (approx 30 days per missing month)
                }
            } else {
                // Never paid? If we are past their very first month, they are overdue. For now simple approx.
                // daysToRenewal = daysToRenewal; 
            }
        }


        res.json({
            success: true,
            data: {
                id: booking.id,
                owner_id: booking.owner_id || null,
                owner_phone: booking.owner_phone || null,
                name: booking.name || null,
                phone: booking.phone,
                gigabytes: booking.gigabytes,
                renewal_day: booking.renewal_day,
                status: booking.status,
                last_usage_data: booking.last_usage_data || null,
                last_usage_at: booking.last_usage_at || null,
                owner_tg: booking.owner_tg,
                owner_username: booking.owner_username,
                created_at: booking.created_at,
                latest_paid_month: latestPaidMonth?.latest_month || null,
                paid_this_month: payRow?.paid === 1,
                days_to_renewal: daysToRenewal,
                in_grace_period: daysToRenewal <= 6 && daysToRenewal >= 0,
                overdue: daysToRenewal < 0,
                pending_payment: latestPayment && (latestPayment.status === 'pending' || latestPayment.status === 'needs_review') ? latestPayment : null,
                latest_payment: latestPayment || null,
                renewal_count: renewalCount?.cnt || 0,
                first_month: firstPayment?.first_month || null,
                is_pending_registration: false,
                payment_type: 'renewal'
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: send message to a specific user
app.post('/api/admin/send-user-message', async (req, res) => {
    try {
        const { tg_id, message } = req.body;
        if (!tg_id || !message) return res.status(400).json({ success: false, error: 'البيانات غير مكتملة' });

        const botInstance = await getBot();
        if (!botInstance) return res.status(500).json({ success: false, error: 'البوت غير مفعل' });

        await botInstance.sendMessage(tg_id, message);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: 'تعذر إرسال الرسالة لأن المستخدم قد يكون حظر البوت مؤقتاً.' });
    }
});

// Admin: manual bulk reminder
app.post('/api/admin/manual-bulk-remind', async (req, res) => {
    try {
        const { day } = req.body;
        if (!day) return res.status(400).json({ success: false, error: 'يوم التجديد مطلوب' });

        const botInstance = await getBot();
        if (!botInstance) return res.status(500).json({ success: false, error: 'البوت غير مفعل' });

        const curM = currentMonth();
        const bookingsList = await dbAll(`SELECT * FROM bookings WHERE status = 'متأكتف' AND renewal_day = ? AND deleted_at IS NULL AND owner_tg IS NOT NULL`, [day]);

        let sentCount = 0;
        for (const b of bookingsList) {
            const payRow = await dbGet(`SELECT paid FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [b.id, curM]);
            if (!payRow || payRow.paid !== 1) {
                const mask = b.phone;
                const msg = `⚠️ تذكير هام:\nنرجو دفع باقتك لرقم ${mask} لتجنب إيقاف خطك. مهلة باقتك اقتربت من الانتهاء!`;
                try {
                    await botInstance.sendMessage(b.owner_tg, msg);
                    sentCount++;
                } catch (e) { }
            }
        }

        res.json({ success: true, sent: sentCount });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Customer: all users list for admin dashboard
app.get('/api/customer/all-users', async (req, res) => {
    try {
        const linked = await dbAll(`
            SELECT owner_tg, owner_username, STRING_AGG(phone || '|' || gigabytes || '|' || renewal_day, ',') as details 
            FROM bookings 
            WHERE owner_tg IS NOT NULL AND deleted_at IS NULL 
            GROUP BY owner_tg, owner_username
        `);
        const unlinked = await dbAll(`
            SELECT phone, gigabytes, renewal_day 
            FROM bookings 
            WHERE owner_tg IS NULL AND deleted_at IS NULL
        `);
        res.json({ success: true, linked, unlinked });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Customer: unlink account from TG
app.post('/api/customer/unlink', async (req, res) => {
    try {
        let { phone, password, tg_id } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, error: 'بيانات ناقصة' });

        phone = phone.trim().replace(/\s/g, '');
        password = String(password).trim();

        const b = await dbGet(`SELECT id, owner_tg, password FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone]);
        if (!b) return res.status(404).json({ success: false, error: 'الرقم غير مسجل' });

        if (String(b.password).trim() !== password) return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة' });

        // Remove owner_tg so it stops showing in TG Dashboard, but keeps line in system
        await dbRun(`UPDATE bookings SET owner_tg = NULL, owner_username = NULL WHERE id = ?`, [b.id]);
        res.json({ success: true, message: 'تم إزالة الخط من حسابك بنجاح' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Customer: my accounts fetch by tg auth
app.get('/api/customer/me', async (req, res) => {
    try {
        const { tg_id } = req.query;
        if (!tg_id) return res.json({ success: true, data: [] });

        const myBookings = await dbAll(`SELECT id, phone, password, owner_id, owner_phone, name, gigabytes, renewal_day, status, last_usage_data, last_usage_at FROM bookings WHERE owner_tg = ? AND deleted_at IS NULL`, [String(tg_id)]);
        res.json({ success: true, data: myBookings });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Customer: create a payment request (renewal or first_time)
app.post('/api/customer/pay', async (req, res) => {
    try {
        const { booking_id, method, sender_phone, sender_name, transaction_ref, screenshot_base64, amount, payment_type, phone, password, gigabytes, renewal_day } = req.body;

        const isInsta = method === 'instapay' || String(method || '').toLowerCase().includes('insta') || String(method || '').includes('إنستا') || String(method || '').includes('انستا');
        const selectedMethod = isInsta ? 'instapay' : 'vodafone_cash';

        // 1. Validate payment details based on method
        if (!isInsta) {
            const cleanPhone = (sender_phone || '').trim().replace(/[\s\-\+]/g, '');
            if (!cleanPhone || cleanPhone.length !== 11 || !cleanPhone.startsWith('01')) {
                return res.status(400).json({
                    success: false,
                    error: 'يرجى إدخال رقم فودافون كاش صحيح مكون من 11 رقم تم التحويل منه (010XXXXXXXX)'
                });
            }
        } else {
            const cleanSenderName = (sender_name || sender_phone || '').trim();
            if (!cleanSenderName) {
                return res.status(400).json({
                    success: false,
                    error: 'يرجى إدخال اسم صاحب الحساب أو عنوان إنستا باي (IPA) المحول منه'
                });
            }
        }

        // 2. Screenshot proof is mandatory
        if (!screenshot_base64 || !screenshot_base64.trim()) {
            return res.status(400).json({
                success: false,
                error: 'يرجى إرفاق صورة / سكرين شوت إيصال التحويل لتأكيد العملية'
            });
        }

        const ym = currentMonth();
        const isFirstTime = payment_type === 'first_time';
        const screenshotUrl = screenshot_base64;
        const senderNameVal = isInsta ? (sender_name || sender_phone || '').trim() : null;
        const senderPhoneVal = (!isInsta ? (sender_phone || '').trim().replace(/[\s\-\+]/g, '') : (sender_phone || '').trim());

        if (isFirstTime) {
            // First time registration - no booking yet
            if (!phone || !gigabytes || !renewal_day) {
                return res.status(400).json({ success: false, error: 'بيانات الحجز ناقصة' });
            }
            const price = getPackagePrice(gigabytes);
            if (!price) return res.status(400).json({ success: false, error: 'باقة غير صحيحة' });

            // Determine active booking month for self-registration
            let bookingYm = ym;
            try {
                const bMonthRow = await dbGet(`SELECT setting_value FROM global_settings WHERE setting_key = 'active_booking_month'`);
                if (bMonthRow && bMonthRow.setting_value) {
                    bookingYm = bMonthRow.setting_value; // e.g. "2026-10"
                }
            } catch (ex) { }

            // Check if phone already exists in bookings
            const existingBooking = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone.trim()]);
            if (existingBooking) {
                return res.status(400).json({ success: false, error: 'هذا الرقم محجوز وموجود في النظام بالفعل. برجاء تسجيل الدخول بدلاً من الحجز الجديد.' });
            }

            // Check for closed days
            try {
                const closedRow = await dbGet(`SELECT setting_value FROM global_settings WHERE setting_key = 'closed_days'`);
                let closedDays = [];
                if (closedRow && closedRow.setting_value) {
                    try { closedDays = JSON.parse(closedRow.setting_value); } catch (ex) { }
                }
                const chosenDay = parseInt(renewal_day);
                if (closedDays.includes(chosenDay)) {
                    return res.status(400).json({
                        success: false,
                        error: `عذراً، تم الاكتفاء بحجوزات يوم ${chosenDay}. يرجى محاولة الحجز ليوم آخر أو الانتظار للشهر القادم.`
                    });
                }
            } catch (ignoreClosedDaysError) { }

            // Check if already has a pending first_time request
            const existingPending = await dbGet(
                `SELECT * FROM customer_payments WHERE phone = ? AND payment_type = 'first_time' AND status IN ('pending', 'needs_review')`,
                [phone.trim()]
            );
            if (existingPending) {
                return res.status(400).json({
                    success: false,
                    payment_id: existingPending.id,
                    status: existingPending.status,
                    pending: true,
                    error: 'يوجد طلب حجز قيد المراجعة بالفعل لهذا الرقم، سيتم مراجعته والتفعيل قريباً.'
                });
            }

            const result = await dbRun(
                `INSERT INTO customer_payments(
                    booking_id, year_month, amount, method, sender_phone, sender_name,
                    transaction_ref, screenshot_url, status, payment_type, phone,
                    password, gigabytes, renewal_day, owner_tg
                ) VALUES(NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', 'first_time', ?, ?, ?, ?, ?)`,
                [
                    bookingYm, price, selectedMethod, senderPhoneVal, senderNameVal,
                    (transaction_ref || '').trim(), screenshotUrl, phone.trim(),
                    (password || '').trim(), Number(gigabytes), Number(renewal_day),
                    req.body.owner_tg || null
                ]
            );

            return res.json({
                success: true,
                payment_id: result.lastID,
                status: 'pending',
                payment_type: 'first_time',
                message: 'تم إرسال طلب الحجز وإيصال الدفع بنجاح - جاري المراجعة والتأكيد'
            });
        }

        // Renewal payment
        if (!booking_id) return res.status(400).json({ success: false, error: 'بيانات ناقصة' });

        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`, [booking_id]);
        if (!booking) return res.status(404).json({ success: false, error: 'الرقم غير موجود' });

        let nextMonthToPay = ym;
        try {
            const sysMonthRow = await dbGet(`SELECT value FROM settings WHERE key = 'active_system_month'`);
            if (sysMonthRow && sysMonthRow.value) {
                const parsed = JSON.parse(sysMonthRow.value);
                if (parsed) nextMonthToPay = parsed;
            }
        } catch (ex) { }

        // Constraint 1: Check if already verified/paid for this month -> cannot submit another!
        const verifiedPayment = await dbGet(
            `SELECT * FROM customer_payments WHERE booking_id = ? AND year_month = ? AND status = 'verified'`,
            [booking_id, nextMonthToPay]
        );
        const monthlyPaid = await dbGet(
            `SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ? AND paid = 1`,
            [booking_id, nextMonthToPay]
        );
        if (verifiedPayment || monthlyPaid) {
            return res.status(400).json({
                success: false,
                error: 'تم سداد وتأكيد تجديد هذا الشهر بالفعل! باقتك مفعلة ولا يمكنك إرسال طلب جديد.',
                already_paid: true
            });
        }

        // Constraint 2: Check if pending/needs_review for this month -> cannot submit another!
        const existingPending = await dbGet(
            `SELECT * FROM customer_payments WHERE booking_id = ? AND year_month = ? AND status IN ('pending', 'needs_review')`,
            [booking_id, nextMonthToPay]
        );
        if (existingPending) {
            return res.status(400).json({
                success: false,
                payment_id: existingPending.id,
                status: existingPending.status,
                pending: true,
                error: 'يوجد طلب تجديد قيد المراجعة بالفعل لهذا الشهر، برجاء الانتظار حتى تنتهي المراجعة.'
            });
        }

        // Constraint 3: If rejected (or no prior payment for this month) -> allow inserting a new pending payment!
        const price = getPackagePrice(booking.gigabytes);
        const result = await dbRun(
            `INSERT INTO customer_payments(
                booking_id, year_month, amount, method, sender_phone, sender_name,
                transaction_ref, screenshot_url, status, payment_type, phone,
                gigabytes, renewal_day, owner_tg
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'renewal', ?, ?, ?, ?)`,
            [
                booking_id, nextMonthToPay, price || amount || 0, selectedMethod,
                senderPhoneVal, senderNameVal, (transaction_ref || '').trim(),
                screenshotUrl, booking.phone, booking.gigabytes, booking.renewal_day,
                booking.owner_tg || req.body.owner_tg || null
            ]
        );

        res.json({
            success: true,
            payment_id: result.lastID,
            status: 'pending',
            payment_type: 'renewal',
            message: 'تم إرسال طلب التجديد وإيصال التحويل بنجاح - جاري المراجعة والتأكيد'
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Customer: check payment status (polling endpoint)
app.get('/api/customer/payment-status', async (req, res) => {
    try {
        const { payment_id, booking_id } = req.query;
        let payment;
        if (payment_id) {
            payment = await dbGet(`SELECT * FROM customer_payments WHERE id = ?`, [payment_id]);
        } else if (booking_id) {
            const ym = currentMonth();
            payment = await dbGet(
                `SELECT * FROM customer_payments WHERE booking_id = ? AND year_month = ? ORDER BY created_at DESC LIMIT 1`,
                [booking_id, ym]
            );
        }

        if (!payment) return res.json({ success: true, status: 'none', message: 'لا يوجد طلب دفع' });

        // Check if payment has been pending for more than 3 minutes → auto-escalate to manual review
        const createdAt = new Date(payment.created_at);
        const now = new Date();
        const elapsedMinutes = (now - createdAt) / (1000 * 60);

        if (payment.status === 'pending' && elapsedMinutes > 3) {
            // Increment verification attempts
            await dbRun(
                `UPDATE customer_payments SET verification_attempts = verification_attempts + 1 WHERE id = ?`,
                [payment.id]
            );

            if (payment.verification_attempts >= 2 || elapsedMinutes > 5) {
                // After 5 mins or 2+ attempts → mark as needs_review
                await dbRun(
                    `UPDATE customer_payments SET status = 'needs_review', notes = 'فشل التحقق التلقائي - يحتاج مراجعة يدوية' WHERE id = ?`,
                    [payment.id]
                );
                return res.json({
                    success: true,
                    status: 'needs_review',
                    message: 'لم نتمكن من التحقق تلقائياً. تواصل مع الدعم لمراجعة التحويل.',
                    support_link: 'https://t.me/hak_alqulub',
                    elapsed_minutes: Math.round(elapsedMinutes)
                });
            }
        }

        res.json({
            success: true,
            status: payment.status,
            payment_id: payment.id,
            elapsed_minutes: Math.round(elapsedMinutes),
            message: payment.status === 'pending' ? 'جاري التحقق من التحويل...' :
                payment.status === 'verified' ? 'تم التحقق من الدفع بنجاح ✅' :
                    payment.status === 'needs_review' ? 'يحتاج مراجعة يدوية' :
                        payment.status === 'rejected' ? 'تم رفض الدفعة ❌' : payment.status
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin/Payment gateway callback: verify a payment
app.post('/api/customer/verify-payment', async (req, res) => {
    try {
        const { payment_id, action } = req.body; // action: 'approve' or 'reject'
        if (!payment_id || !action) return res.status(400).json({ success: false, error: 'بيانات ناقصة' });

        const payment = await dbGet(`SELECT * FROM customer_payments WHERE id = ?`, [payment_id]);
        if (!payment) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });

        let tgId = payment.phone; // Fallback
        let tgPhone = payment.phone;
        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [payment.booking_id]);

        if (action === 'approve') {
            // Mark customer payment as verified
            await dbRun(
                `UPDATE customer_payments SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [payment_id]
            );

            let targetBookingId = payment.booking_id;

            if (payment.payment_type === 'first_time' && !targetBookingId) {
                // We MUST create the booking now that it is approved!
                const newBooking = await dbRun(
                    `INSERT INTO bookings(phone, password, gigabytes, status, renewal_day, created_at) VALUES(?, ?, ?, 'محجوز', ?, CURRENT_TIMESTAMP)`,
                    [payment.phone, payment.password || '1234', payment.gigabytes, payment.renewal_day || 7]
                );
                targetBookingId = newBooking.lastID;
                // Also update the customer payment so it's linked
                await dbRun(`UPDATE customer_payments SET booking_id = ? WHERE id = ?`, [targetBookingId, payment_id]);
                // Re-fetch booking for notifications
                booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [targetBookingId]);
            }

            // Also mark the monthly payment as paid
            if (targetBookingId) {
                const existing = await dbGet(
                    `SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ?`,
                    [targetBookingId, payment.year_month]
                );
                if (existing) {
                    await dbRun(
                        `UPDATE monthly_payments SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND year_month = ?`,
                        [targetBookingId, payment.year_month]
                    );
                } else {
                    await dbRun(
                        `INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP)`,
                        [targetBookingId, booking?.renewal_day || payment.renewal_day || 7, payment.year_month]
                    );
                }
            }

            // SEND NOTIFICATION
            try {
                if (booking && booking.owner_tg) tgId = booking.owner_tg;
                const botInstance = await getBot();
                if (botInstance && tgId) {
                    const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';
                    await botInstance.sendMessage(tgId, `تأكيد الدفع ✅\nمرحباً، تم تأكيد استلام دفعتك بقيمة ${payment.amount} ج.م لرقم ${booking ? booking.phone : payment.phone}.\nبذلك أصبح حسابك مجدداً وصالحاً بالكامل! شكراً لك. 🎉`, {
                        reply_markup: { inline_keyboard: [[{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }]] }
                    }).catch(() => { });
                }
            } catch (err) { }

            res.json({ success: true, message: 'تم قبول الدفعة وتسجيلها' });
        } else if (action === 'reject') {
            const reason = req.body.reason || 'البيانات غير صحيحة';
            await dbRun(
                `UPDATE customer_payments SET status = 'rejected', notes = ?, reject_reason = ? WHERE id = ?`,
                [reason, reason, payment_id]
            );

            // SEND NOTIFICATION
            try {
                if (booking && booking.owner_tg) tgId = booking.owner_tg;
                else if (payment.owner_tg) tgId = payment.owner_tg;
                const botInstance = await getBot();
                if (botInstance && tgId) {
                    const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';
                    const targetPhone = booking ? booking.phone : payment.phone;
                    const msg = `❌ *رفض طلب الدفع*\n\nعزيزي العميل، تم رفض إيصال التحويل لخطك (${targetPhone}).\n\n📌 *سبب الرفض:*\n${reason}\n\n💡 *ماذا تفعل الآن؟*\nيمكنك الآن فتح التطبيق وإعادة إرسال صورة التحويل الصحيحة لإعادة مراجعتها وتأكيدها فوراً.`;
                    await botInstance.sendMessage(tgId, msg, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📱 فتح التطبيق وإعادة الإرسال', web_app: { url: webAppUrl } }],
                                [{ text: '💬 تواصل مع الدعم الفني', url: 'https://t.me/hak_alqulub' }]
                            ]
                        }
                    }).catch(() => { });
                }
            } catch (err) { }

            res.json({ success: true, message: 'تم رفض الدفعة' });
        } else {
            res.status(400).json({ success: false, error: 'إجراء غير صالح' });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: get all pending payments for review
app.get('/api/customer/pending-payments', async (req, res) => {
    try {
        const payments = await dbAll(
            `SELECT cp.*, 
                    b.phone as b_phone, 
                    b.gigabytes as b_giga, 
                    b.renewal_day as b_day, 
                    b.owner_tg, 
                    b.owner_username 
             FROM customer_payments cp 
             LEFT JOIN bookings b ON cp.booking_id = b.id 
             WHERE cp.status IN ('pending', 'needs_review') 
             ORDER BY cp.created_at DESC`
        );
        for (let p of payments) {
            // Unify fields
            p.phone = p.phone || p.b_phone;
            p.gigabytes = p.gigabytes || p.b_giga;
            p.renewal_day = p.renewal_day || p.b_day;

            p.renewal_count = 0;
            p.other_numbers = '';

            if (p.booking_id) {
                const cnt = await dbGet(`SELECT COUNT(*)::int as c FROM monthly_payments WHERE booking_id = $1 AND paid = 1`, [p.booking_id]);
                p.renewal_count = cnt ? cnt.c : 0;
            }

            if (p.owner_tg) {
                const others = await dbAll(`SELECT phone FROM bookings WHERE owner_tg = $1 AND deleted_at IS NULL`, [p.owner_tg]);
                p.other_numbers = others.map(o => o.phone).join(' / ');
            }
        }
        res.json({ success: true, data: payments });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// PayGeta Webhook/Callback (to be configured in PayGeta dashboard)
app.post('/api/payment/callback', async (req, res) => {
    try {
        // PayGeta sends payment confirmation
        const { order_id, status, transaction_id } = req.body;
        console.log('PayGeta Callback:', req.body);

        if (status === 'paid' || status === 'success') {
            // Find matching customer payment by transaction_ref
            const payment = await dbGet(
                `SELECT * FROM customer_payments WHERE transaction_ref = ? AND status = 'pending'`,
                [transaction_id || order_id]
            );
            if (payment) {
                await dbRun(
                    `UPDATE customer_payments SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [payment.id]
                );
                // Mark monthly payment
                const existing = await dbGet(
                    `SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ?`,
                    [payment.booking_id, payment.year_month]
                );
                if (existing) {
                    await dbRun(
                        `UPDATE monthly_payments SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND year_month = ?`,
                        [payment.booking_id, payment.year_month]
                    );
                } else {
                    const booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [payment.booking_id]);
                    await dbRun(
                        `INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP)`,
                        [payment.booking_id, booking?.renewal_day || 7, payment.year_month]
                    );
                }
            }
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Payment callback error:', e);
        res.status(500).json({ success: false });
    }
});

// ============================================ //
// React Admin Dashboard Required APIs
// ============================================ //

app.get('/api/trash', async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM bookings WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/trash/empty', async (req, res) => {
    try {
        await dbRun(`DELETE FROM bookings WHERE deleted_at IS NOT NULL`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/trash/:id', async (req, res) => {
    try {
        await dbRun(`DELETE FROM bookings WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/trash/:id/restore', async (req, res) => {
    try {
        await dbRun(`UPDATE bookings SET deleted_at = NULL WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/settings', async (req, res) => {
    try {
        const rows = await dbAll(`SELECT * FROM settings`);
        const settings = rows.reduce((acc, r) => {
            let parsed = r.value;
            try { parsed = JSON.parse(r.value); } catch (e) { }
            acc[r.key] = parsed;
            return acc;
        }, {});

        // Mask sensitive fields so they are never exposed publicly
        const rawToken = process.env.BOT_TOKEN || settings.telegram_token || '';
        const cleanToken = String(rawToken).trim().replace(/^"|"$/g, '');
        if (cleanToken && cleanToken.length > 10) {
            settings.bot_token_configured = true;
            settings.bot_token_masked = cleanToken.slice(0, 6) + '••••:••••••••' + cleanToken.slice(-4);
            settings.bot_token_source = process.env.BOT_TOKEN ? 'vercel_env' : 'database';
        } else {
            settings.bot_token_configured = false;
            settings.bot_token_masked = '';
            settings.bot_token_source = 'none';
        }
        delete settings.telegram_token;
        delete settings.admin_password;

        res.json({ success: true, data: settings });
    } catch (e) {
        if (e.message.includes('relation "settings" does not exist') || e.message.includes('no such table')) {
            await dbRun(`CREATE TABLE IF NOT EXISTS settings (key VARCHAR PRIMARY KEY, value TEXT)`);
            res.json({ success: true, data: {} });
        } else {
            res.status(500).json({ success: false, error: e.message });
        }
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        let { key, value } = req.body;
        if (key === 'telegram_token') {
            value = String(value || '').trim().replace(/^"|"$/g, '');
        }
        const valStr = JSON.stringify(value);

        let result;
        try {
            result = await dbRun(`UPDATE settings SET value = ? WHERE key = ?`, [valStr, key]);
        } catch (e) {
            if (e.message.includes('relation "settings" does not exist') || e.message.includes('no such table')) {
                await dbRun(`CREATE TABLE IF NOT EXISTS settings (key VARCHAR PRIMARY KEY, value TEXT)`);
                result = { changes: 0 };
            } else throw e;
        }

        if (result.changes === 0) {
            await dbRun(`INSERT INTO settings (key, value) VALUES (?, ?)`, [key, valStr]);
        }

        if (key === 'telegram_token') {
            activeBot = null;
            activeBotToken = null;
            try {
                const botInstance = await getBot();
                if (botInstance) {
                    let url = process.env.WEBAPP_URL || `https://${req.headers.host}`;
                    if (url.endsWith('/')) url = url.substring(0, url.length - 1);
                    await botInstance.setWebHook(`${url}/api/webhook`);
                }
            } catch (hookErr) {
                console.error('Webhook set error:', hookErr.message);
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});




app.get('/api/payments/pending', async (req, res) => {
    try {
        const payments = await dbAll(
            `SELECT cp.*, 
                    COALESCE(cp.phone, b.phone) as phone, 
                    COALESCE(cp.gigabytes, b.gigabytes) as gigabytes, 
                    COALESCE(cp.renewal_day, b.renewal_day) as renewal_day,
                    b.owner_tg,
                    b.owner_username
             FROM customer_payments cp 
             LEFT JOIN bookings b ON cp.booking_id = b.id 
             WHERE cp.status IN ('pending', 'needs_review') 
             ORDER BY cp.created_at DESC`
        );
        for (let p of payments) {
            p.renewal_count = 0;
            p.other_numbers = '';
            if (p.booking_id) {
                const cnt = await dbGet(`SELECT COUNT(*)::int as c FROM monthly_payments WHERE booking_id = $1 AND paid = 1`, [p.booking_id]);
                p.renewal_count = cnt ? cnt.c : 0;
            }
            const tg = p.owner_tg;
            if (tg) {
                const others = await dbAll(`SELECT phone FROM bookings WHERE owner_tg = $1 AND deleted_at IS NULL`, [tg]);
                p.other_numbers = others.map(o => o.phone).join(' / ');
            }
        }
        res.json({ success: true, data: payments });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Get all payments (with history for admin)
app.get('/api/payments/all', async (req, res) => {
    try {
        const payments = await dbAll(
            `SELECT cp.*, 
                    COALESCE(cp.phone, b.phone) as phone, 
                    COALESCE(cp.gigabytes, b.gigabytes) as gigabytes, 
                    COALESCE(cp.renewal_day, b.renewal_day) as renewal_day,
                    b.owner_tg,
                    b.owner_username
             FROM customer_payments cp 
             LEFT JOIN bookings b ON cp.booking_id = b.id 
             ORDER BY cp.created_at DESC LIMIT 300`
        );
        for (let p of payments) {
            p.renewal_count = 0;
            p.other_numbers = '';
            if (p.booking_id) {
                const cnt = await dbGet(`SELECT COUNT(*)::int as c FROM monthly_payments WHERE booking_id = $1 AND paid = 1`, [p.booking_id]);
                p.renewal_count = cnt ? cnt.c : 0;
            }
            const tg = p.owner_tg;
            if (tg) {
                const others = await dbAll(`SELECT phone FROM bookings WHERE owner_tg = $1 AND deleted_at IS NULL`, [tg]);
                p.other_numbers = others.map(o => o.phone).join(' / ');
            }
        }
        res.json({ success: true, data: payments });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Get renewal history for a specific phone number
app.get('/api/payments/history', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });

        const booking = await dbGet(`SELECT * FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone]);
        if (!booking) return res.json({ success: true, data: { renewals: 0, first_date: null, payments: [] } });

        const renewalCount = await dbGet(`SELECT COUNT(*)::int as cnt FROM monthly_payments WHERE booking_id = ? AND paid = 1`, [booking.id]);
        const firstPayment = await dbGet(`SELECT MIN(year_month) as first_month FROM monthly_payments WHERE booking_id = ? AND paid = 1`, [booking.id]);
        const payments = await dbAll(`SELECT * FROM customer_payments WHERE booking_id = ? ORDER BY created_at DESC`, [booking.id]);

        res.json({
            success: true,
            data: {
                renewals: renewalCount?.cnt || 0,
                first_date: booking.created_at,
                first_month: firstPayment?.first_month || null,
                payments
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/payments/:id/approve', async (req, res) => {
    try {
        const payment_id = req.params.id;
        const payment = await dbGet(`SELECT * FROM customer_payments WHERE id = ?`, [payment_id]);
        if (!payment) return res.status(404).json({ success: false, error: 'الدفعة غير موجودة' });

        const payYm = payment.year_month || currentMonth();
        await dbRun(`UPDATE customer_payments SET status = 'verified', year_month = ?, reject_reason = NULL, verified_at = CURRENT_TIMESTAMP WHERE id = ?`, [payYm, payment_id]);

        let targetBookingId = payment.booking_id;
        if (!targetBookingId && payment.phone) {
            const bFound = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [payment.phone.trim()]);
            if (bFound) targetBookingId = bFound.id;
        }

        let booking = null;

        if (payment.payment_type === 'first_time') {
            // FIRST TIME: Create the booking now or find existing
            const existingBooking = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [payment.phone]);
            if (existingBooking) {
                targetBookingId = existingBooking.id;
                await dbRun(`UPDATE bookings SET status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [targetBookingId]);
                const existing = await dbGet(`SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [targetBookingId, payYm]);
                if (existing) {
                    await dbRun(`UPDATE monthly_payments SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE id = ?`, [existing.id]);
                } else {
                    await dbRun(`INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at, activated) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP, 0)`, [targetBookingId, payment.renewal_day || 7, payYm]);
                }
                await dbRun(`UPDATE customer_payments SET booking_id = ? WHERE id = ?`, [targetBookingId, payment_id]);
            } else {
                const bookingResult = await dbRun(
                    `INSERT INTO bookings(phone, password, gigabytes, renewal_day, status, created_at) VALUES(?, ?, ?, ?, 'محجوز', CURRENT_TIMESTAMP)`,
                    [payment.phone, payment.password || '1234', Number(payment.gigabytes), Number(payment.renewal_day || 7)]
                );
                targetBookingId = bookingResult.lastID;
                // Mark first month as paid
                await dbRun(
                    `INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at, activated) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP, 0)`,
                    [targetBookingId, Number(payment.renewal_day || 7), payYm]
                );
                await dbRun(`UPDATE customer_payments SET booking_id = ? WHERE id = ?`, [targetBookingId, payment_id]);
            }
            booking = await dbGet(`SELECT * FROM bookings WHERE id = ?`, [targetBookingId]);
        } else {
            // RENEWAL: Mark monthly payment as paid
            booking = targetBookingId ? await dbGet(`SELECT * FROM bookings WHERE id = ?`, [targetBookingId]) : null;
            if (booking) {
                if (booking.next_gigabytes && Number(booking.next_gigabytes) > 0) {
                    const newGB = Number(booking.next_gigabytes);
                    await dbRun(`UPDATE bookings SET gigabytes = ?, next_gigabytes = NULL, next_quota_notes = NULL, status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newGB, targetBookingId]);
                    try {
                        const owner = await dbGet(`SELECT * FROM owners WHERE id = ? OR phone = ?`, [booking.owner_id, booking.owner_phone]);
                        if (owner && owner.password) {
                            await redistributeMemberQuotaOnVodafone(owner, booking.phone, newGB);
                        }
                    } catch (_) {}
                } else {
                    await dbRun(`UPDATE bookings SET status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [targetBookingId]);
                }
            }
            if (targetBookingId) {
                const existing = await dbGet(`SELECT * FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [targetBookingId, payYm]);
                if (existing) {
                    await dbRun(`UPDATE monthly_payments SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE id = ?`, [existing.id]);
                } else {
                    const rDay = booking?.renewal_day || payment.renewal_day || 7;
                    await dbRun(`INSERT INTO monthly_payments(booking_id, renewal_day, year_month, paid, paid_at, activated) VALUES(?, ?, ?, 1, CURRENT_TIMESTAMP, 0)`, [targetBookingId, rDay, payYm]);
                }
                await dbRun(`UPDATE customer_payments SET booking_id = ? WHERE id = ?`, [targetBookingId, payment_id]);
            }
        }

        // Send Telegram Notification
        try {
            const tgId = (booking && booking.owner_tg) || payment.owner_tg;
            const botInstance = await getBot();
            if (botInstance && tgId) {
                const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';
                await botInstance.sendMessage(tgId, `تأكيد الدفع ✅\nمرحباً، تم تأكيد استلام دفعتك بقيمة ${payment.amount} ج.م لرقم ${booking ? booking.phone : payment.phone}.\nبذلك أصبح اشتراكك مجدداً وصالحاً بالكامل! شكراً لك. 🎉`, {
                    reply_markup: { inline_keyboard: [[{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }]] }
                }).catch(() => { });
            }
        } catch (err) { }

        res.json({ success: true, message: 'تم قبول الدفعة وتسجيلها بنجاح ✅', booking_id: targetBookingId });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/payments/:id/reject', async (req, res) => {
    try {
        const reason = req.body.reason || 'مرفوض';
        await dbRun(`UPDATE customer_payments SET status = 'rejected', notes = ?, reject_reason = ? WHERE id = ?`, [reason, reason, req.params.id]);

        // Send Telegram Notification
        try {
            const payment = await dbGet(`SELECT * FROM customer_payments WHERE id = ?`, [req.params.id]);
            let booking = payment?.booking_id ? await dbGet(`SELECT * FROM bookings WHERE id = ?`, [payment.booking_id]) : null;
            const tgId = (booking && booking.owner_tg) || payment?.owner_tg;
            const botInstance = await getBot();
            if (botInstance && tgId) {
                const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';
                const targetPhone = booking ? booking.phone : payment?.phone;
                const msg = `❌ *رفض طلب الدفع*\n\nعزيزي العميل، تم رفض إيصال التحويل لخطك (${targetPhone}).\n\n📌 *سبب الرفض:*\n${reason}\n\n💡 *ماذا تفعل الآن؟*\nيمكنك الآن فتح التطبيق وإعادة إرسال صورة التحويل الصحيحة لإعادة مراجعتها وتأكيدها فوراً.`;
                await botInstance.sendMessage(tgId, msg, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📱 فتح التطبيق وإعادة الإرسال', web_app: { url: webAppUrl } }],
                            [{ text: '💬 تواصل مع الدعم الفني', url: 'https://t.me/hak_alqulub' }]
                        ]
                    }
                }).catch(() => { });
            }
        } catch (err) { }

        res.json({ success: true, message: 'تم رفض الدفعة وإرسال السبب للمستخدم' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Cycle 6 Lines Management
app.get('/api/admin/cycle-six-lines', async (req, res) => {
    try {
        const { filter } = req.query;
        const ym = currentMonth();
        const bookings = await dbAll(`SELECT * FROM bookings WHERE deleted_at IS NULL AND (status IS NULL OR status != 'متكنسل') ORDER BY renewal_day ASC, created_at ASC`);
        if (!bookings.length) return res.json({ success: true, data: [] });

        const ids = bookings.map(b => b.id);
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const counts = await dbAll(`SELECT booking_id, COUNT(*)::int as cnt FROM monthly_payments WHERE booking_id IN (${placeholders}) AND paid = 1 GROUP BY booking_id`, ids);
        const countMap = {};
        counts.forEach(r => countMap[r.booking_id] = r.cnt);

        const currentPays = await dbAll(`SELECT * FROM monthly_payments WHERE booking_id IN (${placeholders}) AND year_month = $${ids.length + 1}`, [...ids, ym]);
        const payMap = {};
        currentPays.forEach(r => payMap[r.booking_id] = r);

        const result = bookings.map(b => {
            const renewalCount = countMap[b.id] || 0;
            const completedCycles = Math.floor(renewalCount / 6);
            const remainder = renewalCount % 6;

            let cycleStatus = 'normal';
            if (remainder === 5) {
                cycleStatus = 'in_month_6'; // في الشهر السادس والأخير من الدورة
            } else if (renewalCount >= 6 && remainder === 0) {
                cycleStatus = 'completed_cycle'; // أتم 6 شهور بالكامل (دورة مكتملة)
            }

            return {
                ...b,
                renewal_count: renewalCount,
                completed_cycles: completedCycles,
                month_in_cycle: remainder === 0 && renewalCount > 0 ? 6 : remainder + 1,
                cycle_status: cycleStatus,
                paid_this_month: payMap[b.id]?.paid === 1,
                current_payment: payMap[b.id] || null
            };
        }).filter(b => {
            if (filter === 'month6') return b.cycle_status === 'in_month_6';
            if (filter === 'completed') return b.cycle_status === 'completed_cycle';
            return b.cycle_status === 'in_month_6' || b.cycle_status === 'completed_cycle';
        });

        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/send-cycle-six-reminder', async (req, res) => {
    try {
        const { booking_id, custom_message } = req.body;
        if (!booking_id) return res.status(400).json({ success: false, error: 'معرف الخط مطلوب' });

        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`, [booking_id]);
        if (!booking) return res.status(404).json({ success: false, error: 'الخط غير موجود' });
        if (!booking.owner_tg) return res.status(400).json({ success: false, error: 'هذا الرقم غير مربوط بحساب تليجرام' });

        const botInstance = await getBot();
        if (!botInstance) return res.status(500).json({ success: false, error: 'بوت تليجرام غير متاح' });

        let template = custom_message;
        if (!template) {
            const tmplRow = await dbGet(`SELECT value FROM settings WHERE key = 'sixth_month_reminder_template'`);
            if (tmplRow && tmplRow.value) {
                try { template = JSON.parse(tmplRow.value); } catch (e) { template = tmplRow.value; }
            }
        }
        if (!template) {
            template = "⚠️ *تنبيه دورة التجديد السادسة والأخيرة*\n\nعزيزي العميل،\nنحيطك علماً بأن باقة الخط {phone} قد وصلت إلى *الشهر السادس* (نهاية دورة الـ 6 شهور).\nهذا هو الشهر الأخير في دورتك الحالية.\nبعد انتهاء هذا الشهر، يمكنك اختيار الخروج من النظام أو تجديد دورة جديدة لمدة 6 شهور أخرى.\n\nلأي استفسار يرجى التواصل مع الدعم الفني.";
        }

        const msg = template
            .replace(/\{phone\}/g, booking.phone)
            .replace(/\{giga\}/g, String(booking.gigabytes || ''))
            .replace(/\{renewal_day\}/g, String(booking.renewal_day || ''))
            .replace(/\{owner_username\}/g, booking.owner_username ? `@${booking.owner_username}` : 'عزيزي العميل');

        const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';
        await botInstance.sendMessage(booking.owner_tg, msg, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📱 فتح التطبيق', web_app: { url: webAppUrl } }],
                    [{ text: '💬 تواصل مع الدعم الفني', url: 'https://t.me/hak_alqulub' }]
                ]
            },
            parse_mode: 'Markdown'
        });

        res.json({ success: true, message: `تم إرسال تنبيه الشهر السادس إلى ${booking.phone} بنجاح` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admins', async (req, res) => {
    try {
        const admins = await dbAll(`SELECT * FROM bot_admins ORDER BY id ASC`);
        res.json({ success: true, data: admins });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/admins', async (req, res) => {
    try {
        const { tg_id, name } = req.body;
        const result = await dbRun(`INSERT INTO bot_admins(tg_id, name) VALUES(?, ?)`, [tg_id, name || '']);
        res.json({ success: true, data: await dbGet(`SELECT * FROM bot_admins WHERE id = ?`, [result.lastID]) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/admins/:id', async (req, res) => {
    try {
        await dbRun(`DELETE FROM bot_admins WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// local testing
if (require.main === module) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🚀 API running on port ${port}`));
}

module.exports = app;

// ============================================ //
//                  CRON JOBS & SETTINGS        //
// ============================================ //

// Admin endpoint to get/set closed days for new bookings
app.get('/api/admin/closed-days', async (req, res) => {
    try {
        const row = await dbGet(`SELECT setting_value FROM global_settings WHERE setting_key = 'closed_days'`);
        const days = (row && row.setting_value) ? JSON.parse(row.setting_value) : [];
        res.json({ success: true, closed_days: days });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/closed-days', async (req, res) => {
    try {
        const { days } = req.body;
        if (!Array.isArray(days)) return res.status(400).json({ error: 'Days must be an array' });

        const val = JSON.stringify(days);
        const row = await dbGet(`SELECT setting_value FROM global_settings WHERE setting_key = 'closed_days'`);
        if (row) {
            await dbRun(`UPDATE global_settings SET setting_value = ? WHERE setting_key = 'closed_days'`, [val]);
        } else {
            await dbRun(`INSERT INTO global_settings (setting_key, setting_value) VALUES ('closed_days', ?)`, [val]);
        }
        res.json({ success: true, message: 'تم التحديث بنجاح' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/cron', async (req, res) => {
    // Vercel cron calls this route automatically
    try {
        const reminderResult = await sendDailyRenewalReminders();
        await checkPendingInvitations().catch(() => {});
        const botInstance = await getBot();

        const superAdminId = '1255885099';
        const today = new Date().getDate();

        // 1 day before warnings for Super Admin
        const day1Warnings = [];
        const bookingsList = await dbAll(`SELECT * FROM bookings WHERE status = 'متأكتف' AND deleted_at IS NULL`);
        const ym = currentMonth();

        for (const b of bookingsList) {
            const payRow = await dbGet(`SELECT paid FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [b.id, ym]);
            if (payRow && payRow.paid === 1) continue;
            if (b.renewal_day - today === 1) {
                day1Warnings.push(`📱 \`${b.phone}\` | ${b.next_gigabytes || b.gigabytes}G | التجديد غداً`);
            }
        }

        // Send summary to Super Admin
        if (botInstance && day1Warnings.length > 0) {
            let adminMsg = `🚨 *تقرير تلقائي: خطوط تتجدد غداً ولم يتم الدفع لها!*\n\n`;
            adminMsg += day1Warnings.join('\n');
            adminMsg += `\n\nيُرجى اتخاذ اللازم.`;
            try {
                await botInstance.sendMessage(superAdminId, adminMsg, { parse_mode: 'Markdown' });
            } catch (e) { }
        }

        res.json({
            success: true,
            message: 'تم تنفيذ المهام المجدولة اليومية',
            sentReminders: reminderResult.sent || 0,
            skippedPaid: reminderResult.skippedPaid || 0,
            adminAlertLists: day1Warnings.length
        });

    } catch (e) {
        console.error('Cron Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// Duplicate /api/admin/check-password removed (defined above)
