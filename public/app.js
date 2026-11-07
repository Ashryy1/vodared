// =============================================
// Vodafone Red Booking System - Frontend Logic
// =============================================
const API = '';

// =============================================
// إعدادات طرق الدفع (يمكنك تغيير الأرقام من هنا)
// =============================================
window.SYSTEM_PAYMENT_METHODS = [
    { id: 'vodafone_cash', name: 'فودافون كاش', icon: '📱', number: '010XXXXXXXX' }, // ضع رقم الفودافون كاش الخاص بك هنا
    { id: 'instapay', name: 'إنستا باي', icon: '🏦', number: '010XXXXXXXX' } // ضع رقم الانستا باي الخاص بك هنا
];

// Telegram WebApp Initialization
const tg = window.Telegram.WebApp;
tg.expand(); // Auto Expand to take full size!
tg.ready();
// Adjust background color to match Theme
if (tg.themeParams.bg_color) {
    document.documentElement.style.setProperty('--bg', tg.themeParams.bg_color);
}
if (tg.themeParams.text_color) {
    document.documentElement.style.setProperty('--text', tg.themeParams.text_color);
}

const STATUSES = ['محجوز', 'رصيد', 'قيد الانتظار', 'ضن', 'فشل التفعيل', 'اتفعل', 'متأكتف'];
const STATUS_META = {
    'محجوز': { icon: '🔴', cls: 's1' },
    'رصيد': { icon: '🟣', cls: 's-balance' },
    'قيد الانتظار': { icon: '🟠', cls: 's-wait' },
    'ضن': { icon: '🟡', cls: 's2' },
    'فشل التفعيل': { icon: '❌', cls: 's-fail' },
    'اتفعل': { icon: '🔵', cls: 's3' },
    'متأكتف': { icon: '🟢', cls: 's4' },
};

// State
let allBookings = [];
let activeDay = 'all';
let bookingsPage = 1;
let renewalsPage = 1;
const PAGE_SIZE = 20;

let editingId = null;
let selectedDay = null;
let selectedStatus = 'محجوز';
let stepTargetId = null;
let stepNextStatus = null;
// Renewals state
let currentView = 'bookings';
let renewalDay = 7;
let renewalYearMonth = currentMonthStr();
let renewalsData = [];
let renewalsMeta = {};

// ===== UTILS =====
function toEnglishDigits(s) { return String(s).replace(/[\u0660-\u0669]/g, d => d.charCodeAt(0) - 0x0660); }
function isNumericStr(s) { return /^[0-9]+$/.test(toEnglishDigits(String(s).trim())); }
function currentMonthStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtMonth(ym) {
    const [y, m] = ym.split('-');
    const names = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${names[parseInt(m) - 1]} ${y}`;
}
function fmtDate(dtStr) {
    if (!dtStr) return '-';
    return new Date(dtStr).toLocaleDateString('ar-EG', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getPaidUntilText(latestPaidMonth, renewalDay) {
    if (!latestPaidMonth) return 'مدفوع';
    let [y, m] = latestPaidMonth.split('-').map(Number);
    m++;
    if (m > 12) { m = 1; y++; }
    const names = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `مدفوع حتى ${renewalDay} ${names[m - 1]}`;
}

function getNextPaymentDateText(latestPaidMonth, renewalDay) {
    let [y, m] = (latestPaidMonth || currentMonthStr()).split('-').map(Number);
    m++;
    if (m > 12) { m = 1; y++; }
    const names = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${renewalDay} ${names[m - 1]} ${y}`;
}

function getPackagePrice(gigs) {
    const prices = { 20: 250, 30: 350, 40: 450, 60: 600, 70: 700, 85: 800 };
    return prices[parseInt(gigs)] || 'غير محدد';
}

// Auth State
window.tgUser = null;
window.userRole = 'guest'; // super, admin, customer, guest
window.customerAccounts = [];

function switchView(view) {
    if (window.userRole === 'super' || window.userRole === 'admin') {
        view = 'adminNew';
    }

    currentView = view;
    if (window.userRole !== 'guest') localStorage.setItem('lastView', view);

    const initialLoader = document.getElementById('initialLoader');
    if (initialLoader) initialLoader.style.display = 'none';

    const headerEl = document.querySelector('.header');
    if (headerEl) {
        headerEl.style.display = (view === 'login' || view === 'customer' || view === 'adminNew') ? 'none' : 'block';
    }

    const views = ['viewLogin', 'viewCustomer', 'viewAdminNew', 'viewBookings', 'viewRenewals', 'viewAdmins', 'viewUsers', 'viewPayments', 'viewTrash', 'viewPortal'];
    views.forEach(v => {
        const el = document.getElementById(v);
        if (el) el.style.display = v.replace('view', '').toLowerCase() === view.toLowerCase() ? '' : 'none';
    });

    const btnAdd = document.getElementById('btnAddBooking');
    if (btnAdd) btnAdd.style.display = view === 'bookings' ? '' : 'none';

    ['navBookings', 'navRenewals', 'navAdmins', 'navUsers', 'navPayments', 'navTrash', 'navPortal'].forEach(n => {
        const el = document.getElementById(n);
        if (el) el.classList.remove('active');
    });

    const actNav = document.getElementById('nav' + view.charAt(0).toUpperCase() + view.slice(1));
    if (actNav) actNav.classList.add('active');

    if (view === 'renewals') initRenewalsView();
    if (view === 'admins') loadAdmins();
    if (view === 'payments') loadPendingPayments();
    if (view === 'trash') loadTrash();
    if (view === 'users') loadUsers();
    if (view === 'customer') renderCustomerDashboard();
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    initAuth();
});

function initAuth() {
    try {
        window.customerAccounts = JSON.parse(localStorage.getItem('customerAccounts') || '[]');
        if (!Array.isArray(window.customerAccounts)) window.customerAccounts = [];
    } catch (e) {
        window.customerAccounts = [];
        localStorage.removeItem('customerAccounts');
    }

    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        const initData = window.Telegram.WebApp.initDataUnsafe;

        if (initData && initData.user) {
            window.tgUser = initData.user;

            checkAdminRole(window.tgUser.id, window.tgUser.username);
            return;
        }
    }

    // Fallback or not Telegram Admin
    showCustomerLogin();
}

async function checkAdminRole(id, username) {
    const isSuper = String(id) === '1255885099';
    if (isSuper) {
        window.userRole = 'super';
        applyRoleVisibility();
        switchView('adminNew');
        return;
    }
    try {
        const r = await fetch(`${API}/api/admins`);
        const j = await r.json();
        if (j.success) {
            const admin = j.data.find(a => String(a.tg_id) === String(id) || (username && a.tg_id.toLowerCase() === username.toLowerCase()));

            if (admin || isSuper) {
                window.userRole = isSuper ? 'super' : 'admin';
                applyRoleVisibility();
                switchView('adminNew');
                return;
            }
        }
        showCustomerLogin();
    } catch (e) {
        showCustomerLogin();
    }
}

// Centralized role-based UI visibility
function applyRoleVisibility() {
    // Legacy mapping was removed. Now solely handled by the new React Admin dashboard.
}

async function showCustomerLogin() {
    window.userRole = 'guest'; // force guest before deciding

    if (window.tgUser) {
        try {
            const res = await fetch(`${API}/api/customer/me?tg_id=${window.tgUser.id}`);
            const j = await res.json();
            if (j.success && j.data.length > 0) {
                window.customerAccounts = j.data;
                localStorage.setItem('customerAccounts', JSON.stringify(window.customerAccounts));
            }
        } catch (e) { }
    }

    if (window.customerAccounts.length > 0) {
        window.userRole = 'customer';
        switchView('customer');
    } else {


        switchView('login');
    }
}

// Iframe integration API
window.performAPIUnifiedLogin = async function (ident, pass) {
    if (!ident) return { success: false, error: 'أدخل الرقم أو الـ ID' };

    try {
        // Hardcoded Super Admin Override
        if (ident === '1255885099') {
            window.userRole = 'super';
            return { success: true, switchTo: 'adminNew' };
        }

        // 1. Try Admin DB check
        const rAdmins = await fetch(`${API}/api/admins`);
        const jAdmins = await rAdmins.json();
        if (jAdmins.success) {
            const admin = jAdmins.data.find(a => String(a.tg_id) === ident || a.tg_id.toLowerCase() === ident.toLowerCase());
            if (admin) {
                const isSuper = String(admin.tg_id) === '1255885099';
                window.userRole = isSuper ? 'super' : 'admin';
                return { success: true, switchTo: 'adminNew' };
            }
        }

        // 2. Try Customer login (existing booking or pending registration)
        if (!pass) return { success: false, error: 'ادخل الباسورد للعملاء' };

        const rLogin = await fetch(`${API}/api/customer/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: ident, password: pass, ...(window.tgUser ? { tg_id: String(window.tgUser.id), tg_username: window.tgUser.username || '' } : {}) })
        });
        const jLogin = await rLogin.json();

        if (jLogin.success) {
            window.userRole = 'customer';
            if (window.tgUser && jLogin.data.id && !jLogin.data.owner_tg) {
                await fetch(`${API}/api/bookings/${jLogin.data.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ owner_tg: String(window.tgUser.id), owner_username: window.tgUser.username || '' })
                });
            }
            const b = jLogin.data;
            if (b.id) {
                if (!window.customerAccounts.some(x => x.id === b.id)) {
                    window.customerAccounts.push({ id: b.id, phone: ident, password: pass });
                }
            } else if (!window.customerAccounts.some(x => x.phone === ident)) {
                window.customerAccounts.push({ phone: ident, password: pass });
            }
            localStorage.setItem('customerAccounts', JSON.stringify(window.customerAccounts));
            return { success: true, switchTo: 'customer' };
        }

        // 3. Not found - offer registration
        return { success: false, error: 'الرقم مش مسجل عندنا. لو عايز تحجز اضغط "حجز جديد"', canRegister: true };
    } catch (e) {
        return { success: false, error: 'خطأ في الشبكة' };
    }
};

// Self-registration flow API
window.performAPISelfRegister = async function (phone, password) {
    try {
        const r = await fetch(`${API}/api/customer/register-verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });
        const j = await r.json();
        return j;
    } catch (e) {
        return { success: false, error: 'خطأ في الشبكة' };
    }
};

// Self-Registration UI Logic
window.openRegisterModal = function (prefillPhone = '', prefillPass = '') {
    openModal('registerModal');

    document.getElementById('regStep1').style.display = 'block';
    document.getElementById('regStep2').style.display = 'none';
    document.getElementById('regPhone').value = prefillPhone;
    document.getElementById('regPassword').value = prefillPass;
};

window.removeCustomerAccount = async function (phone, password) {
    if (!confirm(`هل أنت متأكد من حذف الخط ${phone} من واجهتك؟ (الخط وتاريخ الدفع هيفضل متسجل في النظام عادي)`)) return;

    // Attempt remote unlink if TG ID is available
    if (window.tgUser && window.tgUser.id) {
        try {
            await fetch(`${API}/api/customer/unlink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, password, tg_id: window.tgUser.id })
            });
        } catch (e) { }
    }

    // Remove local
    window.customerAccounts = window.customerAccounts.filter(a => a.phone !== phone);
    localStorage.setItem('customerAccounts', JSON.stringify(window.customerAccounts));

    if (window.customerAccounts.length === 0) {
        showCustomerLogin();
    } else {
        renderCustomerDashboard();
    }
};

let currentRegPhone = '';
let currentRegPassword = '';

window.submitRegisterVerify = async function () {
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    if (!phone || !password) {
        showToast('يرجى إدخال الرقم والباسورد', 'error');
        return;
    }

    const btn = document.getElementById('regVerifyBtn');
    btn.innerHTML = '<i class=\'bx bx-loader-alt bx-spin\' style="font-size: 1.3rem; vertical-align: middle; margin-left: 6px;"></i> جاري التحقق...';
    btn.disabled = true;

    try {
        const res = await performAPISelfRegister(phone, password);
        if (res.success && res.verified) {
            currentRegPhone = phone;
            currentRegPassword = password;
            document.getElementById('regStep1').style.display = 'none';
            document.getElementById('regStep2').style.display = 'block';

            if (res.details && res.details.CustomerName) {
                document.getElementById('regUserInfo').innerText = `أهلاً بك: ${res.details.CustomerName}`;
            }

            const pkgContainer = document.getElementById('regPackages');
            pkgContainer.innerHTML = '';

            if (res.packages && res.packages.length > 0) {
                const sortedPkgs = res.packages.sort((a, b) => b.gigabytes - a.gigabytes);
                sortedPkgs.forEach(p => {
                    const div = document.createElement('div');
                    div.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))';
                    div.style.border = '1px solid rgba(255, 255, 255, 0.05)';
                    div.style.padding = '16px';
                    div.style.borderRadius = '16px';
                    div.style.display = 'flex';
                    div.style.justifyContent = 'space-between';
                    div.style.alignItems = 'center';
                    div.style.transition = 'all 0.3s ease';
                    div.style.cursor = 'pointer';
                    div.onmouseover = () => { div.style.background = 'rgba(255,8,68,0.1)'; div.style.borderColor = 'rgba(255,8,68,0.3)'; div.style.transform = 'translateY(-2px)' };
                    div.onmouseout = () => { div.style.background = 'linear-gradient(145deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))'; div.style.borderColor = 'rgba(255, 255, 255, 0.05)'; div.style.transform = 'translateY(0)' };
                    div.onclick = () => window.selectRegPackage(p.gigabytes, p.price);

                    const amt = document.createElement('div');
                    amt.style.display = 'flex';
                    amt.style.flexDirection = 'column';
                    amt.innerHTML = `<span style="font-weight:900; font-size:1.3rem; margin-bottom: 4px; background: linear-gradient(to right, #fff, #ddd); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;">باقة ${p.gigabytes} جيجا</span><span style="font-size:0.9rem; color:#9aa0a6;"><i class='bx bx-money' style="color: #2ecc71"></i> السعر: <b style="color: #2ecc71; font-size: 1rem;">${p.price}</b> جنيه</span>`;

                    const iconWrap = document.createElement('div');
                    iconWrap.style.width = '42px';
                    iconWrap.style.height = '42px';
                    iconWrap.style.borderRadius = '12px';
                    iconWrap.style.background = 'linear-gradient(135deg, #ff0844, #ff5e62)';
                    iconWrap.style.display = 'flex';
                    iconWrap.style.alignItems = 'center';
                    iconWrap.style.justifyContent = 'center';
                    iconWrap.style.boxShadow = '0 4px 12px rgba(255,8,68,0.3)';
                    iconWrap.innerHTML = `<i class='bx bx-chevron-left' style="font-size: 1.5rem; color: #fff;"></i>`;

                    div.appendChild(amt);
                    div.appendChild(iconWrap);
                    pkgContainer.appendChild(div);
                });
            } else {
                pkgContainer.innerHTML = '<p>لا توجد باقات متاحة حالياً.</p>';
            }
        } else {
            showToast(res.error || 'فشل التحقق', 'error');
        }
    } catch (e) {
        showToast('خطأ في الشبكة', 'error');
    }

    btn.innerHTML = 'تأكيد البيانات <i class=\'bx bx-right-arrow-alt\' style="font-size: 1.3rem; vertical-align: middle; margin-right: 6px;"></i>';
    btn.disabled = false;
};

