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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bookings (
            id SERIAL PRIMARY KEY,
            phone TEXT NOT NULL,
            password TEXT NOT NULL,
            gigabytes INTEGER NOT NULL,
            renewal_day INTEGER NOT NULL,
            status TEXT DEFAULT 'محجوز',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            deleted_at TIMESTAMP,
            owner_tg TEXT
        );
        CREATE TABLE IF NOT EXISTS monthly_payments (
            id SERIAL PRIMARY KEY,
            booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
            renewal_day INTEGER NOT NULL,
            year_month TEXT NOT NULL,
            paid INTEGER DEFAULT 0,
            paid_at TIMESTAMP,
            activated INTEGER DEFAULT 0,
            activated_at TIMESTAMP,
            UNIQUE(booking_id, year_month)
        );
        CREATE TABLE IF NOT EXISTS bot_admins (
            id SERIAL PRIMARY KEY,
            tg_id TEXT UNIQUE NOT NULL,
            name TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS booking_chats (
            id SERIAL PRIMARY KEY,
            booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
            sender TEXT,
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS customer_payments (
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
            notes TEXT
        );
    `);

    // Add columns to existing schema safely
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='bookings' and column_name='deleted_at') THEN
                ALTER TABLE bookings ADD COLUMN deleted_at TIMESTAMP;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='bookings' and column_name='owner_tg') THEN
                ALTER TABLE bookings ADD COLUMN owner_tg TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='bookings' and column_name='owner_username') THEN
                ALTER TABLE bookings ADD COLUMN owner_username TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='screenshot_url') THEN
                ALTER TABLE customer_payments ADD COLUMN screenshot_url TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='payment_type') THEN
                ALTER TABLE customer_payments ADD COLUMN payment_type TEXT DEFAULT 'renewal';
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='phone') THEN
                ALTER TABLE customer_payments ADD COLUMN phone TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='password') THEN
                ALTER TABLE customer_payments ADD COLUMN password TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='gigabytes') THEN
                ALTER TABLE customer_payments ADD COLUMN gigabytes INTEGER;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='renewal_day') THEN
                ALTER TABLE customer_payments ADD COLUMN renewal_day INTEGER;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='sender_name') THEN
                ALTER TABLE customer_payments ADD COLUMN sender_name TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='reject_reason') THEN
                ALTER TABLE customer_payments ADD COLUMN reject_reason TEXT;
            END IF;
            IF NOT EXISTS(SELECT * FROM information_schema.columns WHERE table_name='customer_payments' and column_name='owner_tg') THEN
                ALTER TABLE customer_payments ADD COLUMN owner_tg TEXT;
            END IF;
        END $$;
    `);

    // Reset sequences after migration to prevent primary key constraint errors
    await pool.query(`
        -- Data Migration: Ensure year_month is always padded (2026-9 -> 2026-09)
        UPDATE monthly_payments SET year_month = substring(year_month from 1 for 5) || '0' || substring(year_month from 6) WHERE length(year_month) = 6 AND year_month LIKE '%-%';
        UPDATE customer_payments SET year_month = substring(year_month from 1 for 5) || '0' || substring(year_month from 6) WHERE length(year_month) = 6 AND year_month LIKE '%-%';

        -- Seed 6th month reminder template if not exists
        INSERT INTO settings(key, value) VALUES (
            'sixth_month_reminder_template', 
            '"⚠️ *تنبيه دورة التجديد السادسة والأخيرة*\n\nعزيزي العميل،\nنحيطك علماً بأن باقة الخط {phone} قد وصلت إلى *الشهر السادس* (نهاية دورة الـ 6 شهور).\nهذا هو الشهر الأخير في دورتك الحالية.\nبعد انتهاء هذا الشهر، يمكنك اختيار الخروج من النظام أو تجديد دورة جديدة لمدة 6 شهور أخرى.\n\nلأي استفسار يرجى التواصل مع الدعم الفني."'
        ) ON CONFLICT (key) DO NOTHING;

        SELECT setval('bookings_id_seq', COALESCE((SELECT MAX(id)+1 FROM bookings), 1), false);
        SELECT setval('monthly_payments_id_seq', COALESCE((SELECT MAX(id)+1 FROM monthly_payments), 1), false);
        SELECT setval('bot_admins_id_seq', COALESCE((SELECT MAX(id)+1 FROM bot_admins), 1), false);
    `).catch(err => {
        console.error('Sequence update ignored:', err.message);
    });
}
// Init DB purely async (won't block export but runs on first cold start)
initDB().catch(e => console.error('DB Init Error:', e));

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

