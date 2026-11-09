// --- VODAFONE RED SURGICAL HACKS ---
(function () {
    console.log("Vodafone Red Custom Hack Injected V3 (DOM-based)");

    // We use setInterval to continuously watch the DOM and apply our fixes over React
    setInterval(() => {
        // 1. Unlink buttons
        const phoneNodes = Array.from(document.querySelectorAll('span, p, div, strong')).filter(el => {
            const normalized = el.textContent.trim().replace(/\s/g, '');
            return normalized.match(/^01\d{9}$/) && el.children.length === 0;
        });

        phoneNodes.forEach(node => {
            const parent = node.parentElement;
            if (parent && !parent.querySelector('.unlink-btn-hack') && !node.classList.contains('unlink-btn-hack')) {
                if (parent.closest('button')) return;

                const btn = document.createElement('button');
                btn.className = 'unlink-btn-hack';
                btn.innerHTML = `🗑️`;
                btn.title = "الغاء ارتباط الخط بحسابك";
                btn.style.cssText = "background: rgba(230,0,0,0.1); border: 1px solid red; color: red; border-radius: 5px; cursor: pointer; padding: 3px 8px; font-size: 0.8rem; font-family: 'Tajawal'; display: inline-flex; align-items: center; justify-content: center; margin-right: 5px;";

                // insert closely
                parent.insertBefore(btn, node.nextSibling);

                btn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const phoneRaw = node.textContent.replace('🗑️', '').replace(/\s/g, '').trim();
                    if (confirm('إلغاء ارتباط الرقم ' + phoneRaw + '؟ (لن يُحذف من السيستم)')) {
                        const pass = prompt('يرجى إدخال باسورد الخط لتأكيد الفصل:');
                        if (pass) {
                            btn.textContent = "⌛";
                            window.fetch('/api/customer/unlink', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ phone: phoneRaw, password: pass })
                            }).then(r => r.json()).then(res => {
                                if (res.success) {
                                    alert('تم الفصل!');
                                    try {
                                        let accs = JSON.parse(localStorage.getItem('customerAccounts') || '[]');
                                        accs = accs.filter(a => a.phone !== phoneRaw);
                                        localStorage.setItem('customerAccounts', JSON.stringify(accs));

                                        if (window.parent && window.parent.localStorage) {
                                            let pAccs = JSON.parse(window.parent.localStorage.getItem('customerAccounts') || '[]');
                                            pAccs = pAccs.filter(a => a.phone !== phoneRaw);
                                            window.parent.localStorage.setItem('customerAccounts', JSON.stringify(pAccs));
                                        }
                                    } catch (e) { }
                                    window.parent.location.reload();
                                } else {
                                    alert(res.error);
                                    btn.innerHTML = `🗑️`;
                                }
                            }).catch(err => {
                                alert('حدث خطأ');
                                btn.innerHTML = `🗑️`;
                            });
                        }
                    }
                };
            }
        });

        // 2. Warning banner logic override
        const warnTexts = Array.from(document.querySelectorAll('span, p, div')).filter(el => el.textContent.includes('خط محتاج دفع'));
        warnTexts.forEach(wt => {
            let topBannerRow = wt.parentElement;
            while (topBannerRow && topBannerRow.tagName !== 'BODY') {
                const computed = window.getComputedStyle(topBannerRow);
                if (topBannerRow.tagName === 'DIV' && computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && computed.display === 'flex') {
                    if (topBannerRow.innerText.includes('عشان متتقطعش الخدمة')) break;
                }
                topBannerRow = topBannerRow.parentElement;
            }

            if (topBannerRow && topBannerRow.tagName !== 'BODY') {
                const allDaysLabels = Array.from(document.querySelectorAll('span, p, div, label')).filter(el => el.textContent.includes('باقي') && el.textContent.includes('يوم'));
                let validWarnings = 0;
                let overdueWarnings = 0;

                allDaysLabels.forEach(dl => {
                    if (dl.children.length > 0) return;
                    const txt = dl.textContent.trim();
                    const match = txt.match(/باقي\s*(\d+)\s*يوم/);
                    if (match) {
                        const num = parseInt(match[1]);
                        if (num <= 6) validWarnings++;
                    }
                });

                const expiredLabels = Array.from(document.querySelectorAll('span, p, div, label')).filter(el => el.textContent.includes('فات') || el.textContent.includes('متأخر'));
                expiredLabels.forEach(el => { if (el.children.length === 0) overdueWarnings++; });

                const totalNeedPayment = validWarnings + overdueWarnings;

                if (totalNeedPayment === 0) {
                    topBannerRow.style.display = 'none';
                } else {
                    topBannerRow.style.display = 'flex';
                    wt.innerHTML = 'عندك <strong>' + totalNeedPayment + '</strong> خط محتاج دفع';
                }
            }
        });

        // 3. New Booking Interceptor (DOM Based)
        const notRegTexts = Array.from(document.querySelectorAll('div, span, p')).filter(el => {
            if (el.children.length > 0) return false;
            const t = el.textContent || '';
            return t.includes('الرقم مش مسجل') || t.includes('مش مسجل لدينا') || t.includes('الرقم غير مسجل');
        });

        notRegTexts.forEach(el => {
            if (!el.dataset.intercepted) {
                el.dataset.intercepted = "true";
                setTimeout(() => {
                    // Try to grab inputs
                    const inputs = document.querySelectorAll('input');
                    let pPhone = '';
                    let pPass = '';
                    inputs.forEach(inp => {
                        if (inp.value && inp.value.startsWith('01')) pPhone = inp.value;
                        else if (inp.type === 'password') pPass = inp.value;
                    });

                    if (confirm('هذا الرقم غير مسجل لدينا.\nهل تود إنشاء حجز جديد بهذا الرقم؟')) {
                        if (window.parent && window.parent.openRegisterModal) {
                            window.parent.openRegisterModal(pPhone, pPass);
                        }
                    }
                }, 200);
            }
        });

    }, 1500);
})();