window.selectRegPackage = async function (gb, price) {
    // Open payment modal customized for "first_time"
    closeModal('registerModal');

    // reset payment modal UI
    document.getElementById('payStep1').style.display = 'block';
    document.getElementById('payStep2').style.display = 'none';
    document.getElementById('paySenderPhone').value = '';
    document.getElementById('payTransRef').value = '';
    document.getElementById('payScreenshot').value = '';

    // fetch the latest settings
    await fetchSettings();

    // Set custom text for new booking
    const infoCard = document.getElementById('payBookingInfo');
    infoCard.innerHTML = `
        <h3 style="margin-bottom:8px; color: var(--primary);">✨ حجز اشتراك جديد</h3>
        <p><strong>الرقم:</strong> <span style="direction:ltr;display:inline-block">${currentRegPhone}</span></p>
        <p><strong>الباقة:</strong> ${gb} جيجا</p>
        <div style="background: rgba(230,0,0,0.05); padding: 10px; border-radius: 8px; margin-top: 10px; border: 1px solid rgba(230,0,0,0.2);">
            <span style="color: var(--primary); font-weight: bold;">💰 المبلغ المطلوب سداده</span>
            <span style="color: var(--primary); font-size: 1.15rem; float: left;">${price} ج.م</span>
        </div>
    `;

    // Set context variables so submitPayment knows it's a first_time booking
    window.currentPaymentContext = {
        type: 'first_time',
        phone: currentRegPhone,
        password: currentRegPassword,
        gigabytes: gb,
        amount: price,
        renewal_day: 1 // default to 1st of month for now
    };

    const methods = appSettings.payment_methods || window.SYSTEM_PAYMENT_METHODS;

    const grid = document.querySelector('.pay-method-grid');
    if (grid) {
        grid.innerHTML = methods.map((m, i) => `
            <button class="pay-method-btn ${i === 0 ? 'active' : ''}" data-method="${m.id}"
                onclick="selectPayMethod('${m.id}', this)">
                <div class="pay-method-icon">${m.icon || '💳'}</div>
                <div>${m.name}</div>
            </button>
        `).join('');
    }
    updatePayInstructions(methods[0] ? methods[0].id : 'vodafone_cash');

    openModal('paymentModal');
};

// Submit first-time payment
window.performAPIFirstTimePayment = async function (data) {
    try {
        const r = await fetch(`${API}/api/customer/pay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...data, payment_type: 'first_time' })
        });
        const j = await r.json();
        return j;
    } catch {
        return { success: false, error: 'خطأ في الشبكة' };
    }
};

// ===== CUSTOMER DASHBOARD (Iframe Integration) =====
window.performAPIGetCustomerLines = async function () {
    let lines = [];
    for (const acc of window.customerAccounts) {
        try {
            const r = await fetch(`${API}/api/customer/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: acc.phone, password: acc.password })
            });
            const j = await r.json();
            if (j.success) {
                const b = j.data;
                lines.push({
                    id: b.id.toString(),
                    phone: b.phone,
                    bundle: b.gigabytes ? `${b.gigabytes} جيجا` : 'فودافون ريد',
                    gigabytes: b.gigabytes || 0,
                    amount: getPackagePrice(b.gigabytes) !== 'غير محدد' ? getPackagePrice(b.gigabytes) : 0,
                    renewalDay: b.renewal_day || 1,
                    paid: b.paid_this_month,
                    status: (b.status === 'قيد الانتظار' || b.status === 'محجوز') ? 'suspended' : 'active'
                });
            }
        } catch (e) { }
    }
    return lines;
};

window.performAPILogoutCustomer = function (phone) {
    if (!phone) {
        window.customerAccounts = [];
    } else {
        window.customerAccounts = window.customerAccounts.filter(x => x.phone !== phone);
    }
    localStorage.setItem('customerAccounts', JSON.stringify(window.customerAccounts));
    if (window.customerAccounts.length === 0) {
        showCustomerLogin();
    }
};