// Package prices
const PACKAGE_PRICES = { 20: 250, 30: 350, 40: 450, 60: 600, 70: 700, 85: 800 };
function getPackagePrice(gigs) { return PACKAGE_PRICES[parseInt(gigs)] || 0; }

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

app.get('/api/bookings', async (req, res) => {
    try {
        const { renewal_day, status, search, include_deleted } = req.query;
        let sql = `SELECT b.*, 
            (SELECT COUNT(id)::int FROM booking_chats WHERE booking_id = b.id) as chats_count,
            (SELECT COUNT(*)::int FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as renewal_count,
            (SELECT MIN(mp.year_month) FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as first_paid_month,
            (SELECT MAX(mp.year_month) FROM monthly_payments mp WHERE mp.booking_id = b.id AND mp.paid = 1) as latest_paid_month
            FROM bookings b WHERE 1=1`;
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
        const { phone, password, gigabytes, renewal_day, added_month_override, created_at, previous_renewals_count, status } = req.body;
        if (!phone || !password || !gigabytes || !renewal_day) return res.status(400).json({ success: false, error: 'جميع الحقول مطلوبة' });

        const existing = await dbGet(`SELECT id FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone.trim()]);
        if (existing) return res.status(400).json({ success: false, error: 'هذا الرقم محجوز مسبقاً' });

        let createdAtVal = new Date().toISOString();
        if (created_at) {
            createdAtVal = new Date(created_at).toISOString();
        } else if (added_month_override) {
            createdAtVal = new Date(`${added_month_override}-01T00:00:00Z`).toISOString();
        }

        const initialStatus = status || 'متأكتف';
        const result = await dbRun(
            `INSERT INTO bookings(phone, password, gigabytes, renewal_day, status, created_at) VALUES(?, ?, ?, ?, ?, ?)`,
            [phone.trim(), password.trim(), Number(gigabytes), Number(renewal_day), initialStatus, createdAtVal]
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
        const { phone, password, gigabytes, renewal_day, status, owner_tg, owner_username, created_at, previous_renewals_count } = req.body;

        let newCreatedAt = b.created_at;
        if (created_at) {
            newCreatedAt = new Date(created_at).toISOString();
        }

        const newRenewalDay = Number(renewal_day || b.renewal_day);
        const oldRenewalDay = Number(b.renewal_day);

        await dbRun(
            `UPDATE bookings SET phone =?, password =?, gigabytes =?, renewal_day =?, status =?, created_at =?, updated_at = CURRENT_TIMESTAMP, owner_tg = COALESCE(?, owner_tg), owner_username = COALESCE(?, owner_username) WHERE id =? `,
            [
                phone || b.phone, 
                password || b.password, 
                Number(gigabytes || b.gigabytes), 
                newRenewalDay, 
                status || b.status, 
                newCreatedAt,
                owner_tg || null, 
                owner_username || null, 
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

async function fetchAllData(token, cookies, msisdn) {
    const h = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Cookie: cookies.join("; "),
        Referer: "https://web.vodafone.com.eg/spa/myHome",
        Origin: "https://web.vodafone.com.eg",
        msisdn,
    };

    const endpoints = [
        { key: "balance", url: "https://web.vodafone.com.eg/services/DigitalExperience/prepaid/balance" },
        { key: "billing", url: "https://web.vodafone.com.eg/services/DigitalExperience/billing/balance" },
        { key: "billOverview", url: "https://web.vodafone.com.eg/services/DigitalExperience/billing/billOverview" },
        { key: "usage", url: "https://web.vodafone.com.eg/services/DigitalExperience/usage/summary" },
        { key: "subscriptions", url: "https://web.vodafone.com.eg/services/DigitalExperience/subscriptions" }
    ];

    const results = {};
    const settled = await Promise.allSettled(
        endpoints.map(async (ep) => {
            try {
                // simple fetch with 10s timeout using AbortController if available
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                const r = await fetch(ep.url, { headers: h, signal: controller.signal });
                clearTimeout(timeout);
                if (r.ok) {
                    const ct = r.headers.get("content-type") || "";
                    if (ct.includes("json")) return { key: ep.key, data: await r.json() };
                }
                return { key: ep.key, data: null };
            } catch (e) { return { key: ep.key, data: null }; }
        })
    );
    for (const s of settled) {
        if (s.status === "fulfilled" && s.value.data) results[s.value.key] = s.value.data;
    }
    return results;
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

    // 1. Initial Page
    const pageRes = await fetch(authUrl.toString(), { redirect: "manual", headers: { "User-Agent": ua, Accept: "text/html" } });
    const cookies = [];
    const getSetCookieFn = pageRes.headers.getSetCookie;
    const rawCookies = (typeof getSetCookieFn === 'function') ? pageRes.headers.getSetCookie() : [pageRes.headers.get('set-cookie')].filter(Boolean);
    for (const sc of rawCookies) {
        if (sc) { const c = sc.split(";")[0]; if (c) cookies.push(c); }
    }

    const html = await pageRes.text();
    const formAction = extractFormAction(html);
    if (!formAction) return { valid: false, message: 'مؤقتًا، النظام لا يستجيب', error: 'No form action' };

    // 2. Submit Login
    const loginRes = await fetch(formAction, {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies.join("; "), "User-Agent": ua, Referer: authUrl.toString(), Origin: "https://web.vodafone.com.eg" },
        body: new URLSearchParams({ username: clean, password }).toString(),
    });
    const redir = loginRes.headers.get("location");
    for (const sc of ((typeof getSetCookieFn === 'function') ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')].filter(Boolean))) {
        if (sc) { const c = sc.split(";")[0]; if (c) cookies.push(c); }
    }

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
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies.join("; "), "User-Agent": ua },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: "website", code, redirect_uri: "https://web.vodafone.com.eg/spa/myHome", code_verifier: codeVerifier }).toString(),
    });
    if (!tokenRes.ok) return { valid: true, message: 'الدخول صحيح لكن مسحوب أو توكن خطأ' };

    const tokens = await tokenRes.json();
    const jwt = decodeJwt(tokens.access_token);
    const userInfo = jwt?.userInfo || null;

    // 4. Fetch Extra Data
    const extra = await fetchAllData(tokens.access_token, cookies, clean);
    const data = {
        name: userInfo ? `${userInfo.firstName || ""} ${userInfo.lastName || ""}`.trim() : null,
        msisdn: userInfo?.msisdn || clean,
        currentPlan: userInfo?.serviceClassName || userInfo?.contractSubType || null,
        loyaltyStatus: userInfo?.isLoyalAuthorized === "Y" ? "مؤهل" : "غير مؤهل",
        balance: extra.balance ? String(extra.balance.balance ?? extra.balance.currentBalance ?? "") : null,
        usageSummary: extra.usage || null,
        rawUserInfo: userInfo
    };

    return { valid: true, message: 'الباسورد صحيح وتم الدخول ✅', details: data };
}

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
        // Check if has pending first_time request for this EXACT gigabytes / renewal_day combination, or just don't check at all.
        // We will just allow them to make a new booking unconditionally!
        // No blocking for existing bookings as per user request.

        // Verify with Vodafone
        const result = await fastVodafoneCheck(phone, password);
        if (!result.valid) {
            return res.json({ success: false, verified: false, error: result.message || 'الباسورد خطأ ❌' });
        }

        // Return success with pricing
        return res.json({
            success: true,
            verified: true,
            message: 'تم التحقق من الرقم بنجاح ✅',
            packages: Object.entries(PACKAGE_PRICES).map(([gb, price]) => ({ gigabytes: parseInt(gb), price })),
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

        // warnings deleted here

        // Send reminders
        const curM = currentMonth();
        const bookingsList = await dbAll(`SELECT * FROM bookings WHERE status = 'متأكتف' AND deleted_at IS NULL AND owner_tg IS NOT NULL`);
        for (const b of bookingsList) {
            const day = b.renewal_day;
            const w = getPaymentWindow(day);
            const today = new Date().getDate();
            if (today >= w.start && today <= w.end) {
                const payRow = await dbGet(`SELECT paid FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [b.id, curM]);
                if (!payRow || payRow.paid !== 1) {
                    const daysLeft = day - today;
                    if (daysLeft >= 0) {
                        const msg = `⚠️ نرجو دفع باقتك لرقم ${b.phone} لعدم ايقاف خطك ومتبقي مهله ${daysLeft} أيام.`;
                        try {
                            await bot.sendMessage(b.owner_tg, msg);
                        } catch (e) {
                            console.error(`[CRON] failed to send reminder to ${b.owner_tg} (${b.phone}):`, e.message || e);
                        }
                    }
                }
            }
        }

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

// Vercel Cron Endpoint:
app.get('/api/cron', async (req, res) => {
    await runDailyTasks();
    res.json({ success: true, message: 'Cron executed successfully' });
});

// ============================================ //
//             TELEGRAM BOT (WEBHOOK)         //
// ============================================ //

let activeBot = null;
let activeBotToken = null;

async function getBot() {
    let token = process.env.BOT_TOKEN;
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
    const username = (msg.from.username || '').toLowerCase();
    const admin = await dbGet(`SELECT * FROM bot_admins WHERE LOWER(tg_id) = LOWER(?) OR LOWER(tg_id) = LOWER(?) OR tg_id = ?`, [username, tgId, tgId]);
    if (admin) return true;
    const emp = await dbGet(`SELECT * FROM ashry_employees WHERE telegram_id = ? OR LOWER(telegram_username) = LOWER(?)`, [tgId, username]);
    return !!emp;
}

function mainMenu() {
    return {
        inline_keyboard: [
            [{ text: '📋 إجمالي الطلبات', callback_data: 'm_bookings' }],
            [{ text: '📅 سجلات التجديد (للتفعيل)', callback_data: 'm_renewals' }],
            [{ text: '📈 إنجازات هذا الشهر (التنشيطات)', callback_data: 'm_achievements' }],
            [{ text: '🔍 بحث عن طلب', callback_data: 'm_search' }]
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

                    if (isAdmin) {
                        await botInstance.sendMessage(chatId, `👋 مرحباً بك في لوحة الموظفين.\nاختر من القائمة:`, { parse_mode: 'Markdown', reply_markup: mainMenu() });
                    } else {
                        // Customer Logic
                        let webAppUrl = (process.env.WEBAPP_URL || 'https://vodared.vercel.app').trim();
                        if (!webAppUrl.startsWith('https://')) {
                            webAppUrl = 'https://' + webAppUrl.replace(/^http:\/\//, '');
                        }
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
            if (isAdmin) {
                return bot.sendMessage(msg.chat.id, `👋 مرحباً بك في لوحة الموظفين.\nاختر من القائمة:`, { parse_mode: 'Markdown', reply_markup: mainMenu() });
            }

            const webAppUrl = process.env.WEBAPP_URL || 'https://vodared.vercel.app';
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

    // Handle incoming messages for Admin Dashboard (Search by phone)
    bot.on('message', async (msg) => {
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
        const { phone, password, booking_id } = req.body;
        if ((!phone || !password) && !booking_id) return res.status(400).json({ success: false, error: 'البيانات مطلوبة' });

        let booking = null;
        if (booking_id) {
            booking = await dbGet(`SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`, [booking_id]);
        } else {
            booking = await dbGet(`SELECT * FROM bookings WHERE phone = ? AND password = ? AND deleted_at IS NULL`, [phone.trim(), password.trim()]);
        }

        if (!booking) {
            // Check if there's a pending first_time payment for this phone
            const pendingReg = await dbGet(
                `SELECT * FROM customer_payments WHERE phone = ? AND payment_type = 'first_time' AND status IN ('pending', 'needs_review')`,
                [phone.trim()]
            );
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
            const bExists = await dbGet(`SELECT id, password FROM bookings WHERE phone = ? AND deleted_at IS NULL`, [phone.trim()]);
            if (!bExists) {
                return res.status(401).json({ success: false, error: 'الرقم غير مسجل. יرجى التأكد أو طلب خط جديد.', not_found: true });
            }

            if (String(bExists.password).trim() !== String(password).trim()) {
                return res.status(401).json({ success: false, error: 'الرقم مسجل بالفعل! كلمة المرور غير صحيحة. إتصل بالدعم.' });
            }

            return res.status(401).json({ success: false, error: 'حدث خطأ غير متوقع' });
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
                phone: booking.phone,
                gigabytes: booking.gigabytes,
                renewal_day: booking.renewal_day,
                status: booking.status,
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

        const myBookings = await dbAll(`SELECT id, phone, password FROM bookings WHERE owner_tg = ? AND deleted_at IS NULL`, [String(tg_id)]);
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
                    `INSERT INTO bookings(phone, password, gigabytes, status, renewal_day, created_at) VALUES(?, ?, ?, 'اتجاب', ?, CURRENT_TIMESTAMP)`,
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
                    `INSERT INTO bookings(phone, password, gigabytes, renewal_day, status, created_at) VALUES(?, ?, ?, ?, 'متأكتف', CURRENT_TIMESTAMP)`,
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
                await dbRun(`UPDATE bookings SET status = 'متأكتف', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [targetBookingId]);
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
        const botInstance = await getBot();
        if (!botInstance) return res.status(500).json({ error: 'البوت غير متصل' });

        const superAdminId = '1255885099';
        const ym = currentMonth();
        const todayDate = new Date();
        const today = todayDate.getDate();

        // We only care about active bookings (متأكتف)
        const bookingsList = await dbAll(`SELECT * FROM bookings WHERE status = 'متأكتف' AND deleted_at IS NULL`);

        let notPaidTotal = 0;
        let day1Warnings = []; // 1 day left
        let sentRemindersCount = 0;

        for (const b of bookingsList) {
            // Check if paid this month
            const payRow = await dbGet(`SELECT paid FROM monthly_payments WHERE booking_id = ? AND year_month = ?`, [b.id, ym]);
            const isPaid = (payRow && payRow.paid === 1);

            if (isPaid) continue; // Skip paid lines

            const daysToRenewal = b.renewal_day - today;

            // Is it within the 6-day grace period BEFORE renewal?
            if (daysToRenewal <= 6 && daysToRenewal >= 0) {
                notPaidTotal++;

                // If exactly 1 day before, add to Admin summary list
                if (daysToRenewal === 1) {
                    day1Warnings.push(`📱 \`${b.phone}\` | ${b.gigabytes}G | التجديد غداً`);
                }

                // Send reminder to user if linked to Telegram
                if (b.owner_tg) {
                    const daysWord = daysToRenewal === 0 ? 'اليوم!' : (daysToRenewal === 1 ? 'غداً!' : `خلال ${daysToRenewal} أيام`);
                    const msg = `⚠️ *تذكير آلي من فودافون ريد*\n\nالعميل العزيز،\nنرجو سداد قيمة باقة الخط: ${b.phone}\nمتبقى على موعد التجديد: *${daysWord}*\n\nيرجى الدفع لتجنب إيقاف الخدمة تلقائياً.`;

                    try {
                        await botInstance.sendMessage(b.owner_tg, msg, { parse_mode: 'Markdown' });
                        sentRemindersCount++;
                    } catch (e) {
                        console.error('Failed to send cron reminder to', b.owner_tg);
                    }
                }
            }
        }

        // Send summary to Super Admin
        if (day1Warnings.length > 0) {
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
            sentReminders: sentRemindersCount,
            adminAlertLists: day1Warnings.length
        });

    } catch (e) {
        console.error('Cron Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// Duplicate /api/admin/check-password removed (defined above)
