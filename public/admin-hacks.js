// --- VODAFONE RED ADMIN HACKS ---
(function () {
    console.log("Admin Hacks Injected");

    // we can check if they are super admin by checking parent window
    let isAdmin = false;
    try {
        if (window.parent && window.parent.userRole === 'Super Admin') {
            isAdmin = true;
        } else if (window.parent && window.tgUser && window.tgUser.id == '1255885099') {
            isAdmin = true;
        }
    } catch (e) { }

    // Always fallback to showing it for testing if role check fails but we are in admin UI
    if (!isAdmin) {
        // Maybe just show it since admin-ui only loads for admins anyway
        // But to restrict to Super Admin securely, we rely on parent window.
        if (window.parent && (window.parent.userRole === 'Super Admin' || window.parent.userRole === 'super')) isAdmin = true;
        if (window.parent && window.parent.adminData && window.parent.adminData.role === 'Super Admin') isAdmin = true;
        // Force show if we have '1255885099' anywhere in parent
        if (window.parent && JSON.stringify(window.parent.tgUser || {}).includes('1255885099')) isAdmin = true;
    }

    if (isAdmin) {
        setTimeout(injectAdminOverlay, 2000);
    }

    function injectAdminOverlay() {
        if (document.getElementById('closed-days-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'closed-days-btn';
        btn.innerHTML = `⚙️ إغلاق أيام`;
        btn.style.cssText = "position: fixed; bottom: 80px; left: 20px; z-index: 99999; background: #E4405F; color: white; border: none; padding: 10px 15px; border-radius: 20px; font-family: 'Tajawal'; font-weight: bold; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3);";

        btn.onclick = openSettings;
        document.body.appendChild(btn);
    }

    function openSettings() {
        const existing = document.getElementById('closed-days-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'closed-days-modal';
        modal.style.cssText = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 100000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(5px);";

        const box = document.createElement('div');
        box.style.cssText = "background: #111; border: 1px solid #333; padding: 25px; border-radius: 15px; width: 90%; max-width: 400px; color: white; font-family: 'Tajawal'; direction: rtl; position: relative;";

        box.innerHTML = `
            <h3 style="margin-top:0; color: #A2E02D;">🔒 إدارة حجز الأيام</h3>
            <p style="font-size: 0.9rem; color: #aaa;">حدد الأيام التي تريد <b>وقف قبول خطوط جديدة</b> فيها ليظهر للعميل (تم الاكتفاء)</p>
            <div id="days-grid" style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px;"></div>
            <button id="save-days-btn" style="background: #A2E02D; color: #000; font-weight: bold; width: 100%; border: none; padding: 10px; border-radius: 8px; cursor: pointer;">💾 حفظ الإعدادات</button>
            <button id="close-modal-btn" style="background: transparent; color: #fff; width: 100%; border: none; padding: 10px; border-radius: 8px; cursor: pointer; margin-top: 5px;">إلغاء</button>
        `;

        modal.appendChild(box);
        document.body.appendChild(modal);

        document.getElementById('close-modal-btn').onclick = () => modal.remove();

        // Render days
        const grid = document.getElementById('days-grid');
        const allowedDays = [1, 5, 7, 10, 11, 15, 20, 25]; // typical Vodafone renewal days

        // fetch current
        fetch('/api/admin/closed-days').then(r => r.json()).then(res => {
            let closed = res.closed_days || [];

            allowedDays.forEach(d => {
                const dayBtn = document.createElement('div');
                const isClosed = closed.includes(d);
                dayBtn.style.cssText = `padding: 8px 15px; border-radius: 5px; cursor: pointer; border: 1px solid #444; background: ${isClosed ? '#E4405F' : '#222'}`;
                dayBtn.innerText = 'يوم ' + d;
                dayBtn.dataset.day = d;
                dayBtn.dataset.closed = isClosed ? '1' : '0';

                dayBtn.onclick = () => {
                    if (dayBtn.dataset.closed === '1') {
                        dayBtn.dataset.closed = '0';
                        dayBtn.style.background = '#222';
                    } else {
                        dayBtn.dataset.closed = '1';
                        dayBtn.style.background = '#E4405F';
                    }
                };
                grid.appendChild(dayBtn);
            });

            document.getElementById('save-days-btn').onclick = () => {
                const newClosed = [];
                Array.from(grid.children).forEach(btn => {
                    if (btn.dataset.closed === '1') newClosed.push(parseInt(btn.dataset.day));
                });

                document.getElementById('save-days-btn').innerText = 'جاري الحفظ...';
                fetch('/api/admin/closed-days', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ days: newClosed })
                }).then(r => r.json()).then(r => {
                    alert('تم الحفظ بنجاح!');
                    modal.remove();
                });
            };
        });
    }

})();