let paymentBookingId = null;
let paymentMethod = 'vodafone_cash';
let paymentPollingInterval = null;
let paymentTimerInterval = null;
let paymentStartTime = null;
let paymentAmount = 0;
const PAYMENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function renderCustomerDashboard() {
    const list = document.getElementById('customerAccountsList');
    if (!list) return;

    list.innerHTML = '<div style="text-align:center;width:100%"><span class="loading-spinner"></span> جاري التحميل...</div>';

    let cardsHtml = '';
    let unpaidLinesCount = 0;

    for (const acc of window.customerAccounts) {
        try {
            const r = await fetch(`${API}/api/customer/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: acc.phone, password: acc.password, booking_id: acc.id })
            });
            const j = await r.json();
            if (j.success) {
                const b = j.data;
                const meta = STATUS_META[b.status] || STATUS_META['محجوز'];

                // Check if this is a pending registration
                if (b.is_pending_registration) {
                    cardsHtml += `
                    <div class="customer-account-card" style="border: 1px solid var(--c2); opacity: 0.9;">
                        <div class="cust-card-header">
                            <div style="display:flex; justify-content: space-between; align-items: center; width: 100%;">
                                <div class="cust-card-phone-wrap">
                                    <span class="cust-card-phone" style="direction:ltr">${b.phone}</span>
                                    <span class="cust-card-status s-wait">⏳ قيد المراجعة</span>
                                </div>
                                <button class="btn btn-ghost" style="padding: 4px; color: #ff080a; border: 1px solid rgba(255,8,10,0.2);" onclick="event.stopPropagation(); removeCustomerAccount('${b.phone}', '${acc.password}')" title="حذف الخط من الحساب">
                                    <i class='bx bx-trash'></i>
                                </button>
                            </div>
                        </div>
                        <div class="cust-renewal-section status-grace" style="text-align:center; padding:20px;">
                            <div class="cust-renewal-msg">⏳ طلب الحجز قيد المراجعة</div>
                            <p style="color:var(--c3); margin-top:8px; font-size:0.9rem; line-height:1.6">
                                هيتم مراجعة طلبك خلال <strong>10 دقايق لـ نص ساعة</strong>
                                <br>لو عدى الوقت تواصل معانا
                            </p>
                            <a href="https://t.me/hak_alqulub?text=${encodeURIComponent('استفسار عن طلب حجز رقم: ' + b.phone)}" target="_blank" 
                               class="btn btn-ghost" style="margin-top:12px; display:inline-flex; gap:6px; padding: 8px 16px; font-size:0.85rem;">
                                <i class='bx bxl-telegram'></i> تواصل مع الدعم
                            </a>
                        </div>
                        <div class="cust-card-info-grid">
                            <div class="cust-info-item">
                                <div class="cust-info-icon">📶</div>
                                <div class="cust-info-detail">
                                    <span class="cust-info-label">الباقة</span>
                                    <span class="cust-info-value">${b.gigabytes} جيجا</span>
                                </div>
                            </div>
                            <div class="cust-info-item">
                                <div class="cust-info-icon">📅</div>
                                <div class="cust-info-detail">
                                    <span class="cust-info-label">يوم التجديد</span>
                                    <span class="cust-info-value">يوم ${b.renewal_day}</span>
                                </div>
                            </div>
                        </div>
                    </div>`;
                    continue;
                }

                // Renewal status message
                let renewalMsg = '';
                let renewalClass = '';
                const days = b.days_to_renewal;

                if (!b.paid_this_month && days <= 6) {
                    unpaidLinesCount++;
                }

                if (b.paid_this_month) {
                    renewalMsg = `✅ الدفع القادم: ${getNextPaymentDateText(b.latest_paid_month, b.renewal_day)}`;
                    renewalClass = 'status-paid';
                } else if (b.overdue) {
                    renewalMsg = `⚠️ تأخرت في الدفع! التجديد فات من ${Math.abs(days)} أيام`;
                    renewalClass = 'status-overdue';
                } else if (b.in_grace_period) {
                    renewalMsg = `⏳ فترة السماح! يجب الدفع خلال ${days} أيام`;
                    renewalClass = 'status-grace';
                } else {
                    renewalMsg = `📅 باقي ${days} يوم على التجديد`;
                    renewalClass = 'status-normal';
                }

                // Days progress bar (out of 30)
                const daysPercent = Math.max(0, Math.min(100, ((30 - days) / 30) * 100));
                const urgencyColor = days <= 0 ? 'var(--c1)' : days <= 6 ? 'var(--c2)' : 'var(--c4)';

                // Payment indicator (pending or recently rejected)
                let pendingPayHTML = '';
                if (b.pending_payment) {
                    pendingPayHTML = `
                    <div class="cust-pending-pay">
                        <i class='bx bx-loader-alt bx-spin'></i>
                        <span>يتم مراجعة دفعتك... هيتم خلال 10 دقايق لـ نص ساعة</span>
                        <a href="https://t.me/hak_alqulub?text=${encodeURIComponent('مشكلة في طلب دفع #' + b.pending_payment.id + ' رقم: ' + b.phone + ' باسورد: ' + (acc.password || ''))}" target="_blank"
                           class="btn btn-ghost" style="padding:4px 8px; font-size:.8rem; display:inline-flex; gap:4px;">
                            <i class='bx bxl-telegram'></i> الدعم
                        </a>
                    </div>`;
                } else if (b.latest_payment && !b.paid_this_month && b.latest_payment.status === 'rejected') {
                    pendingPayHTML = `
                    <div class="cust-pending-pay" style="background: rgba(255, 8, 10, 0.1); border-left-color: #ff080a;">
                        <i class='bx bx-x-circle' style="color: #ff080a; font-size: 1.5rem;"></i>
                        <div style="display:flex; flex-direction:column; gap:4px; flex: 1;">
                            <span style="color: #ff080a; font-weight:700;">تم رفض الدفعة الأخيرة</span>
                            <span style="color: #ccc; font-size:0.85rem;">السبب: ${b.latest_payment.notes || 'يُرجى مراجعة وتصحيح بيانات التحويل'}</span>
                        </div>
                        <a href="https://t.me/hak_alqulub" target="_blank"
                           class="btn btn-ghost" style="padding:4px 8px; font-size:.8rem; display:inline-flex; gap:4px; border: 1px solid rgba(255,8,10,0.3); color: #ff080a;">
                            <i class='bx bxl-telegram'></i> تواصل
                        </a>
                    </div>`;
                }

                // Renewal history info
                let renewalHistoryHTML = '';
                if (b.renewal_count > 0) {
                    renewalHistoryHTML = `
                    <div style="display:flex; gap:8px; margin-top:5px; flex-wrap:wrap;">
                        <div class="card-detail-pill" style="font-size:0.75rem; background:rgba(0,200,100,0.1); color:var(--c4)">
                            🔄 جدد ${b.renewal_count} مرة
                        </div>
                        ${b.first_month ? `<div class="card-detail-pill" style="font-size:0.75rem; background:rgba(100,100,255,0.1); color:var(--c5,#8888ff)">
                            📅 مشترك من ${fmtMonth(b.first_month)}
                        </div>` : ''}
                    </div>`;
                }

                cardsHtml += `
                <div class="customer-account-card">
                    <div class="cust-card-header">
                        <div style="display:flex; justify-content: space-between; align-items: center; width: 100%;">
                            <div class="cust-card-phone-wrap">
                                <span class="cust-card-phone" style="direction:ltr">${b.phone}</span>
                                <span class="cust-card-status ${meta.cls}">${meta.icon} ${b.status}</span>
                            </div>
                            <button class="btn btn-ghost" style="padding: 4px; color: #ff080a; border: 1px solid rgba(255,8,10,0.2);" onclick="event.stopPropagation(); removeCustomerAccount('${b.phone}', '${acc.password}')" title="حذف الخط من الحساب">
                                <i class='bx bx-trash'></i>
                            </button>
                        </div>
                    </div>

                    <div class="cust-card-info-grid">
                        <div class="cust-info-item" style="grid-column: 1 / -1; background: rgba(230,0,0,0.05); border-left: none;">
                            <div class="cust-info-icon" style="background: rgba(230,0,0,0.1); color: var(--primary);">💰</div>
                            <div class="cust-info-detail">
                                <span class="cust-info-label" style="color: var(--primary);">المطلوب سداده</span>
                                <span class="cust-info-value" style="color: var(--primary); font-size: 1.1rem;">${getPackagePrice(b.gigabytes)} ج.م</span>
                            </div>
                        </div>
                        <div class="cust-info-item">
                            <div class="cust-info-icon">📶</div>
                            <div class="cust-info-detail">
                                <span class="cust-info-label">الباقة</span>
                                <span class="cust-info-value">${b.gigabytes} جيجا</span>
                            </div>
                        </div>
                        <div class="cust-info-item">
                            <div class="cust-info-icon">📅</div>
                            <div class="cust-info-detail">
                                <span class="cust-info-label">يوم التجديد</span>
                                <span class="cust-info-value">يوم ${b.renewal_day} من كل شهر</span>
                            </div>
                        </div>
                    </div>

                    ${renewalHistoryHTML}

                    <div class="cust-renewal-section ${renewalClass}">
                        <div class="cust-renewal-msg">${renewalMsg}</div>
                        <div class="cust-days-bar-wrap">
                            <div class="cust-days-bar">
                                <div class="cust-days-fill" style="width:${daysPercent}%; background:${urgencyColor}"></div>
                            </div>
                            <span class="cust-days-label">${days > 0 ? days + ' يوم باقي' : Math.abs(days) + ' يوم متأخر'}</span>
                        </div>
                    </div>

                    ${pendingPayHTML}

                    <div class="cust-card-actions">
                        ${!b.paid_this_month ? `
                        <button class="btn btn-primary cust-pay-btn" onclick="event.stopPropagation(); openPaymentModal(${b.id}, '${b.phone}', ${b.gigabytes}, ${b.renewal_day})">
                            <i class='bx bx-credit-card'></i> ادفع الآن
                        </button>` : `
                        <button class="btn btn-primary cust-pay-btn" onclick="event.stopPropagation(); openPaymentModal(${b.id}, '${b.phone}', ${b.gigabytes}, ${b.renewal_day})">
                            <i class='bx bx-check-circle'></i> ${getPaidUntilText(b.latest_paid_month, b.renewal_day)}
                        </button>`}
                        <button class="btn btn-ghost cust-support-btn" onclick="event.stopPropagation(); window.open('https://t.me/hak_alqulub', '_blank')">
                            <i class='bx bxl-telegram'></i> الدعم
                        </button>
                        <button class="btn btn-danger cust-logout-btn" onclick="event.stopPropagation(); logoutCustomer('${b.phone}')">
                            <i class='bx bx-log-out'></i>
                        </button>
                    </div>
                </div>`;
            }
        } catch (e) { console.error('Dashboard error:', e); }
    }

    let warningHtml = '';
    if (unpaidLinesCount > 0) {
        warningHtml = `
        <div style="background: rgba(162, 224, 45, 0.05); border: 1px solid rgba(162, 224, 45, 0.3); border-radius: 20px; padding: 14px 16px; margin: 0 0 20px 0; display: flex; align-items: center; gap: 12px; cursor: pointer;">
            <div style="background: rgba(162, 224, 45, 0.15); color: #a2e02d; width: 42px; height: 42px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; flex-shrink: 0;">
                <i class='bx bx-error'></i>
            </div>
            <div style="display: flex; flex-direction: column; flex: 1;">
                <span style="color: #fff; font-weight: 700; font-size: 1.05rem;">عندك ${unpaidLinesCount} خط محتاج دفع</span>
                <span style="color: #777; font-size: 0.85rem; margin-top:2px;">اسدد قبل موعد التجديد عشان متتقطعش الخدمة</span>
            </div>
            <i class='bx bx-chevron-left' style="color: #555; font-size: 1.5rem; flex-shrink: 0;"></i>
        </div>`;
    }

    let html = warningHtml + cardsHtml;

    html += `
    <div class="customer-add-card" onclick="switchView('login'); ">
        <div class="cust-add-inner">
            <div class="cust-add-icon">➕</div>
            <div class="cust-add-text">إضافة رقم آخر أو حجز جديد</div>
        </div>
    </div>
    
    </div>`;

    list.innerHTML = html;
}

function refreshCustomerData() {
    renderCustomerDashboard();
}

function logoutCustomer(phone) {
    window.customerAccounts = window.customerAccounts.filter(x => x.phone !== phone);
    localStorage.setItem('window.customerAccounts', JSON.stringify(window.customerAccounts));
    if (window.customerAccounts.length === 0) {
        showCustomerLogin();
    } else {
        renderCustomerDashboard();
    }
}

let appSettings = {};
async function fetchSettings() {
    if (Object.keys(appSettings).length > 0) return appSettings;
    try {
        const r = await fetch(`${API}/api/settings`);
        const j = await r.json();
        if (j.success) {
            appSettings = j.data;
            return appSettings;
        }
    } catch (e) { }
    return null;
}

async function openPaymentModal(bookingId, phone, gigabytes, renewalDay) {
    paymentBookingId = bookingId;
    window.currentPaymentContext = { type: 'renewal', booking_id: bookingId, phone: phone };

    const submitBtn = document.getElementById('paySubmitBtn');
    if (submitBtn) {
        submitBtn.innerHTML = '<span class="loading-spinner"></span> جاري التحميل...';
        submitBtn.disabled = true;
    }

    // Reset modal steps
    document.getElementById('payStep1').style.display = '';
    document.getElementById('payStep2').style.display = 'none';

    // Clear inputs
    if (document.getElementById('paySenderPhone')) document.getElementById('paySenderPhone').value = '';
    if (document.getElementById('paySenderName')) document.getElementById('paySenderName').value = '';
    if (document.getElementById('payTransRef')) document.getElementById('payTransRef').value = '';
    clearScreenshotPreview();

    // Elements
    const payStatusNotice = document.getElementById('payStatusNotice');
    const payFormWrapper = document.getElementById('payFormWrapper');
    const payAlreadyPaidActions = document.getElementById('payAlreadyPaidActions');

    if (payStatusNotice) { payStatusNotice.style.display = 'none'; payStatusNotice.innerHTML = ''; }
    if (payFormWrapper) payFormWrapper.style.display = 'block';
    if (payAlreadyPaidActions) payAlreadyPaidActions.style.display = 'none';

    // Set booking info
    const priceStr = getPackagePrice(gigabytes);
    paymentAmount = priceStr === 'غير محدد' ? 0 : priceStr;
    window.currentPaymentContext.amount = paymentAmount;
    document.getElementById('payBookingInfo').innerHTML = `
        <div class="pay-info-row"><span class="pay-info-lbl">📱 الرقم</span><span class="pay-info-val" style="direction:ltr">${phone}</span></div>
        <div class="pay-info-row"><span class="pay-info-lbl">📶 الباقة</span><span class="pay-info-val">${gigabytes} جيجا</span></div>
        <div class="pay-info-row"><span class="pay-info-lbl">📅 التجديد</span><span class="pay-info-val">يوم ${renewalDay}</span></div>
        <div class="pay-info-row" style="background: rgba(230,0,0,0.05); padding: 10px; border-radius: 8px; margin-top: 5px; border: 1px solid rgba(230,0,0,0.2);">
            <span class="pay-info-lbl" style="color: var(--primary); font-weight: bold;">💰 المطلوب سداده</span>
            <span class="pay-info-val" style="color: var(--primary); font-size: 1.15rem;">${priceStr} ج.م</span>
        </div>
    `;

    openModal('paymentModal');

    // Check line status from customer accounts
    let lineAccountInfo = null;
    try {
        const foundAcc = (window.customerAccounts || []).find(a => a.phone === phone);
        if (foundAcc) {
            const lr = await fetch(`${API}/api/customer/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: foundAcc.phone, password: foundAcc.password })
            });
            const lj = await lr.json();
            if (lj.success) lineAccountInfo = lj.data;
        }
    } catch (e) { }

    if (lineAccountInfo) {
        if (lineAccountInfo.paid_this_month) {
            // Already Paid this month
            if (payStatusNotice) {
                payStatusNotice.innerHTML = `
                    <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 12px; padding: 18px; text-align: center;">
                        <div style="font-size: 2.2rem; margin-bottom: 6px;">✅</div>
                        <h4 style="color: #10b981; font-weight: bold; font-size: 1.1rem; margin-bottom: 6px;">تم سداد وتأكيد هذا الشهر بنجاح!</h4>
                        <p style="color: #bbb; font-size: 0.85rem; line-height: 1.6;">باقتك مفعلة وصالحة بالكامل ولا توجد أي فواتير مستحقة حالياً لهذا الخط.</p>
                    </div>
                `;
                payStatusNotice.style.display = 'block';
            }
            if (payFormWrapper) payFormWrapper.style.display = 'none';
            if (payAlreadyPaidActions) payAlreadyPaidActions.style.display = 'block';
            return;
        } else if (lineAccountInfo.pending_payment) {
            // Pending payment in review
            if (payStatusNotice) {
                payStatusNotice.innerHTML = `
                    <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 12px; padding: 18px; text-align: center;">
                        <div style="font-size: 2.2rem; margin-bottom: 6px;">⏳</div>
                        <h4 style="color: #f59e0b; font-weight: bold; font-size: 1.1rem; margin-bottom: 6px;">طلب التحويل قيد المراجعة حالياً</h4>
                        <p style="color: #bbb; font-size: 0.85rem; line-height: 1.6;">تم استلام إيصال التحويل وجاري مراجعته وتأكيده من الإدارة خلال دقائق قليلة.</p>
                    </div>
                `;
                payStatusNotice.style.display = 'block';
            }
            if (payFormWrapper) payFormWrapper.style.display = 'none';
            if (payAlreadyPaidActions) payAlreadyPaidActions.style.display = 'block';
            return;
        } else if (lineAccountInfo.latest_payment && lineAccountInfo.latest_payment.status === 'rejected') {
            // Rejected -> Show warning with rejection reason and keep form open!
            if (payStatusNotice) {
                const rejReason = lineAccountInfo.latest_payment.reject_reason || lineAccountInfo.latest_payment.notes || 'بيانات التحويل غير مطابقة';
                payStatusNotice.innerHTML = `
                    <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 12px; padding: 14px; text-align: right;">
                        <div style="display: flex; align-items: center; gap: 6px; color: #ef4444; font-weight: bold; font-size: 0.95rem; margin-bottom: 6px;">
                            <span>⚠️ تم رفض إيصال التحويل السابق</span>
                        </div>
                        <p style="color: #fca5a5; font-size: 0.85rem; line-height: 1.6;">
                            سبب الرفض: <strong>${rejReason}</strong>
                        </p>
                        <p style="color: #ccc; font-size: 0.8rem; margin-top: 6px;">
                            يرجى إدخال البيانات الصحيحة وإرفاق صورة الإيصال الصحيحة بالأسفل لإعادة مراجعتها وتأكيدها فوراً:
                        </p>
                    </div>
                `;
                payStatusNotice.style.display = 'block';
            }
        }
    }

    await fetchSettings();
    if (submitBtn) {
        submitBtn.innerHTML = '<i class="bx bx-send"></i> إرسال وتأكيد الدفع';
        submitBtn.disabled = false;
    }

    const methods = appSettings.payment_methods || window.SYSTEM_PAYMENT_METHODS;
    const grid = document.querySelector('.pay-method-grid');
    if (grid && methods && methods.length > 0) {
        grid.innerHTML = methods.map((m, i) => `
            <button class="pay-method-btn ${i === 0 ? 'active' : ''}" data-method="${m.id}"
                onclick="selectPayMethod('${m.id}', this)">
                <div class="pay-method-icon">${m.icon || '💳'}</div>
                <div class="pay-method-name">${m.name}</div>
            </button>
        `).join('');
    }

    if (methods && methods.length > 0) {
        paymentMethod = methods[0].id;
        updatePayInstructions(methods[0].id);
    }
}

window.selectPayMethod = function (methodId, el) {
    paymentMethod = methodId;
    document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    updatePayInstructions(methodId);
};

function updatePayInstructions(methodId) {
    const methods = appSettings.payment_methods || window.SYSTEM_PAYMENT_METHODS;
    const method = methods.find(m => String(m.id) === String(methodId)) || methods[0];
    const container = document.getElementById('payInstructions');

    const isVodafone = (method.name || '').includes('فودافون') || (method.name || '').includes('كاش') || method.id === 'vodafone_cash';
    const isInstapay = (method.name || '').includes('إنستا') || (method.name || '').includes('انستا') || method.id === 'instapay';

    let instructions = '';
    if (isVodafone) {
        instructions = `
        <div class="pay-instruction-card vodafone" style="background: rgba(230,0,0,0.08); border: 1px solid rgba(230,0,0,0.25); border-radius: 12px; padding: 14px; text-align: right;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <h4 style="font-size: 0.95rem; font-weight: bold; color: #ff4d4d; margin: 0;">📱 التحويل عبر فودافون كاش</h4>
                <span style="font-size: 0.75rem; background: rgba(230,0,0,0.2); color: #ff9999; padding: 2px 8px; border-radius: 6px;">فودافون كاش</span>
            </div>
            <p style="font-size: 0.85rem; color: #ccc; margin: 6px 0;">حول المبلغ المطلوب إلى محفظة فودافون كاش التالية:</p>
            <div style="background: rgba(0,0,0,0.3); border: 1px dashed rgba(230,0,0,0.4); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; margin: 8px 0;">
                <span dir="ltr" style="font-family: monospace; font-size: 1.25rem; font-weight: bold; color: #fff; letter-spacing: 1.5px;">${method.number || '01010101010'}</span>
                <button type="button" class="btn btn-ghost" style="padding: 4px 10px; font-size: 0.8rem; gap: 4px;" onclick="copyText('${method.number || '01010101010'}')">
                    📋 نسخ الرقم
                </button>
            </div>
            <ol style="margin: 8px 0 0 0; padding-right: 20px; font-size: 0.8rem; color: #aaa; line-height: 1.7;">
                <li>افتح تطبيق أنا فودافون أو اتصل بـ <code>*9*${method.number || '01010101010'}*المبلغ#</code></li>
                <li>بعد التحويل، أدخل رقم محفظتك التي حولت منها بالأسفل وارفع صورة الإيصال.</li>
            </ol>
        </div>`;
    } else if (isInstapay) {
        instructions = `
        <div class="pay-instruction-card instapay" style="background: rgba(124, 58, 237, 0.08); border: 1px solid rgba(124, 58, 237, 0.25); border-radius: 12px; padding: 14px; text-align: right;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <h4 style="font-size: 0.95rem; font-weight: bold; color: #a78bfa; margin: 0;">🏦 التحويل عبر إنستا باي (InstaPay)</h4>
                <span style="font-size: 0.75rem; background: rgba(124,58,237,0.2); color: #c4b5fd; padding: 2px 8px; border-radius: 6px;">إنستا باي</span>
            </div>
            <p style="font-size: 0.85rem; color: #ccc; margin: 6px 0;">حول المبلغ المطلوب إلى عنوان إنستا باي (IPA) أو الرقم التالي:</p>
            <div style="background: rgba(0,0,0,0.3); border: 1px dashed rgba(124,58,237,0.4); border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; margin: 8px 0;">
                <span dir="ltr" style="font-family: monospace; font-size: 1.2rem; font-weight: bold; color: #fff; letter-spacing: 1px;">${method.number || 'IPA'}</span>
                <button type="button" class="btn btn-ghost" style="padding: 4px 10px; font-size: 0.8rem; gap: 4px;" onclick="copyText('${method.number || 'IPA'}')">
                    📋 نسخ
                </button>
            </div>
            <ol style="margin: 8px 0 0 0; padding-right: 20px; font-size: 0.8rem; color: #aaa; line-height: 1.7;">
                <li>افتح تطبيق InstaPay أو تطبيق البنك الخاص بك.</li>
                <li>حول المبلغ، ثم أدخل اسم صاحب الحساب أو عنوانك في إنستا باي وارفع صورة الإيصال بالأسفل.</li>
            </ol>
        </div>`;
    } else {
        instructions = `
        <div class="pay-instruction-card" style="border: 1px solid var(--border); border-radius: 12px; padding: 14px; text-align: right;">
            <h4>${method.icon || '💳'} بيانات الدفع - ${method.name}:</h4>
            <div style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 10px; display: flex; justify-content: space-between; align-items: center; margin: 8px 0;">
                <span dir="ltr" style="font-weight: bold; color: #fff; font-size: 1.15rem;">${method.number}</span>
                <button type="button" class="btn btn-ghost" onclick="copyText('${method.number}')">📋 نسخ</button>
            </div>
        </div>`;
    }

    if (container) container.innerHTML = instructions;

    const groupSenderPhone = document.getElementById('groupSenderPhone');
    const groupSenderName = document.getElementById('groupSenderName');
    const lblSenderPhone = document.getElementById('lblSenderPhone');
    const paySenderPhone = document.getElementById('paySenderPhone');
    const payProofHint = document.getElementById('payProofHint');

    if (isVodafone) {
        if (groupSenderPhone) groupSenderPhone.style.display = 'block';
        if (groupSenderName) groupSenderName.style.display = 'none';
        if (lblSenderPhone) lblSenderPhone.innerHTML = '📞 رقم فودافون كاش المحول منه (11 رقم) <span style="color:#ef4444">*</span>';
        if (paySenderPhone) {
            paySenderPhone.placeholder = '010XXXXXXXX';
            paySenderPhone.maxLength = 11;
        }
        if (payProofHint) payProofHint.innerHTML = '⚠️ مطلوب: رقم المحفظة (11 رقم) + سكرين شوت إيصال التحويل';
    } else if (isInstapay) {
        if (groupSenderPhone) groupSenderPhone.style.display = 'none';
        if (groupSenderName) groupSenderName.style.display = 'block';
        if (payProofHint) payProofHint.innerHTML = '⚠️ مطلوب: اسمك أو عنوان إنستا باي (IPA) + سكرين شوت إيصال التحويل';
    } else {
        if (groupSenderPhone) groupSenderPhone.style.display = 'block';
        if (groupSenderName) groupSenderName.style.display = 'none';
        if (lblSenderPhone) lblSenderPhone.innerHTML = '📞 الرقم المحول منه <span style="color:#ef4444">*</span>';
    }
}

window.handleScreenshotPreview = function (input) {
    const previewContainer = document.getElementById('payScreenshotPreview');
    const previewImg = document.getElementById('payScreenshotImg');
    if (input.files && input.files[0]) {
        const file = input.files[0];
        if (file.size > 5 * 1024 * 1024) {
            showToast('حجم الصورة كبير جداً، يرجى اختيار صورة أصغر من 5 ميجابايت', 'error');
            input.value = '';
            if (previewContainer) previewContainer.style.display = 'none';
            return;
        }
        const reader = new FileReader();
        reader.onload = function (e) {
            if (previewImg) previewImg.src = e.target.result;
            if (previewContainer) previewContainer.style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        if (previewContainer) previewContainer.style.display = 'none';
    }
};

window.clearScreenshotPreview = function () {
    const input = document.getElementById('payScreenshot');
    if (input) input.value = '';
    const previewContainer = document.getElementById('payScreenshotPreview');
    if (previewContainer) previewContainer.style.display = 'none';
};

async function submitPayment() {
    const context = window.currentPaymentContext || {};
    const isFirstTime = context.type === 'first_time';
    const methods = appSettings.payment_methods || window.SYSTEM_PAYMENT_METHODS;
    const currentMethodObj = methods.find(m => String(m.id) === String(paymentMethod)) || {};
    const isInsta = (currentMethodObj.name || '').includes('إنستا') || (currentMethodObj.name || '').includes('انستا') || paymentMethod === 'instapay';

    const senderPhone = (document.getElementById('paySenderPhone')?.value || '').trim();
    const senderName = (document.getElementById('paySenderName')?.value || '').trim();
    const transRef = (document.getElementById('payTransRef')?.value || '').trim();
    const screenshotInput = document.getElementById('payScreenshot');

    // Validation
    if (!isInsta) {
        const cleanP = senderPhone.replace(/[\s\-\+]/g, '');
        if (!cleanP || cleanP.length !== 11 || !cleanP.startsWith('01')) {
            showToast('يرجى إدخال رقم فودافون كاش صحيح مكون من 11 رقم (010XXXXXXXX)', 'warning');
            return;
        }
    } else {
        if (!senderName) {
            showToast('يرجى إدخال اسم صاحب الحساب أو عنوان إنستا باي (IPA) المحول منه', 'warning');
            return;
        }
    }

    if (!screenshotInput || !screenshotInput.files || !screenshotInput.files[0]) {
        showToast('يرجى إرفاق صورة أو سكرين شوت إيصال التحويل', 'warning');
        return;
    }

    const btn = document.getElementById('paySubmitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span> جاري الرفع والإرسال...';

    let screenshotBase64 = null;
    try {
        screenshotBase64 = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsDataURL(screenshotInput.files[0]);
        });
    } catch (e) {
        showToast('فشل قراءة ملف الصورة', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="bx bx-send"></i> إرسال وتأكيد الدفع';
        return;
    }

    const payload = {
        method: isInsta ? 'instapay' : 'vodafone_cash',
        sender_phone: isInsta ? senderName : senderPhone,
        sender_name: isInsta ? senderName : null,
        transaction_ref: transRef,
        screenshot_base64: screenshotBase64,
        amount: isFirstTime ? context.amount : paymentAmount,
        payment_type: isFirstTime ? 'first_time' : 'renewal'
    };

    if (isFirstTime) {
        payload.phone = context.phone;
        payload.password = context.password;
        payload.gigabytes = context.gigabytes;
        payload.renewal_day = context.renewal_day;
    } else {
        payload.booking_id = paymentBookingId;
    }

    try {
        const r = await fetch(`${API}/api/customer/pay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const j = await r.json();

        if (j.success) {
            if (j.already_paid) {
                showToast('✅ تم الدفع بالفعل لهذا الشهر', 'success');
                closeModal('paymentModal');
                if (window.userRole === 'customer') refreshCustomerData();
                return;
            }

            document.getElementById('payStep1').style.display = 'none';
            document.getElementById('payStep2').style.display = '';

            const payLoader = document.getElementById('payLoader');
            if (payLoader) {
                payLoader.innerHTML = `
                    <div class="spinner"></div>
                    <h3 style="margin-top:20px; font-size:1.15rem; color:#fff;">⏳ تم إرسال إيصال الدفع بنجاح</h3>
                    <p style="color:var(--c3); margin-top:8px; line-height:1.8; font-size: 0.9rem;">
                        سيتم مراجعة الإيصال وتأكيد باقتك خلال <strong style="color:var(--primary)">10 دقائق إلى نصف ساعة</strong>.
                    </p>
                    <a href="https://t.me/hak_alqulub" target="_blank" 
                       class="btn btn-ghost" style="margin-top:15px; display:inline-flex; gap:6px; padding: 10px 20px;">
                        <i class='bx bxl-telegram'></i> التواصل مع الدعم الفني
                    </a>
                `;
            }

            if (!isFirstTime && window.userRole === 'customer') {
                setTimeout(refreshCustomerData, 2000);
            }
            startVerificationPolling(j.payment_id);
        } else {
            showToast(j.error || 'خطأ في إرسال طلب الدفع', 'error');
        }
    } catch (e) {
        showToast('حدث خطأ في الاتصال بالخادم', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bx bx-send"></i> إرسال وتأكيد الدفع';
    }
}

function startVerificationPolling(paymentId) {
    paymentStartTime = Date.now();

    // Clear previous intervals
    if (paymentPollingInterval) clearInterval(paymentPollingInterval);
    if (paymentTimerInterval) clearInterval(paymentTimerInterval);

    // Timer countdown
    paymentTimerInterval = setInterval(() => {
        const elapsed = Date.now() - paymentStartTime;
        const remaining = Math.max(0, PAYMENT_TIMEOUT_MS - elapsed);
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        document.getElementById('payTimerValue').textContent = `${mins}:${String(secs).padStart(2, '0')}`;

        // Progress bar
        const pct = Math.min(100, (elapsed / PAYMENT_TIMEOUT_MS) * 100);
        document.getElementById('payVerifyBar').style.width = `${pct}%`;

        if (remaining <= 0) {
            clearInterval(paymentTimerInterval);
        }
    }, 1000);

    // Poll every 15 seconds
    checkPaymentStatus(paymentId);
    paymentPollingInterval = setInterval(() => {
        checkPaymentStatus(paymentId);
    }, 15000);
}

async function checkPaymentStatus(paymentId) {
    try {
        const r = await fetch(`${API}/api/customer/payment-status?payment_id=${paymentId}`);
        const j = await r.json();

        if (j.success) {
            if (j.status === 'verified') {
                // SUCCESS!
                clearInterval(paymentPollingInterval);
                clearInterval(paymentTimerInterval);
                document.getElementById('payVerifySpinner').style.display = 'none';
                document.getElementById('payVerifyTimer').style.display = 'none';
                document.getElementById('paySuccessCard').style.display = '';
                document.getElementById('paySupportFallback').style.display = 'none';
                showToast('✅ تم التحقق من الدفع بنجاح!', 'success');
                return;
            }

            if (j.status === 'needs_review' || j.status === 'rejected') {
                // FAILED - show support fallback
                clearInterval(paymentPollingInterval);
                clearInterval(paymentTimerInterval);
                document.getElementById('payVerifySpinner').style.display = 'none';
                document.getElementById('payVerifyTimer').style.display = 'none';
                document.getElementById('paySupportFallback').style.display = '';
                document.getElementById('paySuccessCard').style.display = 'none';
                return;
            }

            // Still pending - check timeout
            const elapsed = Date.now() - paymentStartTime;
            if (elapsed >= PAYMENT_TIMEOUT_MS) {
                clearInterval(paymentPollingInterval);
                clearInterval(paymentTimerInterval);
                document.getElementById('payVerifySpinner').style.display = 'none';
                document.getElementById('payVerifyTimer').style.display = 'none';
                document.getElementById('paySupportFallback').style.display = '';
                document.getElementById('paySuccessCard').style.display = 'none';
            } else {
                // Update message
                document.getElementById('payVerifyMessage').textContent = j.message || 'جاري التحقق...';
            }
        }
    } catch (e) {
        console.error('Payment status check error:', e);
    }
}

async function checkExistingPayment(bookingId, paymentId) {
    openPaymentModal(bookingId, '', 0, 0);
    document.getElementById('payStep1').style.display = 'none';
    document.getElementById('payStep2').style.display = '';
    startVerificationPolling(paymentId);
}

// ===== BOOKINGS =====
async function loadBookings() {
    try {
        const r = await fetch(`${API}/api/bookings`);
        const j = await r.json();
        if (j.success) { allBookings = j.data; renderBookings(); }
    } catch { showToast('فشل تحميل الحجوزات', 'error'); }
}

async function loadStats() {
    try {
        const r = await fetch(`${API}/api/stats`);
        const j = await r.json();
        if (j.success) renderStats(j.data);
    } catch { }
}

async function refresh() { await Promise.all([loadBookings(), loadStats()]); }

function renderBookings() {
    const list = document.getElementById('bookingsList');
    const empty = document.getElementById('emptyState');
    const sf = document.getElementById('filterStatus').value;
    const sv = document.getElementById('searchInput').value.trim().toLowerCase();

    let filtered = allBookings;
    if (activeDay !== 'all') filtered = filtered.filter(b => String(b.renewal_day) === activeDay);
    if (sf) filtered = filtered.filter(b => b.status === sf);
    if (sv) filtered = filtered.filter(b => b.phone.includes(sv) || String(b.gigabytes).includes(sv));

    list.querySelectorAll('.booking-card').forEach(c => c.remove());
    list.querySelectorAll('.pagination-wrap').forEach(c => c.remove());
    empty.style.display = filtered.length ? 'none' : '';

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (bookingsPage > totalPages) bookingsPage = totalPages;

    const startIdx = (bookingsPage - 1) * PAGE_SIZE;
    const pageData = filtered.slice(startIdx, startIdx + PAGE_SIZE);

    pageData.forEach(b => list.appendChild(createBookingCard(b)));

    if (filtered.length > PAGE_SIZE) {
        list.insertAdjacentHTML('beforeend', `
        <div class="pagination-wrap" style="display:flex; justify-content:space-between; align-items:center; margin-top:20px; width:100%; gap:10px; background:var(--bg-card); padding:10px 15px; border-radius:var(--radius-sm); border:1px solid var(--border);">
            <button class="btn" onclick="bookingsPage = Math.max(1, bookingsPage - 1); renderBookings();" ${bookingsPage === 1 ? 'disabled' : ''} style="flex:1; padding:8px;">السابق</button>
            <div style="color:var(--text-dim); font-size:0.9rem; font-weight:700;">صفحة ${bookingsPage} من ${totalPages}</div>
            <button class="btn" onclick="bookingsPage = Math.min(${totalPages}, bookingsPage + 1); renderBookings();" ${bookingsPage === totalPages ? 'disabled' : ''} style="flex:1; padding:8px;">التالي</button>
        </div>`);
    }
}

function createBookingCard(b) {
    const div = document.createElement('div');
    const meta = STATUS_META[b.status] || STATUS_META['محجوز'];
    div.className = `booking-card ${meta.cls}`;
    div.dataset.id = b.id;
    const dayClass = b.renewal_day === 11 ? 'd11' : b.renewal_day === 25 ? 'd25' : '';
    const dateStr = new Date(b.created_at).toLocaleDateString('ar-EG', { day: '2-digit', month: 'short' });
    const curIdx = STATUSES.indexOf(b.status);
    const hasNext = curIdx < STATUSES.length - 1;
    const nextStatus = hasNext ? STATUSES[curIdx + 1] : null;
    const nextMeta = nextStatus ? STATUS_META[nextStatus] : null;

    const hasPrev = curIdx > 0;
    const prevStatus = hasPrev ? STATUSES[curIdx - 1] : null;
    const prevMeta = prevStatus ? STATUS_META[prevStatus] : null;

    // Allow password change from any step after محجوز
    const canChangePass = curIdx >= 1;

    div.innerHTML = `
    <div class="card-top">
      <div class="card-phone-wrap" style="display:flex; flex-direction:column; gap:2px;">
        <div>
            <span class="card-phone" style="direction:ltr">${b.phone}</span>
            <button class="copy-btn" title="نسخ الرقم" onclick="event.stopPropagation();copyText('${b.phone}', 'تم نسخ الرقم')">📋</button>
        </div>
        ${b.owner_username ? `<a href="https://t.me/${b.owner_username}" target="_blank" onclick="event.stopPropagation()" style="font-size:0.75rem; color:var(--primary); text-decoration:none;"><i class='bx bxl-telegram'></i> @${b.owner_username}</a>` : ''}
      </div>
      <div class="card-day-badge ${dayClass}">يوم ${b.renewal_day}</div>
    </div>
    <div class="card-pass-row">
      <span class="card-pass-label">🔑</span>
      <span class="card-pass-val" style="direction:ltr">${b.password}</span>
      <button class="copy-btn" title="نسخ الباسورد" onclick="event.stopPropagation();copyText('${b.password}', 'تم نسخ الباسورد')">📋</button>
      ${canChangePass && window.userRole === 'super' ? `<button class="copy-btn change-pass-btn" title="تغيير الباسورد" onclick="event.stopPropagation();quickChangePass(${b.id})">✏️</button>` : ''}
    </div>
    <div class="card-details">
      <div class="card-detail-pill"><span class="pill-icon">📶</span>${b.gigabytes} جيجا</div>
      <div class="card-detail-pill"><span class="pill-icon">📅</span>${dateStr}</div>
    </div>
    <div class="card-bottom">
      <div class="card-status ${meta.cls}">${meta.icon} ${b.status}</div>
      <div class="card-actions" style="display:flex; gap:4px; flex-wrap:wrap">
        ${hasPrev ? `<button class="card-action-btn" onclick="event.stopPropagation();openStepModal(${b.id}, -1)">إرجاع ${prevMeta.icon}</button>` : ''}
        ${hasNext ? `<button class="card-action-btn next-step" onclick="event.stopPropagation();openStepModal(${b.id}, 1)">${nextMeta.icon} التالي</button>` : ''}
        ${window.userRole === 'super' ? `<button class="card-action-btn" onclick="event.stopPropagation();openEditModal(${b.id})">✏️</button>
        <button class="card-action-btn delete" onclick="event.stopPropagation();deleteBooking(${b.id})">🗑️</button>` : ''}
      </div>
    </div>
    <div class="card-step-bar">
      ${STATUSES.map((_, i) => `<div class="step-bar-dot ${i <= curIdx ? 'done' : ''}" style="--i:${i}"></div>`).join('')}
    </div>
    <div class="card-gig">${b.gigabytes}G</div>
  `;
    div.addEventListener('click', () => openDetailModal(b.id));
    return div;
}

// ===== COPY HELPER =====
function copyText(text, msg = 'تم النسخ') {
    navigator.clipboard.writeText(text).then(() => showToast(`✅ ${msg}`, 'success')).catch(() => {
        // fallback
        const el = document.createElement('textarea');
        el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
        document.body.appendChild(el); el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        showToast(`✅ ${msg}`, 'success');
    });
}

// ===== QUICK CHANGE PASSWORD =====
let quickChangeId = null;
function quickChangePass(id) {
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    quickChangeId = id;
    document.getElementById('qcPassInfo').innerHTML = `
      <div class="activate-row"><span>📱 الرقم</span><strong style="direction:ltr">${b.phone}</strong></div>
      <div class="activate-row"><span>🔑 الباسورد الحالي</span><strong style="direction:ltr">${b.password}</strong></div>
    `;
    document.getElementById('qcNewPass').value = '';
    openModal('quickPassModal');
}

async function confirmQuickPass() {
    const newPass = document.getElementById('qcNewPass').value.trim();
    if (!newPass) { showToast('اكتب الباسورد الجديد', 'warning'); return; }
    const btn = document.getElementById('confirmQcBtn');
    btn.disabled = true; btn.innerHTML = '<span class="loading-spinner"></span>';
    try {
        const r = await fetch(`${API}/api/bookings/${quickChangeId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPass })
        });
        const j = await r.json();
        if (j.success) {
            showToast('🔑 تم تغيير الباسورد', 'success');
            closeModal('quickPassModal');
            await refresh();
        } else showToast(j.error, 'error');
    } catch (e) { showToast('خطأ', 'error'); }
    finally { btn.disabled = false; btn.textContent = '✅ تغيير'; quickChangeId = null; }
}

function renderStats(data) {
    [7, 11, 25].forEach(day => {
        const info = data[day] || {};
        document.getElementById(`stat-total-${day}`).textContent = info.total || 0;
        document.getElementById(`stat-breakdown-${day}`).innerHTML =
            (info.byGig || []).map(g => `<span class="stat-gig-pill">${g.gigabytes}G × ${g.count}</span>`).join('');
        document.getElementById(`stat-status-${day}`).innerHTML =
            (info.byStatus || []).map(s => {
                const m = STATUS_META[s.status] || {};
                return `<span class="stat-status-pill ${m.cls || ''}">${m.icon || ''} ${s.status}: ${s.count}</span>`;
            }).join('');
        // Payment window badge
        const wb = document.getElementById(`stat-window-${day}`);
        if (info.inWindow && info.unpaidCount !== null) {
            wb.innerHTML = `<span class="window-alert">⚠️ نافذة دفع مفتوحة · ${info.unpaidCount} لم يدفع</span>`;
        } else wb.innerHTML = '';
    });
}

// ===== FILTERS =====
function filterByDay(day, el) {
    activeDay = day;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    renderBookings();
}
function applyFilters() { renderBookings(); }

// ===== ADD MODAL =====
let inputMode = 'paste';
function openAddModal() {
    if (window.userRole !== 'super') return showToast('غير مصرح لك', 'error');
    editingId = null; selectedDay = null; selectedStatus = 'محجوز';
    document.getElementById('modalTitle').textContent = 'حجز جديد';
    ['pasteMessage', 'fPhone', 'fPassword', 'fGigabytes', 'fNewPassword'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('statusGroup').style.display = 'none';
    document.getElementById('newPassGroup').style.display = 'none';
    document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('selected'));
    switchInputTab('paste', document.querySelector('.input-tab'));
    openModal('bookingModal');
}

function openEditModal(id) {
    if (window.userRole !== 'super') return showToast('غير مصرح لك', 'error');
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    editingId = id; selectedDay = b.renewal_day; selectedStatus = b.status;
    document.getElementById('modalTitle').textContent = 'تعديل الحجز';
    document.getElementById('statusGroup').style.display = '';
    document.getElementById('fNewPassword').value = '';
    // Show new password field for any step (not just اتفعل)
    const editIdx = STATUSES.indexOf(b.status);
    document.getElementById('newPassGroup').style.display = editIdx >= 1 ? '' : 'none';
    document.getElementById('newPassGroup').querySelector('label').textContent = '🔑 تغيير الباسورد (اختياري)';
    switchInputTab('manual', document.querySelectorAll('.input-tab')[1]);
    document.getElementById('fPhone').value = b.phone;
    document.getElementById('fPassword').value = b.password;
    document.getElementById('fGigabytes').value = b.gigabytes;
    document.querySelectorAll('.day-btn').forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.day) === b.renewal_day));
    document.querySelectorAll('.step-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.status === b.status));
    openModal('bookingModal');
}

function switchInputTab(mode, el) {
    inputMode = mode;
    document.querySelectorAll('.input-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('tabPaste').classList.toggle('active', mode === 'paste');
    document.getElementById('tabManual').classList.toggle('active', mode === 'manual');
}
function selectDay(day, el) {
    selectedDay = day;
    document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('selected'));
    el.classList.add('selected');
}
function selectStatus(status, el) {
    selectedStatus = status;
    document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('selected'));
    el.classList.add('selected');
    // Show new pass field for any step after محجوز
    const idx = STATUSES.indexOf(status);
    document.getElementById('newPassGroup').style.display = idx >= 1 ? '' : 'none';
    if (idx < 1) document.getElementById('fNewPassword').value = '';
}

function parsePasteMessage(raw) {
    const lines = raw.trim().split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length !== 3) return { error: 'الرسالة يجب أن تكون 3 أسطر' };
    const [rawPhone, password, rawGig] = lines;
    if (!isNumericStr(rawPhone)) return { error: 'السطر الأول (الرقم) أرقام فقط' };
    if (!isNumericStr(rawGig)) return { error: 'السطر الثالث (الجيجات) أرقام فقط' };
    return { phone: toEnglishDigits(rawPhone).trim(), password, gigabytes: parseInt(toEnglishDigits(rawGig), 10) };
}

async function saveBooking() {
    if (!selectedDay) { showToast('اختر يوم التجديد', 'warning'); return; }
    const btn = document.getElementById('saveBtn');
    btn.disabled = true; btn.innerHTML = '<span class="loading-spinner"></span>';
    try {
        if (editingId) {
            const rawPhone = document.getElementById('fPhone').value.trim();
            const rawGig = document.getElementById('fGigabytes').value.trim();
            if (!isNumericStr(rawPhone)) { showToast('الرقم أرقام فقط', 'warning'); return; }
            if (!isNumericStr(rawGig)) { showToast('الجيجات أرقام فقط', 'warning'); return; }
            let password = document.getElementById('fPassword').value.trim();
            const newPass = document.getElementById('fNewPassword').value.trim();
            // Allow password override from any step (not just اتفعل)
            if (newPass) password = newPass;
            if (!password) { showToast('الباسورد مطلوب', 'warning'); return; }
            const r = await fetch(`${API}/api/bookings/${editingId}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: toEnglishDigits(rawPhone), password, gigabytes: parseInt(toEnglishDigits(rawGig), 10), renewal_day: selectedDay, status: selectedStatus })
            });
            const j = await r.json();
            if (j.success) { showToast('✅ تم التعديل', 'success'); closeModal('bookingModal'); await refresh(); }
            else showToast(j.error, 'error');
        } else {
            let payload;
            if (inputMode === 'paste') {
                const raw = document.getElementById('pasteMessage').value;
                if (!raw.trim()) { showToast('الصق الرسالة', 'warning'); return; }
                const p = parsePasteMessage(raw);
                if (p.error) { showToast(p.error, 'error'); return; }
                payload = { ...p, renewal_day: selectedDay };
            } else {
                const rawPhone = document.getElementById('fPhone').value.trim();
                const password = document.getElementById('fPassword').value.trim();
                const rawGig = document.getElementById('fGigabytes').value.trim();
                if (!isNumericStr(rawPhone)) { showToast('الرقم أرقام فقط', 'warning'); return; }
                if (!isNumericStr(rawGig)) { showToast('الجيجات أرقام فقط', 'warning'); return; }
                if (!rawPhone || !password || !rawGig) { showToast('جميع الحقول مطلوبة', 'warning'); return; }
                payload = { phone: toEnglishDigits(rawPhone), password, gigabytes: parseInt(toEnglishDigits(rawGig), 10), renewal_day: selectedDay };
            }
            const r = await fetch(`${API}/api/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const j = await r.json();
            if (j.success) { showToast('✅ تم الإضافة', 'success'); closeModal('bookingModal'); await refresh(); }
            else showToast(j.error, 'error');
        }
    } catch (e) { showToast('خطأ في الاتصال', 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '💾 حفظ'; }
}

// ===== STEP MODAL =====
function openStepModal(id, dir = 1) {
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    const curIdx = STATUSES.indexOf(b.status);

    // Bounds check
    const nextIdx = curIdx + dir;
    if (nextIdx < 0 || nextIdx >= STATUSES.length) return;

    stepTargetId = id;
    stepNextStatus = STATUSES[nextIdx];

    const nextMeta = STATUS_META[stepNextStatus];
    const curMeta = STATUS_META[b.status];

    const directionArrow = dir === 1 ? '›' : '‹';
    document.getElementById('stepModalTitle').textContent = `${curMeta.icon} ${b.status}  ${directionArrow}  ${nextMeta.icon} ${stepNextStatus}`;

    document.getElementById('stepInfo').innerHTML = `
    <div class="activate-row"><span>📱 الرقم</span><strong style="direction:ltr">${b.phone}</strong></div>
    <div class="activate-row"><span>🔑 الباسورد</span><strong style="direction:ltr">${b.password}</strong></div>
    <div class="activate-row"><span>📶 الجيجا</span><strong>${b.gigabytes} جيجا</strong></div>
    <div class="activate-row"><span>الخطوة المستهدفة</span><strong>${nextMeta.icon} ${stepNextStatus}</strong></div>
  `;
    // Show password field for any step transition after محجوز→ضن, ONLY for super admin
    document.getElementById('stepPassGroup').style.display = (nextIdx >= 1 && window.userRole === 'super') ? '' : 'none';
    document.getElementById('stepNewPass').value = '';
    document.getElementById('confirmStepBtn').textContent = `${nextMeta.icon} ${stepNextStatus}`;
    openModal('stepModal');
}

async function confirmStep() {
    if (!stepTargetId) return;
    const btn = document.getElementById('confirmStepBtn');
    btn.disabled = true; btn.innerHTML = '<span class="loading-spinner"></span>';
    try {
        const body = { status: stepNextStatus };
        // Always try to capture a new password from the step modal
        const stepPass = document.getElementById('stepNewPass').value.trim();
        if (stepPass) body.password = stepPass;
        const r = await fetch(`${API}/api/bookings/${stepTargetId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.success) { showToast(`${STATUS_META[stepNextStatus].icon} تم التحويل إلى ${stepNextStatus}`, 'success'); closeModal('stepModal'); await refresh(); }
        else showToast(j.error, 'error');
    } catch (e) { showToast('خطأ', 'error'); }
    finally { btn.disabled = false; const m = STATUS_META[stepNextStatus] || {}; btn.textContent = `${m.icon || ''} ${stepNextStatus}`; stepTargetId = null; stepNextStatus = null; }
}

// ===== DETAIL MODAL =====
function openDetailModal(id) {
    const b = allBookings.find(x => x.id === id);
    if (!b) return;
    const meta = STATUS_META[b.status] || {};
    let extraHTML = '';

    // Only super admins see owner
    if (window.userRole === 'super' && b.owner_tg) {
        extraHTML = `<div class="detail-row"><span class="detail-label">👤 صاحب الرقم (TG)</span><span class="detail-value ltr" style="color:var(--c3)">${b.owner_tg}</span></div>`;
    }

    document.getElementById('detailContent').innerHTML = `
    <div class="detail-row"><span class="detail-label">📱 رقم الموبايل</span><span class="detail-value" style="direction:ltr">${b.phone}</span></div>
    <div class="detail-row"><span class="detail-label">🔑 الباسورد</span><span class="detail-value" style="direction:ltr">${b.password}</span></div>
    <div class="detail-row"><span class="detail-label">📶 الجيجابايت</span><span class="detail-value">${b.gigabytes} جيجا</span></div>
    <div class="detail-row"><span class="detail-label">📅 يوم التجديد</span><span class="detail-value">يوم ${b.renewal_day}</span></div>
    <div class="detail-row"><span class="detail-label">🔄 الحالة</span><span class="detail-value step-color-${meta.cls}">${meta.icon} ${b.status}</span></div>
    ${extraHTML}
    <div class="detail-row"><span class="detail-label">🕒 تاريخ الإضافة</span><span class="detail-value" style="font-size:.8rem">${new Date(b.created_at).toLocaleString('ar-EG')}</span></div>
  `;

    if (window.userRole === 'super' || window.userRole === 'admin') {
        document.getElementById('bookingChatSection').style.display = 'block';
        window.currentOpenChatBookingId = b.id;
        loadBookingChats(b.id);
    } else {
        document.getElementById('bookingChatSection').style.display = 'none';
    }

    document.getElementById('detailEditBtn').onclick = () => { closeModal('detailModal'); openEditModal(id); };
    document.getElementById('detailDeleteBtn').onclick = () => { closeModal('detailModal'); deleteBooking(id); };
    openModal('detailModal');
}

async function loadBookingChats(id) {
    const msgBox = document.getElementById('bookingChatMessages');
    msgBox.innerHTML = '<span class="loading-spinner"></span>';
    try {
        const r = await fetch(`${API}/api/bookings/${id}/chats`);
        const j = await r.json();
        if (j.success) {
            if (j.data.length === 0) {
                msgBox.innerHTML = '<div style="text-align:center; color:var(--text-dim)">لا توجد رسائل</div>';
            } else {
                msgBox.innerHTML = j.data.map(c => {
                    const isMe = window.tgUser && (String(c.sender) === String(window.tgUser.username) || String(c.sender) === String(window.tgUser.id));
                    return `<div style="background:${isMe ? 'var(--bg-card3)' : 'rgba(59,130,246,0.1)'}; padding:6px; border-radius:4px; margin-bottom:4px;">
                        <strong style="color:var(--text); font-size:0.75rem;">${c.sender}:</strong>
                        <span style="color:var(--text-dim); margin-right:4px;">${c.message}</span>
                    </div>`;
                }).join('');
                msgBox.scrollTop = msgBox.scrollHeight;
            }
        }
    } catch (e) { }
}

async function sendBookingChat() {
    const id = window.currentOpenChatBookingId;
    if (!id) return;
    const input = document.getElementById('bookingChatMessage');
    const msg = input.value.trim();
    if (!msg) return;
    try {
        const sender = window.tgUser ? (window.tgUser.username || String(window.tgUser.id)) : 'Unknown';
        const r = await fetch(`${API}/api/bookings/${id}/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender, message: msg })
        });
        const j = await r.json();
        if (j.success) {
            input.value = '';
            loadBookingChats(id);
        }
    } catch (e) { showToast('خطأ في إرسال الرسالة', 'error'); }
}

// ===== DELETE =====
async function deleteBooking(id) {
    const b = allBookings.find(x => x.id === id);
    if (!b || !confirm(`حذف حجز ${b.phone}؟`)) return;
    const r = await fetch(`${API}/api/bookings/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.success) { showToast('🗑️ تم الحذف', 'success'); await refresh(); }
    else showToast(j.error, 'error');
}

// ============ RENEWALS VIEW ============

async function initRenewalsView() {
    // Load available months
    try {
        const r = await fetch(`${API}/api/renewals/months`);
        const j = await r.json();
        if (j.success) {
            const picker = document.getElementById('monthPicker');
            picker.innerHTML = j.data.map(ym =>
                `<option value="${ym}" ${ym === renewalYearMonth ? 'selected' : ''}>${fmtMonth(ym)}</option>`
            ).join('');
        }
    } catch (e) { }
    await loadRenewals();
}

function selectRenewalDay(day, el) {
    renewalDay = day;
    document.querySelectorAll('.day-tab-sm').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    loadRenewals();
}

async function loadRenewals() {
    const monthPicker = document.getElementById('monthPicker');
    renewalYearMonth = monthPicker ? monthPicker.value : currentMonthStr();
    try {
        const r = await fetch(`${API}/api/renewals?renewal_day=${renewalDay}&year_month=${renewalYearMonth}`);
        const j = await r.json();
        if (j.success) {
            renewalsData = j.data;
            renewalsMeta = j.meta;
            renderRenewalBanner();
            renderRenewalsSummary();
            renderRenewalsTable();
        }
    } catch (e) { showToast('فشل تحميل التجديدات', 'error'); }
}

function renderRenewalBanner() {
    const m = renewalsMeta;
    const el = document.getElementById('renewalBanner');
    if (m.inWindow) {
        el.innerHTML = `
      <div class="window-banner active">
        <div class="window-banner-icon">⚠️</div>
        <div>
          <div class="window-banner-title">نافذة الدفع مفتوحة الآن!</div>
          <div class="window-banner-sub">يوم ${m.window ? m.window.start : ''} إلى يوم ${m.window ? m.window.end : ''} من الشهر · اليوم: ${m.today}</div>
        </div>
        <div class="window-banner-stats">
          <span class="wbs paid">✅ دفعوا: ${m.paidCount}</span>
          <span class="wbs unpaid">❌ لم يدفعوا: ${m.unpaidCount}</span>
        </div>
      </div>`;
    } else {
        el.innerHTML = `
        <div class="window-banner closed">
            <div class="window-banner-icon">📅</div>
            <div>
                <div class="window-banner-title">نافذة الدفع مغلقة</div>
                <div class="window-banner-sub">تفتح من يوم ${m.window ? m.window.start : ''} إلى يوم ${m.window ? m.window.end : ''} · اليوم: ${m.today}</div>
            </div>
            <div class="window-banner-stats">
                <span class="wbs paid">✅ ${m.paidCount}</span>
                <span class="wbs unpaid">❌ ${m.unpaidCount}</span>
            </div>
        </div>`;
    }
}

function getRenewalGigBreakdown() {
    const groups = {};
    renewalsData.forEach(r => {
        const g = r.gigabytes;
        if (!groups[g]) groups[g] = { total: 0, paid: 0, unpaid: 0 };
        groups[g].total++;
        if (r.paid_this_month) groups[g].paid++;
        else groups[g].unpaid++;
    });
    return groups;
}

function renderRenewalsSummary() {
    const m = renewalsMeta;
    const pct = m.total ? Math.round(m.paidCount / m.total * 100) : 0;
    const gigs = getRenewalGigBreakdown();
    const gigKeys = Object.keys(gigs).sort((a, b) => Number(a) - Number(b));

    const gigBreakdownHTML = gigKeys.length ? `
            < div class="gig-breakdown" >
      <div class="gig-breakdown-title">📊 تفصيل حسب الجيجا</div>
      <div class="gig-breakdown-grid">
        ${gigKeys.map(g => {
        const info = gigs[g];
        const gpct = info.total ? Math.round(info.paid / info.total * 100) : 0;
        return `<div class="gig-card">
              <div class="gig-card-header">
                <span class="gig-card-size">${g}G</span>
                <span class="gig-card-total">إجمالي ${info.total}</span>
              </div>
              <div class="gig-card-stats">
                <span class="gig-stat paid">✅ ${info.paid}</span>
                <span class="gig-stat unpaid">❌ ${info.unpaid}</span>
              </div>
              <div class="gig-mini-bar"><div class="gig-mini-fill" style="width:${gpct}%"></div></div>
            </div>`;
    }).join('')}
      </div>
    </div > ` : '';

    document.getElementById('renewalsSummary').innerHTML = `
            < div class="ren-summary-grid" >
      <div class="ren-stat"><div class="ren-stat-val">${m.total || 0}</div><div class="ren-stat-lbl">إجمالي</div></div>
      <div class="ren-stat paid"><div class="ren-stat-val">${m.paidCount || 0}</div><div class="ren-stat-lbl">دفعوا</div></div>
      <div class="ren-stat unpaid"><div class="ren-stat-val">${m.unpaidCount || 0}</div><div class="ren-stat-lbl">لم يدفعوا</div></div>
      <div class="ren-stat"><div class="ren-stat-val">${pct}%</div><div class="ren-stat-lbl">نسبة الدفع</div></div>
    </div >
            <div class="pay-progress-bar"><div class="pay-progress-fill" style="width:${pct}%"></div></div>
    ${gigBreakdownHTML}
        `;
}



function renderRenewalsTable() {
    const fEl = document.getElementById('renewalPayFilter');
    const filter = fEl ? fEl.value : '';
    const sEl = document.getElementById('renewalSearch');
    const src = sEl ? sEl.value.trim() : '';
    const tbody = document.getElementById('renewalsBody');
    if (!tbody) { console.error('renewalsBody missing'); return; }

    let dataToRender = renewalsData;
    if (window.userRole === 'admin') dataToRender = dataToRender.filter(b => b.paid_this_month);

    if (filter === 'paid') dataToRender = dataToRender.filter(r => r.paid_this_month);
    else if (filter === 'unpaid') dataToRender = dataToRender.filter(r => !r.paid_this_month);

    if (src) dataToRender = dataToRender.filter(r => String(r.phone).includes(src) || String(r.gigabytes).includes(src));

    if (!dataToRender.length) {
        tbody.innerHTML = `< div class="empty-state" ><div class="empty-icon"><i class='bx bx-calendar-x bx-tada' style='color:var(--primary)'></i></div><div class="empty-title">لا توجد نتائج</div><div class="empty-sub">الرجاء اختيار يوم تجديد مختلف أو لا يوجد أرقام مسجلة</div></div > `;
        return;
    }

    const totalPages = Math.max(1, Math.ceil(dataToRender.length / PAGE_SIZE));
    if (renewalsPage > totalPages) renewalsPage = totalPages;

    const startIdx = (renewalsPage - 1) * PAGE_SIZE;
    const pageData = dataToRender.slice(startIdx, startIdx + PAGE_SIZE);

    tbody.innerHTML = pageData.map(r => {
        const sm = STATUS_META[r.status] || STATUS_META['محجوز'];
        let payStatusHTML = r.paid_this_month ? `< span style = "color:var(--c4)" >✅ دفع</span > ` : ` < span style = "color:var(--c1)" >❌ لم يدفع</span > `;

        let actionBtnHTML = '';
        if (window.userRole === 'admin') {
            const activated = r.payment?.activated === 1;
            actionBtnHTML = `< button class="btn ${activated ? 'btn-ghost' : 'btn-primary'}" onclick = "event.stopPropagation(); toggleActivate(${r.id})" style = "padding:6px; font-size: 0.9rem;" > ${activated ? '↩️ غير مجدد' : '🚀 تم التجديد'}</button > `;
        } else {
            actionBtnHTML = `< button class="btn ${r.paid_this_month ? 'btn-ghost' : 'btn-primary'}" onclick = "event.stopPropagation(); togglePayment(${r.id})" style = "padding:6px; font-size: 0.9rem;" > ${r.paid_this_month ? '↩️ إلغاء الدفع' : '✅ تسجيل الدفع'}</button > `;
        }

        return `
            < div class="booking-card ${r.paid_this_month ? 'paid-card' : ''}" onclick = "openRenewalDetail(${r.id})" >
          <div class="card-top">
            <div class="card-phone-wrap" style="display:flex; flex-direction:column; gap:2px;">
              <span class="card-phone" style="direction:ltr">${r.phone}</span>
            </div>
            <div class="card-day-badge">يوم ${r.renewal_day}</div>
          </div>
          <div class="card-pass-row">
            <span class="card-pass-label">🔑</span>
            <span class="card-pass-val" style="direction:ltr">${r.password}</span>
          </div>
          <div class="card-details" style="display:flex; gap:8px; flex-wrap:wrap">
            <div class="card-detail-pill"><span class="pill-icon">📶</span>${r.gigabytes} جيجا</div>
            <div class="card-detail-pill"><span class="pill-icon">🔄</span>${r.renewal_count} مرة</div>
            <div class="card-detail-pill"><span class="pill-icon">💰</span>${payStatusHTML}</div>
          </div>
          <div class="card-bottom" style="margin-top:10px; display:flex; justify-content:space-between; align-items:center;">
             <span class="card-status ${sm.cls}">${sm.icon} ${r.status}</span>
             ${actionBtnHTML}
          </div>
        </div > `;
    }).join('');

    if (dataToRender.length > PAGE_SIZE) {
        tbody.insertAdjacentHTML('beforeend', `
            < div class="pagination-wrap" style = "display:flex; justify-content:space-between; align-items:center; margin-top:20px; width:100%; gap:10px; background:var(--bg-card); padding:10px 15px; border-radius:var(--radius-sm); border:1px solid var(--border);" >
            <button class="btn" onclick="renewalsPage = Math.max(1, renewalsPage - 1); renderRenewalsTable();" ${renewalsPage === 1 ? 'disabled' : ''} style="flex:1; padding:8px;">السابق</button>
            <div style="color:var(--text-dim); font-size:0.9rem; font-weight:700;">صفحة ${renewalsPage} من ${totalPages}</div>
            <button class="btn" onclick="renewalsPage = Math.min(${totalPages}, renewalsPage + 1); renderRenewalsTable();" ${renewalsPage === totalPages ? 'disabled' : ''} style="flex:1; padding:8px;">التالي</button>
        </div > `);
    }
}

// ===== RENEWAL DETAIL POPUP =====
function openRenewalDetail(bookingId) {
    const r = renewalsData.find(x => x.id === bookingId);
    if (!r) return;
    const sm = STATUS_META[r.status] || {};

    document.getElementById('rdPhone').textContent = r.phone;
    document.getElementById('rdPassword').textContent = r.password;
    document.getElementById('rdGig').textContent = `${r.gigabytes} جيجا`;
    document.getElementById('rdStatus').innerHTML = `< span class="mini-status ${sm.cls}" > ${sm.icon} ${r.status}</span > `;
    document.getElementById('rdRenewals').textContent = `${r.renewal_count} مرة`;
    document.getElementById('rdAdded').textContent = fmtDate(r.created_at);
    document.getElementById('rdPaid').innerHTML = r.paid_this_month
        ? `< span style = "color:var(--c4)" >✅ دفع</span > `
        : `< span style = "color:var(--c1)" >❌ لم يدفع</span > `;
    // Wire copy buttons
    document.getElementById('rdCopyPhone').onclick = () => copyText(r.phone, 'تم نسخ الرقم');
    document.getElementById('rdCopyPass').onclick = () => copyText(r.password, 'تم نسخ الباسورد');
    document.getElementById('rdPayBtn').textContent = r.paid_this_month ? '↩️ إلغاء الدفع' : '✅ تسجيل الدفع';
    document.getElementById('rdPayBtn').className = `btn ${r.paid_this_month ? 'btn-ghost' : 'btn-primary'} `;
    document.getElementById('rdPayBtn').onclick = async () => { await togglePayment(r.id); closeModal('renewalDetailModal'); };
    openModal('renewalDetailModal');
}

async function togglePayment(bookingId) {
    try {
        const r = await fetch(`${API} /api/renewals / toggle`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ booking_id: bookingId, year_month: renewalYearMonth, renewal_day: renewalDay })
        });
        const j = await r.json();
        if (j.success) {
            const idx = renewalsData.findIndex(x => x.id === bookingId);
            if (idx !== -1) {
                renewalsData[idx].paid_this_month = j.data.paid === 1;
                renewalsData[idx].payment = j.data;
                if (j.data.paid) renewalsData[idx].renewal_count++;
                else renewalsData[idx].renewal_count = Math.max(0, renewalsData[idx].renewal_count - 1);
            }
            renewalsMeta.paidCount = renewalsData.filter(x => x.paid_this_month).length;
            renewalsMeta.unpaidCount = renewalsData.length - renewalsMeta.paidCount;
            renderRenewalBanner();
            renderRenewalsSummary();
            renderRenewalsTable();
            showToast(j.data.paid ? '✅ تم تسجيل الدفع' : '↩️ تم إلغاء الدفع', 'success');
        } else showToast(j.error, 'error');
    } catch (e) { showToast('خطأ', 'error'); }
}

// ===== TRASH =====
let trashList = [];
async function loadTrash() {
    try {
        const r = await fetch(`${API} /api/bookings ? include_deleted = true`);
        const j = await r.json();
        if (j.success) {
            trashList = j.data.filter(b => b.deleted_at !== null);
            renderTrash();
        }
    } catch (e) { showToast('خطأ في تحميل المهملات', 'error'); }
}

function renderTrash() {
    const tbody = document.getElementById('trashBody');
    if (!trashList.length) {
        tbody.innerHTML = `< tr > <td colspan="4" class="table-empty">سلة المهملات فارغة</td></tr > `;
        return;
    }
    tbody.innerHTML = trashList.map(t => {
        const delDate = new Date(t.deleted_at).toLocaleDateString('ar-EG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        return `
            < tr >
            <td style="direction:ltr; text-align:right">${t.phone}</td>
            <td>${t.gigabytes}G</td>
            <td>${delDate}</td>
            <td>
                <button class="btn btn-warning" onclick="restoreBooking(${t.id})" style="padding:4px 10px; font-size:.75rem">↩️ استعادة</button>
                <button class="btn btn-danger" onclick="permanentDeleteBooking(${t.id})" style="padding:4px 10px; font-size:.75rem">🗑️ إبادة</button>
            </td>
        </tr > `;
    }).join('');
}

async function restoreBooking(id) {
    if (!confirm('استعادة هذا الحجز؟')) return;
    try {
        const r = await fetch(`${API} /api/bookings / ${id}/restore`, { method: 'POST' });
        const j = await r.json();
        if (j.success) { showToast('✅ تم الاستعادة', 'success'); loadTrash(); refresh(); }
    } catch (e) { showToast('خطأ', 'error'); }
}

async function permanentDeleteBooking(id) {
    if (!confirm('سيتم حذفه نهائياً، هل أنت متأكد؟')) return;
    try {
        const r = await fetch(`${API}/api/bookings/${id}/permanent`, { method: 'DELETE' });
        const j = await r.json();
        if (j.success) { showToast('🗑️ تم الحذف النهائي', 'success'); loadTrash(); }
    } catch (e) { showToast('خطأ', 'error'); }
}

// ===== VF PORTAL =====
async function checkVfPassword() {
    const phone = document.getElementById('vfCheckPhone').value.trim();
    const pass = document.getElementById('vfCheckPass').value.trim();
    const resEl = document.getElementById('vfCheckResult');

    if (!phone || !pass) { showToast('أدخل الرقم والباسورد', 'warning'); return; }

    resEl.innerHTML = '<span class="loading-spinner"></span> جاري التحقق...';
    resEl.style.color = 'inherit';

    try {
        const r = await fetch(`${API}/api/vf-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password: pass })
        });
        const j = await r.json();
        if (j.success) {
            if (j.result === 'valid') {
                let html = `<div style="color:var(--c4); margin-bottom:10px;">${(j.message || '✅ الباسورد صحيح')}</div>`;
                if (j.details) {
                    const d = j.details;
                    html += `
                    <div style="background:var(--bg-card2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px; text-align:right; font-size:0.9rem; color:var(--text); line-height:1.6;">
                        <div>👤 <b>الاسم:</b> ${d.name || 'غير معروف'}</div>
                        <div>📱 <b>الرقم:</b> <span style="direction:ltr; display:inline-block">${d.msisdn}</span></div>
                        <div>💎 <b>النظام الحالي:</b> ${d.currentPlan || '-'}</div>
                        <div>💰 <b>الرصيد:</b> ${d.balance ? d.balance + ' جنيه' : '-'}</div>
                        <div>🎁 <b>فودافون وان:</b> ${d.loyaltyStatus || '-'}</div>
                    </div>`;
                }
                if (window.userRole === 'super') {
                    html += `
                    <div style="margin-top:15px; border-top: 1px solid var(--border); padding-top: 10px;">
                        <button class="btn btn-primary" style="width:100%; justify-content:center;" onclick="openAddModalFromPortal('${phone}', '${pass}')">
                            ➕ إضافة إلى الحجز
                        </button>
                    </div>`;
                }
                resEl.innerHTML = html;
            } else {
                resEl.innerHTML = `<span style="color:var(--c1)">${(j.message || '❌ الباسورد خاطئ')}</span>`;
            }
        } else {
            resEl.innerHTML = `<span style="color:var(--c2)">⚠️ خطأ في الفحص: ${j.error}</span>`;
        }
    } catch (e) {
        resEl.innerHTML = '<span style="color:var(--c2)">⚠️ فشل الاتصال بنظام الفحص</span>';
    }
}

function openAddModalFromPortal(phone, pass) {
    if (window.userRole !== 'super') return;
    openAddModal();
    switchInputTab('manual', document.querySelectorAll('.input-tab')[1]);
    document.getElementById('fPhone').value = phone;
    document.getElementById('fPassword').value = pass;
}

function openModal(id) { document.getElementById(id).classList.add('open'); document.body.style.overflow = 'hidden'; }
function closeModal(id) { document.getElementById(id).classList.remove('open'); document.body.style.overflow = ''; }

// ===== TOAST =====
let toastTimeout;
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = `toast show ${type}`;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { t.className = 'toast'; }, 3000);
}
// ===== ADMINS VIEW =====
let adminsList = [];
async function loadAdmins() {
    try {
        const r = await fetch(`${API}/api/admins`);
        const j = await r.json();
        if (j.success) {
            adminsList = j.data;
            renderAdmins();
        }
    } catch (e) { showToast('خطأ في تحميل الموظفين', 'error'); }
}

function renderAdmins() {
    const tbody = document.getElementById('adminsBody');
    if (!adminsList.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="table-empty">لا يوجد موظفين مضافين</td></tr>`;
        return;
    }
    tbody.innerHTML = adminsList.map((a, i) => `
        <tr>
            <td>${i + 1}</td>
            <td style="font-weight:700">${a.name || '-'}</td>
            <td style="direction:ltr; text-align:right"><code>${a.tg_id}</code> <button class="copy-btn" onclick="copyText('${a.tg_id}')" style="display:inline-block; vertical-align:middle; width:20px; height:20px; font-size:10px">📋</button></td>
            <td>
                <button class="btn btn-danger" onclick="deleteAdmin(${a.id}, '${a.name || a.tg_id}')" style="padding:4px 10px; font-size:.75rem">🗑️ حذف</button>
            </td>
        </tr>
    `).join('');
}

async function addAdmin() {
    const tg_id = document.getElementById('adminTgId').value.trim();
    const name = document.getElementById('adminName').value.trim();
    if (!tg_id) { showToast('الآي دي مطلوب', 'warning'); return; }

    try {
        const r = await fetch(`${API}/api/admins`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tg_id, name })
        });
        const j = await r.json();
        if (j.success) {
            showToast('✅ تم الإضافة', 'success');
            document.getElementById('adminTgId').value = '';
            document.getElementById('adminName').value = '';
            loadAdmins();
        }
        else showToast(j.error, 'error');
    } catch (e) { showToast('خطأ', 'error'); }
}

async function deleteAdmin(id, name) {
    if (!confirm(`متأكد من حذف الموظف: ${name}؟`)) return;
    try {
        const r = await fetch(`${API}/api/admins/${id}`, { method: 'DELETE' });
        const j = await r.json();
        if (j.success) {
            showToast('🗑️ تم الحذف', 'success');
            loadAdmins();
        }
    } catch (e) { showToast('خطأ', 'error'); }
}

// ===== SETTINGS VIEW =====
async function saveBotToken() {
    const token = document.getElementById('botTokenInput').value.trim();
    if (!token) { showToast('يرجى إدخال التوكن', 'warning'); return; }

    try {
        const r = await fetch(`${API}/api/bot/setup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const j = await r.json();
        if (j.success) {
            showToast('✅ تم تفعيل البوت وربطه بنجاح', 'success');
            document.getElementById('botTokenInput').value = '';
        } else {
            showToast('خطأ: ' + j.error, 'error');
        }
    } catch (e) { showToast('خطأ في الاتصال بالسيرفر', 'error'); }
}




// ===== ADMIN ACTIONS =====


let bulkCheckAbort = false;

function openBulkCheckModal() {
    document.getElementById('bulkCheckBody').innerHTML = '';
    document.getElementById('bulkCheckProgress').innerText = 'يتم تحضير الأرقام...';
    document.getElementById('bulkCheckDone').style.display = 'none';
    openModal('bulkCheckModal');
}

async function startBulkCheck(source = 'all') {
    if (!confirm('سيبدأ الفحص السريع للأرقام المطلوبة.. استمر؟')) return;
    bulkCheckAbort = false;
    openBulkCheckModal();
    const progressEl = document.getElementById('bulkCheckProgress');
    const tbody = document.getElementById('bulkCheckBody');

    let data = [];
    if (source === 'renewals') {
        data = renewalsData.filter(r => r.status === 'متأكتف');
    } else if (source === 'reserved') {
        data = allBookings.filter(b => b.status === 'محجوز');
    } else if (source === 'activated') {
        data = allBookings.filter(b => b.status === 'متأكتف');
    } else if (source === 'activated_step') {
        data = allBookings.filter(b => b.status === 'اتفعل');
    } else {
        data = allBookings.filter(b => b.status !== 'متكنسل');
    }

    if (!data.length) {
        progressEl.innerText = 'لا توجد أرقام قابلة للفحص في هذه القائمة.';
        return;
    }

    let badCount = 0;
    let checkedCount = 0;
    const CHUNK_SIZE = 10; // New fast system can handle 10 parallel requests easily

    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
        if (bulkCheckAbort) break;
        const chunk = data.slice(i, i + CHUNK_SIZE);
        progressEl.innerText = `جاري فحص مجموعة ${i + 1} إلى ${Math.min(i + CHUNK_SIZE, data.length)} من أصل ${data.length}...`;

        const promises = chunk.map(async (r) => {
            try {
                const req = await fetch(API + '/api/admin/check-password', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: toEnglishDigits(r.phone), password: r.password })
                });
                const j = await req.json();
                if (j.success && !j.valid) {
                    badCount++;
                    // Add row to modal table
                    const tr = document.createElement('tr');
                    tr.dataset.phone = r.phone;
                    tr.innerHTML = `
                         <td style="direction:ltr; text-align:right"><code>${r.phone}</code></td>
                         <td style="direction:ltr; text-align:right; color:var(--c1)"><strong>${r.password}</strong></td>
                         <td style="display:flex; gap:4px; max-width:120px; flex-wrap:wrap">
                            <button class="btn btn-ghost" onclick="copyText('${r.phone}')" style="padding:4px;" title="نسخ الرقم">📋</button>
                            <button class="btn btn-warning" onclick="openRenewalDetail(${r.id}); closeModal('bulkCheckModal')" style="padding:4px 10px; font-size:.75rem">تعديل</button>
                         </td>
                    `;
                    tbody.appendChild(tr);
                }
            } catch (e) { console.error('Check fail', e); }
        });

        await Promise.all(promises);
        checkedCount += chunk.length;
    }

    progressEl.innerText = `اكتمل فحص ${checkedCount} أرقام. تم العثور على ${badCount} أرقام بخطأ في الباسورد.`;
    document.getElementById('bulkCheckDone').style.display = 'block';
}

function copyAllBulkPhones() {
    const rows = document.querySelectorAll('#bulkCheckBody tr');
    const phones = [];
    rows.forEach(r => {
        const tds = r.querySelectorAll('td');
        if (tds.length > 0) phones.push(tds[0].textContent.trim());
    });
    if (phones.length === 0) return showToast('لا توجد أرقام', 'error');
    copyText(phones.join('\n'), `تم نسخ ${phones.length} رقم`);
}

// ===== ADMIN PAYMENTS REVIEW =====
let pendingPayments = [];
let rejectingPaymentId = null;

async function loadPendingPayments() {
    try {
        const res = await fetch(`${API}/api/customer/pending-payments`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        pendingPayments = data.data || [];
        renderPendingPayments();
    } catch (e) {
        showToast('خطأ في تحميل الدفعات: ' + e.message, 'error');
    }
}

function renderPendingPayments() {
    const container = document.getElementById('pendingPaymentsList');
    const countEl = document.getElementById('pendingPaymentsCount');
    const reviewCountEl = document.getElementById('needsReviewCount');

    const pendingOnly = pendingPayments.filter(p => p.status === 'pending');
    const needsReview = pendingPayments.filter(p => p.status === 'needs_review');

    if (countEl) countEl.textContent = pendingOnly.length;
    if (reviewCountEl) reviewCountEl.textContent = needsReview.length;

    if (pendingPayments.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon"><i class='bx bx-check-circle bx-flashing' style='color: var(--c4);'></i></div>
                <div class="empty-title">لا توجد دفعات معلقة 🎉</div>
                <div class="empty-sub">جميع الدفعات تمت مراجعتها</div>
            </div>`;
        return;
    }

    // Sort: needs_review first, then pending
    const sorted = [...pendingPayments].sort((a, b) => {
        if (a.status === 'needs_review' && b.status !== 'needs_review') return -1;
        if (b.status === 'needs_review' && a.status !== 'needs_review') return 1;
        return new Date(b.created_at) - new Date(a.created_at);
    });

    container.innerHTML = sorted.map(p => {
        const isUrgent = p.status === 'needs_review';
        const methodLabel = p.method === 'vodafone_cash' ? '📱 فودافون كاش' : '🏦 إنستا باي';
        const createdDate = new Date(p.created_at);
        const timeAgo = getTimeAgo(createdDate);

        return `
        <div class="payment-review-card ${isUrgent ? 'urgent' : ''}">
            <div class="prc-header">
                <div class="prc-phone-wrap">
                    <span class="prc-phone">${p.phone || 'N/A'}</span>
                    <span class="prc-gig">${p.gigabytes || '?'} جيجا</span>
                </div>
                <span class="prc-status ${isUrgent ? 'urgent' : 'pending'}">
                    ${isUrgent ? '⚠️ تحتاج مراجعة' : '⏳ معلقة'}
                </span>
            </div>
            
            <div class="prc-details">
                <div class="prc-detail">
                    <span class="prc-detail-label">طريقة الدفع</span>
                    <span class="prc-detail-value">${methodLabel}</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">رقم المحول منه</span>
                    <span class="prc-detail-value ltr">${p.sender_phone || '—'}</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">رقم العملية</span>
                    <span class="prc-detail-value ltr" style="font-weight:700; color: var(--c2);">${p.transaction_ref || '—'}</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">قيمة الاشتراك</span>
                    <span class="prc-detail-value" style="color: var(--primary); font-weight:700;">${p.amount ? p.amount : getPackagePrice(p.gigabytes)} ج.م</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">الشهر</span>
                    <span class="prc-detail-value">${fmtMonth(p.year_month)}</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">رقم التجديد</span>
                    <span class="prc-detail-value" style="color: var(--c4); font-weight:700;">التجديد رقم ${p.renewal_count + 1}</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">يوم التجديد</span>
                    <span class="prc-detail-value">يوم ${p.renewal_day || '?'}</span>
                </div>
                <div class="prc-detail">
                    <span class="prc-detail-label">وقت الإرسال</span>
                    <span class="prc-detail-value">${timeAgo}</span>
                </div>
            </div>

            <div class="prc-actions">
                <button class="btn prc-approve-btn" onclick="approvePayment(${p.id})">
                    <i class='bx bx-check-circle'></i> قبول الدفعة
                </button>
                <button class="btn prc-reject-btn" onclick="openRejectModal(${p.id})">
                    <i class='bx bx-x-circle'></i> رفض
                </button>
            </div>
        </div>`;
    }).join('');
}





function getTimeAgo(date) {
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return 'الآن';
    if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
    if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
    return `منذ ${Math.floor(diff / 86400)} يوم`;
}

async function approvePayment(paymentId) {
    if (!confirm('هل أنت متأكد من قبول هذه الدفعة؟ سيتم تسجيلها كدفعة ناجحة.')) return;
    try {
        const res = await fetch(`${API}/api/customer/verify-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_id: paymentId, action: 'approve' })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        showToast('✅ تم قبول الدفعة وتسجيلها بنجاح');
        loadPendingPayments();
    } catch (e) {
        showToast('خطأ: ' + e.message, 'error');
    }
}

function openRejectModal(paymentId) {
    rejectingPaymentId = paymentId;
    document.getElementById('rejectPaymentReason').value = '';
    openModal('rejectPaymentModal');
}

async function confirmRejectPayment() {
    if (!rejectingPaymentId) return;
    const reason = document.getElementById('rejectPaymentReason').value.trim() || 'مرفوض';
    try {
        const res = await fetch(`${API}/api/customer/verify-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payment_id: rejectingPaymentId, action: 'reject', reason })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        closeModal('rejectPaymentModal');
        showToast('❌ تم رفض الدفعة');
        rejectingPaymentId = null;
        loadPendingPayments();
    } catch (e) {
        showToast('خطأ: ' + e.message, 'error');
    }
}
// ===== USERS ========
async function loadUsers() {
    try {
        const res = await fetch(`${API}/api/customer/all-users`);
        const json = await res.json();

        const tbody = document.getElementById('usersBody');
        const unBody = document.getElementById('usersUnlinkedBody');

        if (json.success) {
            tbody.innerHTML = json.linked.map(u => {
                const safeTg = escapeHtml(u.owner_tg || '');
                const safeName = escapeHtml(u.owner_username || ('ID: ' + u.owner_tg));
                const safeDetails = escapeHtml(u.details || '');
                return `
                <tr>
                    <td><div style="font-weight:700; color:var(--primary);">${safeName}</div></td>
                    <td class="ltr">${safeTg}</td>
                    <td>
                        <button class="btn btn-ghost" style="padding: 4px 8px; font-size: 0.8rem;" onclick="openUserDetails('${safeName}', '${safeTg}', '${safeDetails}')">📜 مشاهدة الأرقام</button>
                    </td>
                    <td>
                        <button class="btn btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="openSendMessage('${safeTg}')">إرسال 💬</button>
                    </td>
                </tr>
                `;
            }).join('');
            if (json.linked.length === 0) tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;">لا يوجد عملاء مسجلين بعد</td></tr>`;

            unBody.innerHTML = json.unlinked.map(u => `
                <tr>
                    <td class="ltr">${u.phone}</td>
                    <td>${u.gigabytes} جيجا</td>
                    <td>يوم ${u.renewal_day}</td>
                </tr>
            `).join('');
            if (json.unlinked.length === 0) unBody.innerHTML = `<tr><td colspan="3" style="text-align:center;">لا يوجد أرقام غير مربوطة</td></tr>`;
        }
    } catch (e) { }
}

function escapeHtml(unsafe) {
    return (unsafe || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function toggleUserStats(type) {
    document.getElementById('tabLinked').classList.toggle('active', type === 'linked');
    document.getElementById('tabUnlinked').classList.toggle('active', type === 'unlinked');

    document.getElementById('usersLinkedWrap').style.display = type === 'linked' ? 'block' : 'none';
    document.getElementById('usersUnlinkedWrap').style.display = type === 'unlinked' ? 'block' : 'none';
}

function openUserDetails(name, tgId, detailsStr) {
    const list = detailsStr.split(',');
    const container = document.getElementById('userDetailsBody');
    container.innerHTML = `<h4 style="margin-bottom:5px;">أرقام العميل: <span style="color:var(--primary)">${name}</span></h4>`;

    list.forEach(item => {
        const [phone, gig, day] = item.split('|');
        if (!phone) return;
        const msg = encodeURIComponent(`⚠️ تذكير هام:\nنرجو دفع باقتك لرقم ${phone} (${gig} جيجا تجديد يوم ${day}) لتجنب إيقاف خطك.`);

        container.innerHTML += `
        <div class="pay-info-card" style="display:flex; flex-direction:column; gap:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="ltr" style="font-weight:bold; font-size:1.1rem;">${phone}</span>
                <span class="badge" style="background:var(--bg-card2); color:white;">${gig} جيجا</span>
            </div>
            <div style="font-size:0.85rem; color:var(--text-dim);">تجديد يوم ${day}</div>
            <button class="btn btn-primary" style="margin-top:5px; align-self:flex-start;" onclick="openSendMessage('${tgId}', decodeURIComponent('${msg}'))">
                <i class='bx bx-bell'></i> إرسال تذكير لهذه الباقة
            </button>
        </div>
        `;
    });

    openModal('userDetailsModal');
}

async function sendBulkReminders() {
    const day = document.getElementById('bulkRemindDay').value;
    if (!confirm(`هل أنت متأكد من إرسال تذكير لكل من لم يدفع في باقة يوم ${day}؟`)) return;

    try {
        const r = await fetch(`${API}/api/admin/manual-bulk-remind`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ day })
        });
        const j = await r.json();
        if (j.success) showToast(`✅ تم إرسال ${j.sent} إشعار بنجاح!`, 'success');
        else showToast('خطأ: ' + j.error, 'error');
    } catch (e) {
        showToast('خطأ بالانترنت', 'error');
    }
}

let targetMessageTgId = null;

function openSendMessage(tgId, overrideText = '') {
    targetMessageTgId = tgId;
    document.getElementById('userMessageText').value = overrideText;
    openModal('sendMessageModal');
}

async function confirmSendMessage() {
    const text = document.getElementById('userMessageText').value.trim();
    if (!text) {
        showToast('برجاء كتابة الرسالة', 'warning');
        return;
    }

    const btn = document.getElementById('btnSendMsg');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-spinner"></span>';

    try {
        const r = await fetch(`${API}/api/admin/send-user-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tg_id: targetMessageTgId, message: text })
        });
        const j = await r.json();

        if (j.success) {
            showToast('✅ تم إرسال الرسالة بنجاح', 'success');
            closeModal('sendMessageModal');
        } else {
            showToast('خطأ: ' + j.error, 'error');
        }
    } catch (e) {
        showToast('خطأ في الشبكة', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = "إرسال <i class='bx bx-send' style='margin-right:5px;'></i>";
    }
}
