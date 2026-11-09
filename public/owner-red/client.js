// ============================================================
// Vodafone RED Family Manager - Client Application
// Overview (Home Cards) & Manage (Owners & Family)
// Integrated with Telegram WebApp CloudStorage & Stateless Backend
// ============================================================

// Initialize Telegram Mini App if present
if (window.Telegram?.WebApp) {
  try {
    const tg = window.Telegram.WebApp;
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('#0d0f12');
    if (tg.setBackgroundColor) tg.setBackgroundColor('#0d0f12');
  } catch (e) { }
}

// -------------------------------------------------------------
// Unified Storage Manager (Telegram CloudStorage + localStorage)
// -------------------------------------------------------------
const AppStorage = {
  async get(key, defaultValue = null) {
    try {
      const local = localStorage.getItem(key);
      if (local !== null && local !== undefined) {
        try { return JSON.parse(local); } catch (e) { return local; }
      }
    } catch (e) { }

    if (window.Telegram?.WebApp?.CloudStorage) {
      try {
        const cloudVal = await new Promise((resolve) => {
          window.Telegram.WebApp.CloudStorage.getItem(key, (err, result) => {
            if (!err && result) resolve(result);
            else resolve(null);
          });
        });
        if (cloudVal) {
          try {
            const parsed = JSON.parse(cloudVal);
            try { localStorage.setItem(key, cloudVal); } catch (e) { }
            return parsed;
          } catch (e) { return cloudVal; }
        }
      } catch (e) { }
    }
    return defaultValue;
  },

  async set(key, value) {
    const str = JSON.stringify(value);
    try { localStorage.setItem(key, str); } catch (e) { }
    if (window.Telegram?.WebApp?.CloudStorage) {
      try {
        window.Telegram.WebApp.CloudStorage.setItem(key, str, () => { });
      } catch (e) { }
    }
  }
};

let currentTab = 'overview';
let ownersList = [];
let activeOwnerId = null;
let activeFamilyData = null;

// Helpers
function formatPhone(phone) {
  if (!phone) return "";
  const clean = String(phone).replace(/\D/g, "");
  if (clean.length === 11 && clean.startsWith("01")) {
    return `${clean.slice(0, 3)} ${clean.slice(3, 7)} ${clean.slice(7)}`;
  }
  return phone;
}

function getInitials(name) {
  if (!name) return "ف";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0] || "").join("") || "ف";
}

function makeWhatsAppLink(memberPhone, memberName, quotaGb) {
  const clean = String(memberPhone).replace(/\D/g, "");
  const intl = clean.startsWith("0") ? `20${clean.slice(1)}` : `20${clean}`;
  const ownerPhone = activeFamilyData?.ownerInfo?.msisdn || "";
  const msg = `أهلاً يا ${memberName || "صديقي"}، تم تخصيص باقة فاميلي لك بقيمة (${quotaGb} GB) على خط الأونر (${formatPhone(ownerPhone)}). افتح تطبيق أنا فودافون واضغط قبول لتفعيل الباقة فوراً!`;
  return `https://wa.me/${intl}?text=${encodeURIComponent(msg)}`;
}

function getActiveOwner() {
  if (!ownersList || ownersList.length === 0) return null;
  return ownersList.find(o => o.id === activeOwnerId || o.phone === activeOwnerId) || ownersList[0];
}

async function saveOwnersToStorage() {
  await AppStorage.set('ownersList', ownersList);
  await AppStorage.set('activeOwnerId', activeOwnerId);
}

// Stateless API Fetch Wrapper
async function apiFetch(url, options = {}) {
  options.headers = options.headers || {};
  const activeOwner = getActiveOwner();

  if (activeOwner && activeOwner.phone) {
    options.headers['x-owner-phone'] = activeOwner.phone;
    if (activeOwner.password) {
      options.headers['x-owner-password'] = activeOwner.password;
    }
    if (activeOwner.token?.access_token) {
      options.headers['x-owner-token'] = JSON.stringify(activeOwner.token);
    }
    if (activeOwner.label) {
      options.headers['x-owner-label'] = encodeURIComponent(activeOwner.label);
    }
  }

  const res = await fetch(url, options);

  // If backend refreshed token, update stored owner
  const refreshedToken = res.headers.get('x-refreshed-token');
  if (refreshedToken && activeOwner) {
    try {
      activeOwner.token = JSON.parse(refreshedToken);
      await saveOwnersToStorage();
    } catch (e) { }
  }

  return res;
}

// Toast System
function showToast(message, type = 'ok') {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast-msg ${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// Modal open/close
window.openModal = function (id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
};

window.closeModal = function (id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
};

// Tab Switching
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.toggle('active', view.id === `view-${tabName}`);
  });

  if (tabName === 'overview') loadOwners();
  if (tabName === 'manage') loadFamilyData();
  if (tabName === 'notifications') renderNotificationsTab();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// -------------------------------------------------------------
// 1. Load Owners & Render Overview Tab
// -------------------------------------------------------------
async function loadOwners(notify = false) {
  try {
    // 1. Query server first (fetches from Supabase if connected)
    try {
      const res = await fetch('/api/owners');
      const data = await res.json().catch(() => ({}));
      if (data.success && Array.isArray(data.owners) && data.owners.length > 0) {
        ownersList = data.owners;
        activeOwnerId = data.activeOwnerId || (ownersList[0] ? ownersList[0].id : null);
        await saveOwnersToStorage();
      }
    } catch (e) { }

    // 2. Fallback to AppStorage (localStorage / Telegram CloudStorage)
    if (!ownersList || ownersList.length === 0) {
      const storedOwners = await AppStorage.get('ownersList', null);
      const storedActiveId = await AppStorage.get('activeOwnerId', null);
      if (Array.isArray(storedOwners) && storedOwners.length > 0) {
        ownersList = storedOwners;
        activeOwnerId = storedActiveId || (ownersList[0] ? ownersList[0].id : null);
      }
    }

    // 3. Enrich owner numbers from local family cache (Fixes 0 GB display immediately)
    for (const o of ownersList) {
      const cacheKey = `family_cache_${o.id || o.phone}`;
      const cached = await AppStorage.get(cacheKey, null);
      if (cached && cached.pool) {
        const poolAllocated = cached.pool.SumActiveGB || cached.pool.allocatedGB;
        if (poolAllocated && parseFloat(poolAllocated) > 0) {
          o.allocatedGB = String(poolAllocated);
        } else if (Array.isArray(cached.members) && cached.members.length > 0) {
          const sumGb = cached.members.reduce((acc, m) => acc + (parseFloat(m.quotaGb || m.miGB) || 0), 0);
          if (sumGb > 0) o.allocatedGB = sumGb.toFixed(1);
        }
        if (cached.pool.freeGB) o.freeGB = String(cached.pool.freeGB);
        else if (o.totalGB && o.allocatedGB) o.freeGB = Math.max(0, parseFloat(o.totalGB) - parseFloat(o.allocatedGB)).toFixed(1);
        if (cached.pool.activeMembersCount) o.activeMembers = cached.pool.activeMembersCount;
      }
    }

    const countElem = document.getElementById('headerOwnersCount');
    if (countElem) countElem.textContent = ownersList.length;

    renderOverviewCards();
    renderManagePills();

    // 4. Background Sync: for any owner that still shows 0.0 GB, fetch /api/family silently to sync real Vodafone stats
    syncZeroGBOwnersInBackground(notify);

    if (notify) showToast('تم تحديث بيانات خطوط الأونر!');
  } catch (err) {
    console.error('loadOwners error:', err);
    showToast(`خطأ الأونرات: ${err.message}`, 'danger');
  }
}

// Background sync to pull real allocated GB and update Supabase/AppStorage
let isSyncingStats = false;
async function syncZeroGBOwnersInBackground(forceAll = false) {
  if (isSyncingStats || !ownersList || ownersList.length === 0) return;
  isSyncingStats = true;

  try {
    for (const o of ownersList) {
      if (forceAll || !o.allocatedGB || parseFloat(o.allocatedGB) === 0) {
        try {
          const headers = { 'x-owner-phone': o.phone };
          if (o.password) headers['x-owner-password'] = o.password;
          if (o.token?.access_token) headers['x-owner-token'] = JSON.stringify(o.token);
          const res = await fetch(`/api/family?_t=${Date.now()}`, { headers });
          const data = await res.json().catch(() => ({}));
          if (data.success && data.pool) {
            o.allocatedGB = data.pool.SumActiveGB || "0.0";
            o.freeGB = data.pool.freeGB || (parseFloat(data.pool.totalGB || 200) - parseFloat(o.allocatedGB)).toFixed(1);
            o.totalGB = data.pool.totalGB || "200.0";
            o.activeMembers = data.pool.activeMembersCount || 0;
            o.hasPasswordError = false;
            await AppStorage.set(`family_cache_${o.id || o.phone}`, data);
            await saveOwnersToStorage();
            renderOverviewCards();
            renderManagePills();
          } else if (data.error || !res.ok) {
            const errMsg = String(data.error || '');
            if (errMsg.includes('كلمة السر') || errMsg.includes('غير صحيحة') || errMsg.includes('rejected') || errMsg.includes('password') || res.status === 401) {
              o.hasPasswordError = true;
              addNotification({
                type: 'password_error',
                title: '⚠️ خطأ في باسورد الأونر ' + formatPhone(o.phone),
                desc: 'الباسورد المحفوظ للرقم ' + formatPhone(o.phone) + ' غير صحيح أو تم تغييره. اضغط تعديل الباسورد لوضع الباسورد الصحيح.',
                ownerPhone: o.phone,
                ownerLabel: o.label || o.phone,
                memberPhone: o.phone,
                memberName: o.label || o.phone
              });
              showToast('⚠️ الباسورد غلط للرقم ' + formatPhone(o.phone) + ' - ادخل عدله', 'danger');
              renderOverviewCards();
            }
          }
        } catch (syncErr) {
          console.warn('Sync error for owner:', o.phone, syncErr);
        }
      }
    }
  } finally {
    isSyncingStats = false;
  }
}

// Render Overview Cards
function renderOverviewCards() {
  const grid = document.getElementById('overviewCardsGrid');
  const statsWrap = document.getElementById('overviewQuickStats');
  if (!grid) return;
  grid.innerHTML = '';

  if (ownersList.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 45px; background: rgba(0,0,0,0.3); border-radius: 16px; border: 1px solid var(--border-subtle);">
        <p style="font-weight: 800; font-size: 1.1rem; color: #fff; margin-bottom: 8px;">لا يوجد أرقام أونر مسجلة حتى الآن</p>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px;">أضف أول رقم أونر وباسورد أنا فودافون للتحقق التلقائي وسحب الباقة.</p>
        <button class="btn btn-primary" onclick="openModal('modalAddOwner')">إضافة أول أونر الآن</button>
      </div>
    `;
    if (statsWrap) statsWrap.innerHTML = '';
    return;
  }

  // Quick Stats bar
  let totalGBAll = 0;
  let totalMemAll = 0;
  ownersList.forEach(o => {
    totalGBAll += parseFloat(o.totalGB || 200);
    totalMemAll += parseInt(o.activeMembers || 0);
  });

  if (statsWrap) {
    statsWrap.innerHTML = `
      <span class="stat-pill"><span class="tabular text-white">${ownersList.length}</span> أونرات مسجلة</span>
      <span class="stat-pill"><span class="tabular text-sky">${totalGBAll.toFixed(1)} GB</span> إجمالي الباقات</span>
      <span class="stat-pill"><span class="tabular text-mint">${totalMemAll}</span> أفراد بالعائلات</span>
    `;
  }

  // Render each owner card
  ownersList.forEach(o => {
    const isCurrent = o.id === activeOwnerId || o.phone === activeOwnerId;
    const card = document.createElement('div');
    card.className = 'owner-overview-card';

    const totalGb = parseFloat(o.totalGB || 200);
    const allocatedGb = parseFloat(o.allocatedGB || 0);
    const freeGb = parseFloat(o.freeGB || (totalGb - allocatedGb).toFixed(1));
    const activeMem = o.activeMembers || 0;
    const renewalText = o.renewalDay || 'يوم 17';
    const percentAllocated = totalGb > 0 ? Math.min(100, Math.round((allocatedGb / totalGb) * 100)) : 0;

    card.innerHTML = `
      <div>
        <div class="card-head-row">
          <div>
            <div class="card-phone-main tabular">${formatPhone(o.phone)}</div>
            <div class="card-owner-name">${o.label || 'مالك فودافون ريد'}</div>
            ${o.hasPasswordError ? `
            <div style="margin-top: 4px;">
              <span class="badge badge-danger" style="background: rgba(239, 68, 68, 0.18); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); font-size: 0.7rem; padding: 2px 8px;">
                ⚠️ الباسورد غلط - مطلوب تعديله
              </span>
            </div>
            ` : ''}
          </div>
          <div>
            ${isCurrent ? '<span class="badge badge-mint"><span class="badge-dot"></span>النشط حالياً</span>' : '<span class="badge badge-outline">متصل ✓</span>'}
          </div>
        </div>

        <div class="card-plan-badge">
          <span class="badge badge-muted">${o.planName || 'Vodafone RED'}</span>
        </div>
      </div>

      <!-- 3 Key Quota Numbers -->
      <div class="card-quota-box">
        <div class="card-quota-numbers">
          <div class="quota-num-item">
            <div class="quota-num-lbl">سعة الباقة</div>
            <div class="quota-num-val tabular text-sky">${totalGb} <small>GB</small></div>
          </div>
          <div class="quota-num-item">
            <div class="quota-num-lbl">الموزّع</div>
            <div class="quota-num-val tabular text-white">${allocatedGb} <small>GB</small></div>
          </div>
          <div class="quota-num-item">
            <div class="quota-num-lbl">المتبقي</div>
            <div class="quota-num-val tabular text-mint">${freeGb} <small>GB</small></div>
          </div>
        </div>

        <div class="card-progress-bar">
          <div class="card-progress-fill" style="width: ${percentAllocated}%;"></div>
        </div>
      </div>

      <!-- Footer Meta -->
      <div class="card-footer-meta">
        <div>
          <span style="color: var(--text-soft);">الأفراد النشطين:</span>
          <span class="tabular text-white" style="font-weight: 800; margin-right: 4px;">${activeMem} أفراد</span>
        </div>
        <div>
          <span style="color: var(--text-soft);">ميعاد التجديد:</span>
          <span class="tabular text-amber" style="font-weight: 800; margin-right: 4px;">${renewalText}</span>
        </div>
      </div>

      <!-- Action Buttons -->
      <div style="display: flex; gap: 8px; margin-top: 4px;">
        <button class="btn btn-primary card-action-btn btn-go-manage" data-id="${o.id}" style="flex: 1;">
          <span>إدارة فاميلي هذا الخط</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
        <button class="btn btn-soft btn-edit-pwd-owner-card" data-phone="${o.phone}" title="تعديل باسورد هذا الأونر" style="padding: 0 12px;">
          🔑
        </button>
        <button class="btn btn-danger btn-delete-owner-card" data-id="${o.id}" title="حذف الخط من القائمة" style="padding: 0 14px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  // Action buttons events
  grid.querySelectorAll('.btn-go-manage').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await selectOwnerAndGo(id);
    });
  });

  grid.querySelectorAll('.btn-delete-owner-card').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.deleteOwner(btn.dataset.id);
    });
  });

  grid.querySelectorAll('.btn-edit-pwd-owner-card').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.openUpdateOwnerPwdModal(btn.dataset.phone);
    });
  });
}

// -------------------------------------------------------------
// 2. Manage Tab: Owner Pills & Switching
// -------------------------------------------------------------
function renderManagePills() {
  const pillsList = document.getElementById('ownersPillsList');
  if (!pillsList) return;
  pillsList.innerHTML = '';

  ownersList.forEach(o => {
    const isCurrent = o.id === activeOwnerId || o.phone === activeOwnerId;
    const pill = document.createElement('button');
    pill.className = `owner-pill ${isCurrent ? 'active' : ''}`;
    pill.innerHTML = `
      <span class="tabular" style="font-weight: 900;">${formatPhone(o.phone)}</span>
      <span style="font-size: 0.72rem; opacity: 0.85;">(${o.label || 'أونر'})</span>
      ${isCurrent ? '<span style="color: var(--mint);">✓</span>' : ''}
    `;
    pill.addEventListener('click', () => selectOwnerAndGo(o.id));
    pillsList.appendChild(pill);
  });
}

async function selectOwnerAndGo(id) {
  try {
    activeOwnerId = id;
    await saveOwnersToStorage();

    // Call server to keep in sync if running locally
    apiFetch('/api/owners/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId: id })
    }).catch(() => { });

    renderManagePills();
    renderOverviewCards();
    await loadFamilyData();
    switchTab('manage');
  } catch (err) {
    showToast(`فشل اختيار الأونر: ${err.message}`, 'danger');
  }
}

// -------------------------------------------------------------
// 3. Load & Render Family for Active Selected Owner
// -------------------------------------------------------------
async function loadFamilyData(notify = false) {
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.classList.add('spin');

  try {
    const activeOwner = getActiveOwner();
    if (!activeOwner) {
      document.getElementById('manageHeroPhone').textContent = "—";
      document.getElementById('manageHeroName').textContent = "لا يوجد أونر نشط";
      document.getElementById('manageHeroPlan').textContent = "Vodafone RED";
      document.getElementById('manageHeroAccount').textContent = "—";
      document.getElementById('manageHeroTotalGB').innerHTML = `0 <small>GB</small>`;
      document.getElementById('manageHeroVoiceMins').textContent = "0 دقيقة فودافون";
      document.getElementById('manageHeroAllocatedGB').innerHTML = `0 <small>GB</small>`;
      document.getElementById('manageHeroActiveCount').textContent = "0 أفراد نشطين";
      document.getElementById('manageHeroFreeGB').innerHTML = `0 <small>GB</small>`;
      document.getElementById('manageTableCountBadge').textContent = "0 أفراد";
      document.getElementById('membersTableBody').innerHTML = `
        <tr><td colspan="6" style="text-align: center; padding: 45px; color: var(--text-muted); font-size: 0.9rem;">
          <p style="font-weight: 800; font-size: 1rem; color: #fff; margin-bottom: 8px;">لا يوجد أونر نشط للتحكم في باقته</p>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 14px;">أضف أونر جديد أولاً للتحكم في العائلة وتوزيع الجيجابايت والدقائق.</p>
          <button class="btn btn-primary btn-sm" onclick="openModal('modalAddOwner')">إضافة أول أونر الآن</button>
        </td></tr>`;
      return;
    }

    // 1. Instant Cache Render: only on first cold load, bypass completely on manual refresh
    const cacheKey = `family_cache_${activeOwner.id || activeOwner.phone}`;
    if (!notify) {
      const cachedData = await AppStorage.get(cacheKey, null);
      if (cachedData && cachedData.success) {
        activeFamilyData = cachedData;
        renderManageHero(cachedData);
        renderMembersTable(cachedData);
      }
    } else {
      await AppStorage.set(cacheKey, null);
    }

    const res = await apiFetch(`/api/family?_t=${Date.now()}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'فشل جلب بيانات العائلة');

    // Merge friendly member names and saved passwords from AppStorage
    const storedNames = await AppStorage.get('member_names', {});
    const storedPasswords = await AppStorage.get('member_passwords', {});
    if (data.members) {
      data.members.forEach(m => {
        // If server returned a fresh real name, use it and update local storedNames!
        const isPlaceholder = !m.name || m.name === 'عضو فاميلي' || /^فرد \d+$/.test(m.name);
        if (!isPlaceholder) {
          storedNames[m.msisdn] = m.name;
        } else if (storedNames && storedNames[m.msisdn]) {
          m.name = storedNames[m.msisdn];
        }
        if (storedPasswords && storedPasswords[m.msisdn]) m.hasPassword = true;
      });
      await AppStorage.set('member_names', storedNames);
    }

    activeFamilyData = data;
    await AppStorage.set(cacheKey, data);
    renderManageHero(data);
    renderMembersTable(data);

    // Check member passwords and refresh their real names on manual refresh
    if (notify && data.members && data.members.length > 0) {
      const membersWithPwd = [];
      data.members.forEach(m => {
        if (storedPasswords && storedPasswords[m.msisdn]) {
          membersWithPwd.push({ phone: m.msisdn, password: storedPasswords[m.msisdn] });
        }
      });

      if (membersWithPwd.length > 0) {
        apiFetch('/api/members/validate-passwords', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ members: membersWithPwd })
        }).then(r => r.json()).then(async (valRes) => {
          if (valRes && valRes.success && Array.isArray(valRes.results)) {
            let namesChanged = false;
            valRes.results.forEach(resItem => {
              const mem = data.members.find(m => m.msisdn === resItem.phone);
              if (resItem.valid) {
                if (mem) {
                  mem.passwordError = false;
                  if (resItem.name && resItem.name !== mem.name) {
                    mem.name = resItem.name;
                    storedNames[resItem.phone] = resItem.name;
                    namesChanged = true;
                  }
                }
              } else {
                // Member password is wrong or changed!
                if (mem) mem.passwordError = true;
                addNotification({
                  type: 'member_password_error',
                  title: '⚠️ خطأ في باسورد الفرد ' + formatPhone(resItem.phone),
                  desc: 'الباسورد المحفوظ للرقم ' + formatPhone(resItem.phone) + (mem?.name ? ' (' + mem.name + ')' : '') + ' غير صحيح أو تم تغييره على تطبيق أنا فودافون. اضغط لتعديل الباسورد.',
                  ownerPhone: activeOwner.phone,
                  ownerLabel: activeOwner.label || activeOwner.phone,
                  memberPhone: resItem.phone,
                  memberName: mem?.name || resItem.phone
                });
                showToast('⚠️ خطأ في باسورد الفرد ' + formatPhone(resItem.phone) + ' - تم إضافته للتنبيهات', 'danger');
              }
            });
            if (namesChanged) {
              await AppStorage.set('member_names', storedNames);
            }
            renderMembersTable(data);
          }
        }).catch(err => console.warn('validate-passwords background error:', err));
      }
    }


    

    // Update active owner stats & fresh name in ownersList
    const ownerIdx = ownersList.findIndex(o => o.id === activeOwner.id || o.phone === activeOwner.phone);
    if (ownerIdx >= 0 && data.pool) {
      ownersList[ownerIdx].totalGB = data.pool.totalGB;
      ownersList[ownerIdx].allocatedGB = data.pool.SumActiveGB;
      ownersList[ownerIdx].freeGB = data.pool.freeGB;
      ownersList[ownerIdx].activeMembers = data.pool.activeMembersCount;
      if (data.ownerInfo?.name && data.ownerInfo.name !== 'مالك فودافون') {
        ownersList[ownerIdx].label = data.ownerInfo.name;
        activeOwner.label = data.ownerInfo.name;
        const heroNameEl = document.getElementById('manageHeroName');
        if (heroNameEl) heroNameEl.textContent = data.ownerInfo.name;
      }
      if (data.ownerInfo?.ratePlan) ownersList[ownerIdx].planName = data.ownerInfo.ratePlan;
      await saveOwnersToStorage();
      renderOverviewCards();
      renderManagePills();
    }

    // -------------------------------------------------------------
    // Change Detection for Live Notifications (قبول / خروج فرد)
    // -------------------------------------------------------------
    try {
      const snapKey = `members_snapshot_${activeOwner.phone}`;
      const prevSnap = await AppStorage.get(snapKey, null);
      const currActive = (data.members || []).filter(m => m.status === 'ACTIVE' && !m.isOwner);
      const currPending = (data.pendingInvitations || data.pendingInvites || []);

      if (prevSnap && Array.isArray(prevSnap.active) && prevSnap.active.length > 0) {
        // 1. Detect ACCEPTED members (was pending previously or new active)
        currActive.forEach(m => {
          const wasPending = (prevSnap.pending || []).some(p => p.msisdn === m.msisdn);
          const wasActive = (prevSnap.active || []).some(a => a.msisdn === m.msisdn);
          if (wasPending || (!wasActive && (prevSnap.pending || []).length > 0)) {
            addNotification({
              type: 'accept',
              title: 'تم قبول دعوة فرد في العائلة ✓',
              desc: `قبل الفرد (${m.name || m.msisdn}) الدعوة وأصبح عضواً نشطاً بكوتة ${m.miGB || (m.mi/1024).toFixed(1)} GB`,
              ownerPhone: activeOwner.phone,
              ownerLabel: activeOwner.label || activeOwner.phone,
              memberPhone: m.msisdn,
              memberName: m.name || m.msisdn
            });
          }
        });

        // 2. Detect LEFT / REMOVED members (was active previously, now missing)
        prevSnap.active.forEach(oldM => {
          const stillActive = currActive.some(m => m.msisdn === oldM.msisdn);
          if (!stillActive) {
            addNotification({
              type: 'leave',
              title: 'خروج أو إزالة فرد من العائلة',
              desc: `خرج الفرد (${oldM.name || oldM.msisdn}) من عائلة الأونر ولم يعد ضمن الباقة`,
              ownerPhone: activeOwner.phone,
              ownerLabel: activeOwner.label || activeOwner.phone,
              memberPhone: oldM.msisdn,
              memberName: oldM.name || oldM.msisdn
            });
          }
        });
      }

      // Save updated snapshot
      await AppStorage.set(snapKey, {
        active: currActive.map(m => ({ msisdn: m.msisdn, name: m.name })),
        pending: currPending.map(p => ({ msisdn: p.msisdn, name: p.name }))
      });
    } catch (e) {
      console.warn('Snapshot comparison error:', e);
    }

    if (notify) showToast('تم تحديث بيانات فاميلي الأونر من فودافون!');
  } catch (err) {
    console.error('loadFamilyData error:', err);
    const errMsg = err.message || '';
    showToast(`فودافون: ${errMsg}`, 'danger');
    // Detect wrong password and create notification
    if (errMsg.includes('كلمة السر') || errMsg.includes('غير صحيحة') || errMsg.includes('rejected') || errMsg.includes('password')) {
      const activeOwner = getActiveOwner();
      if (activeOwner) {
        addNotification({
          type: 'password_error',
          title: '⚠️ خطأ في باسورد الأونر ' + formatPhone(activeOwner.phone),
          desc: 'الباسورد المحفوظ للرقم ' + formatPhone(activeOwner.phone) + ' غير صحيح. ادخل عدل الباسورد من زرار الإعدادات.',
          ownerPhone: activeOwner.phone,
          ownerLabel: activeOwner.label || activeOwner.phone,
          memberPhone: activeOwner.phone,
          memberName: activeOwner.label || activeOwner.phone
        });
      }
    }
  } finally {
    if (icon) icon.classList.remove('spin');
  }
}

// Render Manage Hero Card
function renderManageHero(data) {
  const { ownerInfo, pool, members } = data;

  const phoneElem = document.getElementById('manageHeroPhone');
  if (phoneElem) phoneElem.textContent = formatPhone(ownerInfo.msisdn);
  document.getElementById('manageHeroName').textContent = ownerInfo.name || 'مالك فودافون';
  document.getElementById('manageHeroPlan').textContent = ownerInfo.ratePlan || 'Vodafone RED';
  document.getElementById('manageHeroAccount').textContent = ownerInfo.billingAccount || 'N/A';

  const totalGb = parseFloat(pool.totalGB || 200);
  const allocatedGb = parseFloat(pool.SumActiveGB || 0);
  const freeGb = Math.max(0, totalGb - allocatedGb).toFixed(1);
  const activeCount = (members || []).filter(m => m.status === 'ACTIVE').length;

  document.getElementById('manageHeroTotalGB').innerHTML = `${totalGb} <small>GB</small>`;
  document.getElementById('manageHeroVoiceMins').textContent = `${(pool.totalVoice || 11000).toLocaleString()} دقيقة فودافون`;
  document.getElementById('manageHeroAllocatedGB').innerHTML = `${allocatedGb} <small>GB</small>`;
  document.getElementById('manageHeroActiveCount').textContent = `${activeCount} أفراد نشطين حالياً`;
  document.getElementById('manageHeroFreeGB').innerHTML = `${freeGb} <small>GB</small>`;
  document.getElementById('manageTableCountBadge').textContent = `${activeCount} أفراد نشطين`;

  const pct = totalGb > 0 ? Math.min(100, Math.round((allocatedGb / totalGb) * 100)) : 0;
  document.getElementById('manageHeroProgressFill').style.width = `${pct}%`;
}

// Render Members Table & Mobile Cards
function renderMembersTable(data) {
  const { members, pool, pendingInvitations } = data;
  const tbody = document.getElementById('membersTableBody');
  const cardsList = document.getElementById('membersCardsList');

  if (tbody) tbody.innerHTML = '';
  if (cardsList) cardsList.innerHTML = '';

  const activeMembers = (members || []).filter(m => m.status === 'ACTIVE');

  if (activeMembers.length === 0) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 35px; color: var(--text-muted); font-size: 0.9rem;">لا يوجد أفراد نشطين في هذه الباقة حالياً</td></tr>`;
    }
    if (cardsList) {
      cardsList.innerHTML = `<div style="text-align: center; padding: 35px 20px; color: var(--text-muted); font-size: 0.9rem;">لا يوجد أفراد نشطين في هذه الباقة حالياً</div>`;
    }
  } else {
    activeMembers.forEach(m => {
      const quotaGb = parseFloat(m.miGB || (m.mi / 1024).toFixed(1));

      let pwdBadge = '';
      if (m.passwordError) {
        pwdBadge = `<span class="pwd-status-pill error" style="background: rgba(239, 68, 68, 0.18); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4);" title="الباسورد غير صحيح أو تم تغييره"><span class="badge-dot" style="background: #ef4444;"></span>الباسورد غلط ⚠️</span>`;
      } else if (m.hasPassword) {
        pwdBadge = `<span class="pwd-status-pill verified" title="تم توثيق الباسورد"><span class="badge-dot"></span>موثق ومحفوظ ✓</span>`;
      } else {
        pwdBadge = `<span class="pwd-status-pill pending-otp" title="يرجى إدخال باسورد الفرد بعد الـ OTP">مطلوب تفعيل الباسورد</span>`;
      }

      // 1. Desktop Table Row
      if (tbody) {
        const tr = document.createElement('tr');
        tr.dataset.memberPhone = m.msisdn;
        tr.innerHTML = `
          <td>
            <div class="member-name-wrap">
              <div class="member-avatar-circle">
                ${getInitials(m.name || m.msisdn)}
              </div>
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span class="member-title">${m.name || 'عضو فاميلي'}</span>
                  <button class="btn-edit-pen btn-open-name-modal" data-phone="${m.msisdn}" data-name="${m.name || ''}" title="تعديل الاسم">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                </div>
                <span class="badge badge-mint" style="font-size: 0.65rem; padding: 1px 6px; margin-top: 2px;">عضو نشط بالباقة</span>
              </div>
            </div>
          </td>

          <td>
            <div class="phone-with-actions">
              <span class="phone-text tabular">${formatPhone(m.msisdn)}</span>
              <button class="icon-action-btn btn-copy" data-phone="${m.msisdn}" title="نسخ الرقم">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              <a href="${makeWhatsAppLink(m.msisdn, m.name, quotaGb)}" target="_blank" class="icon-action-btn wa" title="إرسال رسالة بالكوتة على واتساب">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
              </a>
            </div>
          </td>

          <td>
            <div>
              <span class="badge badge-info tabular" style="font-size: 0.95rem; font-weight: 900; padding: 4px 10px;">${quotaGb} GB</span>
              <div style="font-size: 0.68rem; color: var(--text-muted); margin-top: 3px;">كوتة بداية الشهر</div>
            </div>
          </td>

          <td>
            <div class="tabular" style="font-size: 0.8rem; font-weight: 700; color: var(--text-soft);">
              <span>${(m.voice || 0).toLocaleString()} دقيقة</span>
              <span style="color: var(--text-muted); margin: 0 4px;">·</span>
              <span>${m.sms || 0} رسالة</span>
            </div>
          </td>

          <td>
            ${pwdBadge}
          </td>

          <td style="text-align: left;">
            <div class="member-actions-row">
              <button class="btn-consumption btn-open-consumption" data-phone="${m.msisdn}" data-name="${m.name || ''}" title="عرض استهلاك الفرد الحالي">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>
                <span>الاستهلاك</span>
              </button>

              <button class="btn-extra-gb btn-open-extra-gb" data-phone="${m.msisdn}" data-name="${m.name || ''}" data-gb="${quotaGb}" title="إضافة جيجات إضافية في منتصف الشهر">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>+ جيجات</span>
              </button>

              <button class="btn btn-soft btn-xs btn-open-edit-quota" data-phone="${m.msisdn}" data-gb="${quotaGb}" data-voice="${m.voice || 1500}" data-sms="${m.sms || 200}" title="تعديل الكوتة الأساسية">
                تعديل
              </button>

              <button class="btn-pwd-action btn-open-update-pwd" data-phone="${m.msisdn}" data-name="${m.name || ''}" title="تحديث وتوثيق باسورد الفرد بعد الـ OTP">
                🔑
              </button>

              <button class="btn btn-danger btn-xs btn-remove" data-phone="${m.msisdn}" title="إزالة من الفاميلي">
                إزالة
              </button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      }

      // 2. Mobile Touch Card (Zero Horizontal Scroll!)
      if (cardsList) {
        const card = document.createElement('div');
        card.className = 'member-mobile-card';
        card.dataset.memberPhone = m.msisdn;
        card.innerHTML = `
          <!-- Top Section -->
          <div class="mm-top">
            <div class="mm-user-info">
              <div class="member-avatar-circle">
                ${getInitials(m.name || m.msisdn)}
              </div>
              <div class="mm-name-col">
                <div class="mm-name-row">
                  <span class="member-title">${m.name || 'عضو فاميلي'}</span>
                  <button class="btn-edit-pen btn-open-name-modal" data-phone="${m.msisdn}" data-name="${m.name || ''}" title="تعديل الاسم">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </button>
                </div>
                <div class="mm-phone-row">
                  <span class="phone-text tabular">${formatPhone(m.msisdn)}</span>
                  <button class="icon-action-btn btn-copy" data-phone="${m.msisdn}" title="نسخ الرقم">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                  <a href="${makeWhatsAppLink(m.msisdn, m.name, quotaGb)}" target="_blank" class="icon-action-btn wa" title="واتساب">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                  </a>
                </div>
              </div>
            </div>

            <div class="mm-quota-box">
              <div class="mm-quota-val tabular">${quotaGb} <small>GB</small></div>
              <div class="mm-quota-lbl">كوتة بداية الشهر</div>
            </div>
          </div>

          <!-- Stats Strip -->
          <div class="mm-stats-strip">
            <div class="mm-stat-chip tabular">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>${(m.voice || 0).toLocaleString()} دقيقة · ${m.sms || 0} رسالة</span>
            </div>
            <div class="mm-pwd-chip">
              ${pwdBadge}
            </div>
          </div>

          <!-- Action Buttons 2x2 Grid (Big touch-friendly targets, no scroll) -->
          <div class="mm-actions-grid">
            <button class="btn mm-btn-consumption btn-open-consumption" data-phone="${m.msisdn}" data-name="${m.name || ''}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"></path><path d="M22 12A10 10 0 0 0 12 2v10z"></path></svg>
              <span>الاستهلاك</span>
            </button>

            <button class="btn mm-btn-extra btn-open-extra-gb" data-phone="${m.msisdn}" data-name="${m.name || ''}" data-gb="${quotaGb}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              <span>+ جيجات إضافية</span>
            </button>

            <button class="btn mm-btn-edit btn-open-edit-quota" data-phone="${m.msisdn}" data-gb="${quotaGb}" data-voice="${m.voice || 1500}" data-sms="${m.sms || 200}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              <span>تعديل الكوتة</span>
            </button>

            <button class="btn mm-btn-pwd btn-open-update-pwd" data-phone="${m.msisdn}" data-name="${m.name || ''}">
              <span>🔑 الباسورد</span>
            </button>

            <button class="btn mm-btn-delete btn-remove" data-phone="${m.msisdn}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              <span>إزالة</span>
            </button>
          </div>
        `;
        cardsList.appendChild(card);
      }
    });
  }

  renderPendingInvites(pendingInvitations || []);
  bindTableEvents();
}

// Render Pending Invitations
function renderPendingInvites(pendingList) {
  const panel = document.getElementById('pendingInvitesPanel');
  const countBadge = document.getElementById('pendingInvitesCount');
  const tbody = document.getElementById('pendingInvitesTableBody');
  const cardsList = document.getElementById('pendingInvitesCardsList');

  if (!panel) return;
  if (!pendingList || pendingList.length === 0) {
    panel.style.display = 'none';
    if (tbody) tbody.innerHTML = '';
    if (cardsList) cardsList.innerHTML = '';
    if (countBadge) countBadge.textContent = '0';
    return;
  }

  panel.style.display = 'block';
  if (countBadge) countBadge.textContent = `${pendingList.length} معلقة`;
  if (tbody) tbody.innerHTML = '';
  if (cardsList) cardsList.innerHTML = '';

  pendingList.forEach(item => {
    if (tbody) {
      const tr = document.createElement('tr');
      tr.dataset.memberPhone = item.msisdn;
      tr.innerHTML = `
        <td><strong style="color: #fff;">${item.name || 'فرد'}</strong></td>
        <td><span class="tabular phone-text">${formatPhone(item.msisdn)}</span></td>
        <td><span class="badge badge-amber"><span class="badge-dot"></span>بانتظار القبول</span></td>
        <td>
          <div style="font-size: 0.78rem; color: var(--text-soft);">
            ${item.source === 'vodafone_network' ? 'مسجلة على شبكة فودافون الرسمية' : 'بانتظار القبول'}
          </div>
          <div style="font-size: 0.75rem; color: #f59e0b; margin-top: 2px;">
            كود القبول: <strong>*41#</strong>
          </div>
          ${item.expireDate ? `<div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">تنتهي: ${new Date(item.expireDate).toLocaleDateString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
        </td>
        <td style="text-align: left; white-space: nowrap;">
          <div style="display: inline-flex; gap: 6px;">
            <button class="btn btn-soft btn-xs btn-accept-pending" data-phone="${item.msisdn}" title="قبول الدعوة وتفعيل الفرد تلقائياً">
              ⚡ قبول فوراً
            </button>
            <button class="btn btn-danger btn-xs btn-cancel-pending" data-phone="${item.msisdn}" title="إلغاء أو حذف هذه الدعوة">
              إلغاء
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }

    if (cardsList) {
      const card = document.createElement('div');
      card.className = 'pending-mobile-card';
      card.dataset.memberPhone = item.msisdn;
      card.innerHTML = `
        <div class="pm-header">
          <div>
            <div class="pm-title">${item.name || 'فرد'}</div>
            <div class="pm-phone tabular">${formatPhone(item.msisdn)}</div>
          </div>
          <span class="badge badge-amber"><span class="badge-dot"></span>بانتظار القبول</span>
        </div>
        <div class="pm-note" style="color: #f59e0b; font-weight: 500;">
          💡 لقبول الدعوة اطلب من خط الفرد: <strong>*41#</strong> أو افتح تطبيق أنا فودافون
        </div>
        ${item.expireDate ? `<div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">صلاحية الدعوة حتى: ${new Date(item.expireDate).toLocaleDateString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button class="btn btn-soft btn-xs btn-accept-pending" data-phone="${item.msisdn}" style="flex: 1;">
            ⚡ قبول وتفعيل فوراً
          </button>
          <button class="btn btn-danger btn-xs btn-cancel-pending" data-phone="${item.msisdn}" style="padding: 6px 12px;">
            إلغاء الدعوة
          </button>
        </div>
      `;
      cardsList.appendChild(card);
    }
  });
}

// Bind table events
function bindTableEvents() {
  // Cancel pending invite
  document.querySelectorAll('.btn-cancel-pending').forEach(btn => {
    btn.addEventListener('click', async () => {
      const phone = btn.dataset.phone;
      if (!confirm(`هل تريد بالتأكيد إلغاء الدعوة للرقم ${phone}؟`)) return;
      btn.disabled = true;
      btn.textContent = 'جاري...';
      try {
        const res = await apiFetch('/api/family/cancel-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberPhone: phone })
        });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || 'فشل إلغاء الدعوة');
        showToast(d.message || 'تم إلغاء الدعوة بنجاح');
        await loadFamilyData();
      } catch (err) {
        showToast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = 'إلغاء';
      }
    });
  });

  // Accept pending invite via member credentials
  document.querySelectorAll('.btn-accept-pending').forEach(btn => {
    btn.addEventListener('click', async () => {
      const phone = btn.dataset.phone;
      const passwords = await AppStorage.get('member_passwords', {});
      let pwd = passwords[phone] || '';
      if (!pwd) {
        pwd = prompt(`أدخل باسورد تطبيق أنا فودافون للفرد ${phone} لقبول الدعوة وتفعيله فورياً:`);
        if (!pwd || !pwd.trim()) return;
        passwords[phone] = pwd.trim();
        await AppStorage.set('member_passwords', passwords);
      }
      btn.disabled = true;
      btn.textContent = 'جاري التفعيل...';
      try {
        const activeOwner = getActiveOwner();
        const res = await apiFetch('/api/family/accept-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            memberPhone: phone,
            password: pwd.trim(),
            ownerPhone: activeOwner?.phone
          })
        });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || 'فشل قبول الدعوة في فودافون');
        showToast(d.message || 'تم قبول الدعوة وتفعيل الفرد بنجاح!', 'ok');
        await loadFamilyData(true);
      } catch (err) {
        showToast(err.message, 'danger');
        // If Vodafone asks for manual acceptance or app acceptance, show direct guide modal
        showInviteAcceptanceGuideModal(phone);
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ قبول فوراً';
      }
    });
  });

  document.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.phone);
      showToast(`تم نسخ ${btn.dataset.phone}`);
    });
  });

  document.querySelectorAll('.btn-open-name-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      const phone = btn.dataset.phone;
      const currentName = btn.dataset.name;
      document.getElementById('editNameTargetPhone').value = phone;
      document.getElementById('editNamePhoneText').textContent = formatPhone(phone);
      document.getElementById('editNameInput').value = currentName;
      openModal('modalEditName');
    });
  });

  document.querySelectorAll('.btn-open-extra-gb').forEach(btn => {
    btn.addEventListener('click', () => {
      const phone = btn.dataset.phone;
      const name = btn.dataset.name || 'الفرد';
      const currentGb = parseFloat(btn.dataset.gb) || 25;

      document.getElementById('extraGBTargetPhone').value = phone;
      document.getElementById('extraGBCurrentGBVal').value = currentGb;
      document.getElementById('extraGBPhoneSubtitle').textContent = `للفرد: ${name} (${formatPhone(phone)})`;
      document.getElementById('extraGBCurrentGBText').textContent = `${currentGb.toFixed(1)} GB`;

      const extraInput = document.getElementById('extraGBInput');
      extraInput.value = '5';

      const updatePreview = () => {
        const extra = parseFloat(extraInput.value) || 0;
        const total = (currentGb + extra).toFixed(1);
        document.getElementById('extraGBTotalPreview').textContent = `${total} GB`;
      };

      extraInput.oninput = updatePreview;
      updatePreview();

      openModal('modalAddExtraGB');
    });
  });

  document.querySelectorAll('.btn-open-update-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const phone = btn.dataset.phone;
      const name = btn.dataset.name || 'الفرد';

      document.getElementById('updatePwdTargetPhone').value = phone;
      document.getElementById('updatePwdPhoneSubtitle').textContent = `للفرد: ${name} (${formatPhone(phone)})`;
      document.getElementById('newMemberPasswordInput').value = '';
      document.getElementById('updatePwdMsg').style.display = 'none';

      openModal('modalUpdatePassword');
    });
  });

  document.querySelectorAll('.btn-open-edit-quota').forEach(btn => {
    btn.addEventListener('click', () => {
      const phone = btn.dataset.phone;
      const gb = parseFloat(btn.dataset.gb) || 25;
      const voice = parseInt(btn.dataset.voice) || 1500;
      const sms = parseInt(btn.dataset.sms) || 200;

      document.getElementById('editQuotaPhone').value = phone;
      document.getElementById('editQuotaSubtitle').textContent = formatPhone(phone);
      document.getElementById('editQuotaGBInput').value = gb;
      document.getElementById('editQuotaVoiceInput').value = voice;
      document.getElementById('editQuotaSMSInput').value = sms;

      openModal('modalEditQuota');
    });
  });

  // Consumption button click
  document.querySelectorAll('.btn-open-consumption').forEach(btn => {
    btn.addEventListener('click', async () => {
      const phone = btn.dataset.phone;
      const name = btn.dataset.name || 'الفرد';
      btn.disabled = true;
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<span>جاري الجلب...</span>';
      
      try {
        // Get member password from storage
        const passwords = await AppStorage.get('member_passwords', {});
        const memberPwd = passwords[phone];
        
        if (!memberPwd) {
          showToast('يجب حفظ باسورد الفرد أولاً لعرض الاستهلاك. اضغط 🔑 الباسورد لحفظه.', 'danger');
          return;
        }
        
        const res = await apiFetch('/api/members/consumption', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberPhone: phone, password: memberPwd })
        });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || 'فشل جلب الاستهلاك');
        
        // Show consumption modal
        showConsumptionModal(phone, name, d.consumption);
      } catch (err) {
        showToast('خطأ: ' + err.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    });
  });

  document.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const phone = btn.dataset.phone;
      if (!confirm(`هل أنت متأكد من إزالة الرقم ${formatPhone(phone)} من باقة الفاميلي؟`)) return;

      try {
        showToast(`جاري إرسال طلب إزالة ${phone} لفودافون DXL...`);
        const res = await apiFetch('/api/family/remove-member', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberPhone: phone })
        });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || 'فشلت الإزالة');
        showToast(`تمت إزالة ${phone} بنجاح!`);
        await loadFamilyData();
        await loadOwners();
      } catch (err) {
        showToast(`خطأ فودافون: ${err.message}`, 'danger');
      }
    });
  });
}

// Direct update quota helper
async function updateQuotaDirect(memberPhone, mi, voice, sms) {
  const res = await apiFetch('/api/family/redistribute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetMemberPhone: memberPhone,
      characteristics: [
        { characteristicName: "MI", value: String(mi) },
        { characteristicName: "Voice", value: String(voice) },
        { characteristicName: "SMS", value: String(sms) }
      ]
    })
  });
  const d = await res.json();
  if (!d.success) throw new Error(d.error || 'فشل التعديل');
  return d;
}

// -------------------------------------------------------------
// 4. Distribute Equally
// -------------------------------------------------------------
document.getElementById('btnDistributeEqually')?.addEventListener('click', async () => {
  if (!activeFamilyData) return;
  const { pool, members } = activeFamilyData;
  const activeMembers = (members || []).filter(m => m.status === 'ACTIVE');

  if (activeMembers.length === 0) {
    showToast('لا يوجد أفراد نشطين للقسمة بالتساوي', 'danger');
    return;
  }

  const totalGb = parseFloat(pool.totalGB || 200);
  const eachGb = Math.floor((totalGb / activeMembers.length) * 10) / 10;
  const eachMb = Math.round(eachGb * 1024);

  if (!confirm(`سيتم ضبط الكوتة الشهرية الأساسية (${totalGb} GB) بالتساوي على ${activeMembers.length} أفراد (${eachGb} GB لكل فرد). هل تريد المتابعة؟`)) {
    return;
  }

  showToast('جاري تطبيق التوزيع بالتساوي على فودافون DXL...');
  try {
    for (const mem of activeMembers) {
      await updateQuotaDirect(mem.msisdn, eachMb, 1500, 200);
    }
    showToast('تم التوزيع بالتساوي بنجاح!');
    await loadFamilyData();
    await loadOwners();
  } catch (err) {
    showToast(`خطأ أثناء التوزيع: ${err.message}`, 'danger');
  }
});

// Delete Owner Handler (Available globally)
window.deleteOwner = async function (toDeleteId) {
  if (!toDeleteId) return;
  if (!confirm('هل تريد بالتأكيد حذف هذا الأونر من النظام؟')) return;
  try {
    ownersList = ownersList.filter(o => o.id !== toDeleteId && o.phone !== toDeleteId);
    if (activeOwnerId === toDeleteId) {
      activeOwnerId = ownersList[0]?.id || null;
    }
    await saveOwnersToStorage();

    // Call server to keep local copy updated if applicable
    apiFetch('/api/owners', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId: toDeleteId })
    }).catch(() => { });

    showToast('تم حذف الأونر بنجاح');
    renderOverviewCards();
    renderManagePills();

    if (currentTab === 'manage') {
      if (activeOwnerId) await loadFamilyData();
      else switchTab('overview');
    }
  } catch (e) {
    showToast(`خطأ في الحذف: ${e.message}`, 'danger');
  }
};

document.getElementById('btnDeleteCurrentOwner')?.addEventListener('click', () => {
  if (activeOwnerId) window.deleteOwner(activeOwnerId);
});

// -------------------------------------------------------------
// 5. Form Submissions
// -------------------------------------------------------------

// Form: Add Owner
document.getElementById('formAddOwner')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('newOwnerPhone').value.trim();
  const password = document.getElementById('newOwnerPassword').value.trim();
  const label = document.getElementById('newOwnerLabel').value.trim();

  const textSpan = document.getElementById('btnSubmitOwnerText');
  const spinner = document.getElementById('ownerSpinner');
  const msg = document.getElementById('addOwnerMsg');

  textSpan.textContent = 'جاري التحقق مع فودافون...';
  spinner.style.display = 'inline-block';
  msg.style.display = 'none';

  try {
    const res = await fetch('/api/owners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password, label })
    });
    const d = await res.json().catch(() => ({ success: false, message: 'استجابة غير صحيحة من السيرفر (' + res.status + ')' }));
    if (!d.success) throw new Error(d.message || d.error || 'فشل التحقق من حساب فودافون');

    // Save newly verified owner in local & Telegram CloudStorage
    const newOwner = d.owner;
    const existingIdx = ownersList.findIndex(o => o.phone === newOwner.phone);
    if (existingIdx >= 0) ownersList[existingIdx] = newOwner;
    else ownersList.push(newOwner);

    activeOwnerId = newOwner.id;
    await saveOwnersToStorage();

    showToast(`تم التحقق من الأونر ${phone} وحفظه بنجاح!`);
    closeModal('modalAddOwner');
    document.getElementById('formAddOwner').reset();

    const countElem = document.getElementById('headerOwnersCount');
    if (countElem) countElem.textContent = ownersList.length;

    renderOverviewCards();
    renderManagePills();
    await selectOwnerAndGo(newOwner.id);
  } catch (err) {
    msg.style.display = 'block';
    msg.textContent = `فشل التحقق: ${err.message}`;
  } finally {
    textSpan.textContent = 'تحقق وحفظ الخط';
    spinner.style.display = 'none';
  }
});

// Form: Add Member
document.getElementById('formAddMember')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('addMemberPhone').value.trim();
  const password = document.getElementById('addMemberPassword').value.trim();
  const name = document.getElementById('addMemberName').value.trim();
  const gb = parseFloat(document.getElementById('addMemberGB').value) || 25;
  const voice = parseInt(document.getElementById('addMemberVoice').value) || 1500;
  const mi = Math.round(gb * 1024);

  const textSpan = document.getElementById('btnSubmitAddMemberText');
  const spinner = document.getElementById('addMemberSpinner');
  const msg = document.getElementById('addMemberMsg');

  textSpan.textContent = 'جاري التحقق من الفرد في فودافون...';
  spinner.style.display = 'inline-block';
  msg.style.display = 'none';

  try {
    const res = await apiFetch('/api/family/add-member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memberPhone: phone,
        password,
        memberName: name,
        mi,
        voice,
        sms: 200
      })
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || 'فشلت إضافة الفرد');

    if (name) {
      const names = await AppStorage.get('member_names', {});
      names[phone] = name;
      await AppStorage.set('member_names', names);
    }

    if (password) {
      const passwords = await AppStorage.get('member_passwords', {});
      passwords[phone] = password;
      await AppStorage.set('member_passwords', passwords);
    }

    showToast(d.message || `تم إرسال دعوة الانضمام للرقم ${phone}!`);
    closeModal('modalAddMember');
    document.getElementById('formAddMember').reset();
    await loadFamilyData();
    await loadOwners();
  } catch (err) {
    msg.style.display = 'block';
    msg.textContent = err.message;
  } finally {
    textSpan.textContent = 'تحقق من الفرد وإرسال الدعوة';
    spinner.style.display = 'none';
  }
});

// Form: Add Mid-Month Extra GBs
document.getElementById('formAddExtraGB')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('extraGBTargetPhone').value;
  const extraGb = parseFloat(document.getElementById('extraGBInput').value);

  const textSpan = document.getElementById('btnSubmitExtraGBText');
  const spinner = document.getElementById('extraGBSpinner');

  textSpan.textContent = 'جاري إضافة الجيجات عبر فودافون DXL...';
  spinner.style.display = 'inline-block';

  try {
    const res = await apiFetch('/api/members/add-extra-quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberPhone: phone, extraGb })
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || 'فشلت إضافة الجيجات');

    showToast(d.message || `تمت إضافة +${extraGb} GB بنجاح!`);
    closeModal('modalAddExtraGB');
    await loadFamilyData();
    await loadOwners();
  } catch (err) {
    showToast(`خطأ فودافون: ${err.message}`, 'danger');
  } finally {
    textSpan.textContent = 'إضافة الجيجات الآن في فودافون';
    spinner.style.display = 'none';
  }
});

// Form: Update Member Password after OTP
document.getElementById('formUpdatePassword')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('updatePwdTargetPhone').value;
  const password = document.getElementById('newMemberPasswordInput').value.trim();

  const textSpan = document.getElementById('btnSubmitUpdatePwdText');
  const spinner = document.getElementById('updatePwdSpinner');
  const msg = document.getElementById('updatePwdMsg');

  textSpan.textContent = 'جاري التحقق من الباسورد الجديد...';
  spinner.style.display = 'inline-block';
  msg.style.display = 'none';

  try {
    const res = await apiFetch('/api/members/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || 'فشل التحقق من الباسورد');

    const passwords = await AppStorage.get('member_passwords', {});
    passwords[phone] = password;
    await AppStorage.set('member_passwords', passwords);

    showToast(d.message || 'تم توثيق وحفظ الباسورد الجديد بنجاح!');
    closeModal('modalUpdatePassword');
    await loadFamilyData();
  } catch (err) {
    msg.style.display = 'block';
    msg.textContent = err.message;
  } finally {
    textSpan.textContent = 'تحقق وحفظ الباسورد الجديد';
    spinner.style.display = 'none';
  }
});

// Form: Edit Name
document.getElementById('formEditName')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('editNameTargetPhone').value;
  const name = document.getElementById('editNameInput').value.trim();

  try {
    const names = await AppStorage.get('member_names', {});
    names[phone] = name;
    await AppStorage.set('member_names', names);

    apiFetch('/api/members/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name })
    }).catch(() => { });

    showToast(`تم تعديل الاسم إلى "${name}"`);
    closeModal('modalEditName');
    await loadFamilyData();
  } catch (err) {
    showToast(`خطأ: ${err.message}`, 'danger');
  }
});

// Form: Edit Base Monthly Quota
document.getElementById('formEditQuota')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('editQuotaPhone').value;
  const gb = parseFloat(document.getElementById('editQuotaGBInput').value) || 25;
  const voice = parseInt(document.getElementById('editQuotaVoiceInput').value) || 1500;
  const sms = parseInt(document.getElementById('editQuotaSMSInput').value) || 200;
  const mi = Math.round(gb * 1024);

  try {
    showToast(`جاري إرسال تعديل الكوتة لـ ${phone} عبر DXL...`);
    await updateQuotaDirect(phone, mi, voice, sms);
    showToast(`تم تعديل الكوتة الشهرية الأساسية لـ ${phone} إلى ${gb} GB بنجاح!`);
    closeModal('modalEditQuota');
    await loadFamilyData();
    await loadOwners();
  } catch (err) {
    showToast(`خطأ فودافون: ${err.message}`, 'danger');
  }
});

// Header Buttons
document.getElementById('btnOpenAddOwnerHeader')?.addEventListener('click', () => openModal('modalAddOwner'));
document.getElementById('btnStripAddOwner')?.addEventListener('click', () => openModal('modalAddOwner'));
document.getElementById('btnOpenAddMember')?.addEventListener('click', () => openModal('modalAddMember'));
document.getElementById('btnRefreshLive')?.addEventListener('click', async () => {
  showToast('جاري تحديث كافة البيانات من سيرفرات فودافون مباشرة...');
  await Promise.all([
    loadOwners(true),
    loadFamilyData(true)
  ]);
});

// =============================================================
// LIVE NOTIFICATIONS CENTER & BADGE
// =============================================================
async function getNotifications() {
  return await AppStorage.get('app_notifications', []);
}

async function saveNotifications(notifs) {
  await AppStorage.set('app_notifications', notifs);
  updateNotifBadge(notifs);
}

function updateNotifBadge(notifs) {
  const badge = document.getElementById('notifBadgeCount');
  if (!badge) return;
  const unread = (notifs || []).filter(n => !n.read).length;
  if (unread > 0) {
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

async function initNotificationsBadge() {
  const notifs = await getNotifications();
  updateNotifBadge(notifs);
}

async function addNotification(notif) {
  try {
    const notifs = await getNotifications();
    const newNotif = {
      id: 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: Date.now(),
      read: false,
      ...notif
    };
    notifs.unshift(newNotif);
    if (notifs.length > 60) notifs.length = 60;
    await saveNotifications(notifs);
    showToast(newNotif.title, newNotif.type === 'leave' ? 'danger' : 'ok');
  } catch (e) {
    console.warn('addNotification error:', e);
  }
}

async function renderNotificationsTab() {
  const container = document.getElementById('notificationsList');
  if (!container) return;
  const notifs = await getNotifications();
  container.innerHTML = '';

  if (!notifs || notifs.length === 0) {
    container.innerHTML = `
      <div class="notif-empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <p style="font-weight: 800; font-size: 1.05rem; color: #fff; margin-bottom: 6px;">لا توجد إشعارات جديدة حالياً</p>
        <p style="font-size: 0.85rem; color: var(--text-muted);">عند قبول دعوة أي فرد في فودافون أو خروجه من العائلة، سيظهر التنبيه هنا فوراً باللون الأحمر.</p>
      </div>
    `;
    return;
  }

  notifs.forEach(n => {
    const card = document.createElement('div');
    card.className = `notification-card ${n.read ? 'read' : 'unread'}`;

    const dateStr = new Date(n.timestamp).toLocaleDateString('ar-EG', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    let iconSvg = '';
    let iconClass = n.type || 'info';

    if (n.type === 'accept') {
      iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (n.type === 'leave') {
      iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    } else if (n.type === 'password_error' || n.type === 'member_password_error') {
      iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path><line x1="12" y1="16" x2="12" y2="16.01"></line></svg>';
      iconClass = 'danger';
    } else {
      iconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    }

    card.innerHTML = `
      <div class="notif-left">
        <div class="notif-icon-box ${iconClass}">
          ${iconSvg}
        </div>
        <div class="notif-content">
          <div class="notif-title">${n.title}</div>
          <div class="notif-desc">${n.desc}</div>
          <div class="notif-meta">
            <span class="notif-owner-badge">خط الأونر: ${formatPhone(n.ownerPhone)} (${n.ownerLabel || 'أونر'})</span>
            <span class="tabular">${dateStr}</span>
          </div>
        </div>
      </div>

      <div class="notif-right">
        ${!n.read ? '<span class="notif-unread-dot" title="تنبيه غير مقروء"></span>' : ''}
        ${n.type === 'password_error' ? `
        <button class="btn btn-primary btn-sm btn-notif-edit-pwd" data-phone="${n.ownerPhone || n.memberPhone}" style="font-size: 0.78rem; padding: 6px 12px; margin-left: 6px;">
          <span>🔑 تعديل باسورد الأونر</span>
        </button>
        ` : ''}
        ${n.type === 'member_password_error' ? `
        <button class="btn btn-primary btn-sm btn-notif-edit-member-pwd" data-phone="${n.memberPhone}" data-name="${n.memberName || ''}" style="font-size: 0.78rem; padding: 6px 12px; margin-left: 6px;">
          <span>🔑 تعديل باسورد الفرد</span>
        </button>
        ` : ''}
        <button class="btn btn-soft btn-sm btn-open-notif-owner" style="font-size: 0.78rem; padding: 6px 12px;">
          <span>فتح الأونر</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>
    `;

    // Click handler: mark as read and navigate to owner
    const editPwdBtn = card.querySelector('.btn-notif-edit-pwd');
    if (editPwdBtn) {
      editPwdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        n.read = true;
        saveNotifications(notifs);
        renderNotificationsTab();
        window.openUpdateOwnerPwdModal(editPwdBtn.dataset.phone);
      });
    }

    const editMemberPwdBtn = card.querySelector('.btn-notif-edit-member-pwd');
    if (editMemberPwdBtn) {
      editMemberPwdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        n.read = true;
        saveNotifications(notifs);
        renderNotificationsTab();
        const pPhone = editMemberPwdBtn.dataset.phone;
        const pName = editMemberPwdBtn.dataset.name || 'الفرد';
        document.getElementById('updatePwdTargetPhone').value = pPhone;
        document.getElementById('updatePwdPhoneSubtitle').textContent = `للفرد: ${pName} (${formatPhone(pPhone)})`;
        document.getElementById('newMemberPasswordInput').value = '';
        document.getElementById('updatePwdMsg').style.display = 'none';
        openModal('modalUpdatePassword');
      });
    }

    card.addEventListener('click', async () => {
      n.read = true;
      await saveNotifications(notifs);
      renderNotificationsTab();

      // Navigate to owner and highlight member
      if (n.ownerPhone) {
        await selectOwnerAndGo(n.ownerPhone);
        if (n.memberPhone) {
          setTimeout(() => {
            const targetEl = document.querySelector(`[data-member-phone="${n.memberPhone}"]`);
            if (targetEl) {
              targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
              targetEl.classList.add('highlight-search-card');
              setTimeout(() => targetEl.classList.remove('highlight-search-card'), 3500);
            }
          }, 350);
        }
      }
    });

    container.appendChild(card);
  });
}

document.getElementById('btnMarkAllNotifsRead')?.addEventListener('click', async () => {
  const notifs = await getNotifications();
  notifs.forEach(n => n.read = true);
  await saveNotifications(notifs);
  renderNotificationsTab();
  showToast('تم تحديد جميع الإشعارات كمقروءة');
});

document.getElementById('btnClearAllNotifs')?.addEventListener('click', async () => {
  if (!confirm('هل تريد مسح سجل الإشعارات بالكامل؟')) return;
  await saveNotifications([]);
  renderNotificationsTab();
  showToast('تم مسح سجل الإشعارات');
});

// =============================================================
// GLOBAL MEMBER SEARCH (البحث برقم أي فرد في جميع العائلات)
// =============================================================
function setupGlobalMemberSearch() {
  const searchInput = document.getElementById('globalMemberSearchInput');
  const clearBtn = document.getElementById('btnClearMemberSearch');
  const feedback = document.getElementById('memberSearchFeedback');

  if (!searchInput) return;

  let searchTimeout = null;

  async function executeSearch() {
    const rawVal = searchInput.value.trim();
    if (!rawVal) {
      if (clearBtn) clearBtn.style.display = 'none';
      if (feedback) { feedback.style.display = 'none'; feedback.innerHTML = ''; }
      return;
    }

    if (clearBtn) clearBtn.style.display = 'block';

    const cleanQuery = rawVal.replace(/\D/g, '');
    if (cleanQuery.length < 3 && rawVal.length < 3) {
      if (feedback) {
        feedback.style.display = 'flex';
        feedback.className = 'search-feedback-banner not-found';
        feedback.textContent = 'يرجى كتابة 3 أرقام على الأقل من رقم موبايل الفرد...';
      }
      return;
    }

    if (feedback) {
      feedback.style.display = 'flex';
      feedback.className = 'search-feedback-banner';
      feedback.style.color = 'var(--text-soft)';
      feedback.textContent = 'جاري البحث في جميع خطوط الأونر والعائلات...';
    }

    // Search across all owners
    let matchedOwner = null;
    let matchedMember = null;

    for (const o of ownersList) {
      // 1. Check cached family
      const cacheKey = `family_cache_${o.id || o.phone}`;
      let cached = await AppStorage.get(cacheKey, null);

      // If no cache yet, fetch family data
      if (!cached || !cached.members) {
        try {
          const headers = { 'x-owner-phone': o.phone };
          if (o.password) headers['x-owner-password'] = o.password;
          if (o.token?.access_token) headers['x-owner-token'] = JSON.stringify(o.token);
          const res = await fetch('/api/family', { headers });
          const d = await res.json().catch(() => ({}));
          if (d.success) {
            cached = d;
            await AppStorage.set(cacheKey, d);
          }
        } catch (e) { }
      }

      if (cached) {
        const allList = [
          ...(cached.members || []),
          ...(cached.pendingInvitations || cached.pendingInvites || [])
        ];

        const found = allList.find(m => {
          const mPhone = String(m.msisdn || '').replace(/\D/g, '');
          const mName = String(m.name || '').toLowerCase();
          return (cleanQuery && mPhone.includes(cleanQuery)) || mName.includes(rawVal.toLowerCase());
        });

        if (found) {
          matchedOwner = o;
          matchedMember = found;
          break;
        }
      }
    }

    if (matchedOwner && matchedMember) {
      if (feedback) {
        feedback.style.display = 'flex';
        feedback.className = 'search-feedback-banner success';
        feedback.innerHTML = `
          <span>✓ تم العثور على الفرد <strong>${matchedMember.name || matchedMember.msisdn}</strong> في عائلة الأونر <strong>${formatPhone(matchedOwner.phone)} (${matchedOwner.label || 'أونر'})</strong>. جاري الفتح...</span>
        `;
      }

      // Automatically select this owner and open their family
      await selectOwnerAndGo(matchedOwner.id || matchedOwner.phone);

      // Scroll and highlight card
      setTimeout(() => {
        const memberElem = document.querySelector(`[data-member-phone="${matchedMember.msisdn}"]`);
        if (memberElem) {
          memberElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
          memberElem.classList.add('highlight-search-card');
          setTimeout(() => memberElem.classList.remove('highlight-search-card'), 3500);
        }
      }, 400);

    } else {
      if (feedback) {
        feedback.style.display = 'flex';
        feedback.className = 'search-feedback-banner not-found';
        feedback.innerHTML = `<span>❌ لم يتم العثور على أي فرد بالرقم أو الاسم "<strong>${rawVal}</strong>" في أي من خطوط الأونر المسجلة.</span>`;
      }
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(executeSearch, 400);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimeout);
      executeSearch();
    }
  });

  clearBtn?.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    if (feedback) {
      feedback.style.display = 'none';
      feedback.innerHTML = '';
    }
    searchInput.focus();
  });
}

// =============================================================
// CONSUMPTION MODAL (عرض استهلاك الفرد)
// =============================================================
function showConsumptionModal(phone, name, consumption) {
  // Remove existing modal if any
  const existingModal = document.getElementById('modalConsumption');
  if (existingModal) existingModal.remove();
  
  const data = consumption || {};
  const usedGB = parseFloat(data.usedGB || 0).toFixed(2);
  const totalGB = parseFloat(data.totalGB || 0).toFixed(1);
  const remainingGB = parseFloat(data.remainingGB || 0).toFixed(2);
  const usedPercent = totalGB > 0 ? Math.min(100, Math.round((usedGB / totalGB) * 100)) : 0;
  const usedMins = parseInt(data.usedVoice || 0);
  const totalMins = parseInt(data.totalVoice || 0);
  const remainingMins = Math.max(0, totalMins - usedMins);
  const usedSMS = parseInt(data.usedSMS || 0);
  const totalSMS = parseInt(data.totalSMS || 0);
  const remainingSMS = Math.max(0, totalSMS - usedSMS);
  
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modalConsumption';
  modal.innerHTML = `
    <div class="modal-dialog" style="max-width: 480px;">
      <div class="modal-head">
        <div>
          <h3 class="modal-heading">استهلاك الفرد</h3>
          <p class="modal-desc">${name} (${formatPhone(phone)})</p>
        </div>
        <button class="modal-close-btn" id="btnCloseConsumption">&times;</button>
      </div>
      
      <div class="modal-content">
        <div style="background: rgba(0,0,0,0.3); border-radius: 12px; padding: 16px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="color: var(--text-soft); font-size: 0.85rem;">الإنترنت</span>
            <span class="tabular" style="color: var(--sky); font-weight: 900; font-size: 1.1rem;">${usedGB} / ${totalGB} GB</span>
          </div>
          <div class="card-progress-bar" style="height: 10px; border-radius: 6px;">
            <div class="card-progress-fill" style="width: ${usedPercent}%; background: ${usedPercent > 85 ? 'var(--vf-red)' : 'var(--sky)'}; border-radius: 6px;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; margin-top: 6px;">
            <span style="color: var(--text-muted); font-size: 0.78rem;">مستهلك: ${usedGB} GB</span>
            <span style="color: var(--mint); font-size: 0.78rem; font-weight: 700;">متبقي: ${remainingGB} GB</span>
          </div>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div style="background: rgba(0,0,0,0.3); border-radius: 12px; padding: 14px; text-align: center;">
            <div style="color: var(--text-muted); font-size: 0.78rem; margin-bottom: 4px;">الدقائق</div>
            <div class="tabular" style="font-size: 1rem; font-weight: 900; color: #fff;">${usedMins.toLocaleString()} / ${totalMins.toLocaleString()}</div>
            <div style="color: var(--mint); font-size: 0.75rem; margin-top: 2px;">متبقي: ${remainingMins.toLocaleString()} دقيقة</div>
          </div>
          <div style="background: rgba(0,0,0,0.3); border-radius: 12px; padding: 14px; text-align: center;">
            <div style="color: var(--text-muted); font-size: 0.78rem; margin-bottom: 4px;">الرسائل</div>
            <div class="tabular" style="font-size: 1rem; font-weight: 900; color: #fff;">${usedSMS} / ${totalSMS}</div>
            <div style="color: var(--mint); font-size: 0.75rem; margin-top: 2px;">متبقي: ${remainingSMS} رسالة</div>
          </div>
        </div>
        
        ${data.renewalDate ? `<div style="text-align: center; margin-top: 12px; color: var(--amber); font-size: 0.82rem; font-weight: 600;">ميعاد التجديد: ${data.renewalDate}</div>` : ''}
      </div>
      
      <div class="modal-foot">
        <button class="btn btn-soft" id="btnCloseConsumption2">إغلاق</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  document.getElementById('btnCloseConsumption').addEventListener('click', () => modal.remove());
  document.getElementById('btnCloseConsumption2').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  loadOwners();
  loadFamilyData();
  initNotificationsBadge();
  setupGlobalMemberSearch();
  setupPhoneFieldPasteCleanup();
});

// =============================================================
// PHONE PASTE CLEANUP
// =============================================================
// =============================================================
// PHONE PASTE & INPUT CLEANUP (تنظيف اللصق والإدخال - يزيل أي نص غير رقمي)
// =============================================================

// =============================================================
// OWNER PASSWORD MANAGEMENT (تعديل وتحديث باسورد الأونر)
// =============================================================
window.openUpdateOwnerPwdModal = function(phone) {
  const targetPhone = phone || activeOwnerId || getActiveOwner()?.phone;
  if (!targetPhone) {
    showToast('يرجى اختيار أونر أولاً', 'danger');
    return;
  }
  const cleanPhone = String(targetPhone).replace(/\D/g, '');
  document.getElementById('updateOwnerPwdTargetPhone').value = cleanPhone;
  const displayInput = document.getElementById('updateOwnerPwdPhoneDisplay');
  if (displayInput) displayInput.value = formatPhone(cleanPhone);
  const subtitle = document.getElementById('updateOwnerPwdSubtitle');
  if (subtitle) subtitle.textContent = `تحديث كلمة السر للخط: ${formatPhone(cleanPhone)}`;
  
  const pwdInput = document.getElementById('newOwnerPasswordInput');
  if (pwdInput) pwdInput.value = '';
  const msg = document.getElementById('updateOwnerPwdMsg');
  if (msg) msg.style.display = 'none';

  openModal('modalUpdateOwnerPassword');
};

document.getElementById('btnOpenUpdateCurrentOwnerPwd')?.addEventListener('click', () => {
  const activeOwner = getActiveOwner();
  if (activeOwner && activeOwner.phone) {
    window.openUpdateOwnerPwdModal(activeOwner.phone);
  }
});

document.getElementById('formUpdateOwnerPassword')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('updateOwnerPwdTargetPhone').value.trim();
  const password = document.getElementById('newOwnerPasswordInput').value.trim();

  const textSpan = document.getElementById('btnSubmitUpdateOwnerPwdText');
  const spinner = document.getElementById('updateOwnerPwdSpinner');
  const msg = document.getElementById('updateOwnerPwdMsg');

  textSpan.textContent = 'جاري التحقق مع فودافون...';
  spinner.style.display = 'inline-block';
  msg.style.display = 'none';

  try {
    const res = await fetch('/api/owners/update-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const d = await res.json().catch(() => ({ success: false, error: 'استجابة غير صحيحة' }));
    if (!d.success) throw new Error(d.error || d.message || 'فشل التحقق من كلمة السر');

    // Update in ownersList
    const oIdx = ownersList.findIndex(o => o.phone === phone || o.id === phone);
    if (oIdx >= 0) {
      ownersList[oIdx].password = password;
      if (d.owner?.token) ownersList[oIdx].token = d.owner.token;
      ownersList[oIdx].verifyStatus = 'verified';
    }
    await saveOwnersToStorage();

    showToast(`تم تحديث باسورد الأونر ${formatPhone(phone)} بنجاح!`);
    closeModal('modalUpdateOwnerPassword');

    // Re-load to refresh stats
    await loadOwners(true);
    if (activeOwnerId === phone) {
      await loadFamilyData(true);
    }
  } catch (err) {
    msg.style.display = 'block';
    msg.textContent = `فشل التحقق: ${err.message}`;
  } finally {
    textSpan.textContent = 'تحقق وحفظ الباسورد';
    spinner.style.display = 'none';
  }
});

function setupPhoneFieldPasteCleanup() {
  const phoneFields = [
    'addMemberPhone',
    'newOwnerPhone',
    'globalMemberSearchInput'
  ];

  function extractCleanPhone(raw) {
    if (!raw) return '';
    const str = String(raw).trim();
    // Match Egyptian mobile number (010, 011, 012, 015 followed by 8 digits)
    const egMatch = str.match(/(?:20|0)?(1[0125][0-9]{8})/);
    if (egMatch) {
      return '0' + egMatch[1];
    }
    // Fallback: keep only numbers
    return str.replace(/[^0-9]/g, '');
  }

  phoneFields.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (!field) return;

    // 1. Handle Paste Event
    field.addEventListener('paste', (e) => {
      e.preventDefault();
      const pastedText = (e.clipboardData || window.clipboardData).getData('text') || '';
      const cleaned = extractCleanPhone(pastedText);
      field.value = cleaned;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 2. Handle Input / Type Event (if non-digits or arabic labels leaked in)
    field.addEventListener('input', () => {
      if (/[^0-9]/.test(field.value)) {
        const cleaned = extractCleanPhone(field.value);
        if (cleaned !== field.value) {
          field.value = cleaned;
        }
      }
    });

    // 3. Handle Blur (on leaving field)
    field.addEventListener('blur', () => {
      const cleaned = extractCleanPhone(field.value);
      if (cleaned && cleaned !== field.value) {
        field.value = cleaned;
      }
    });
  });
}


// =============================================================
// INVITATION ACCEPTANCE GUIDANCE MODAL
// =============================================================
function showInviteAcceptanceGuideModal(memberPhone) {
  const existing = document.getElementById('modalInviteGuide');
  if (existing) existing.remove();

  const activeOwner = getActiveOwner();
  const ownerNum = activeOwner?.phone ? formatPhone(activeOwner.phone) : '';
  const cleanPhone = String(memberPhone).replace(/\D/g, '');
  const waIntl = cleanPhone.startsWith('0') ? `20${cleanPhone.slice(1)}` : `20${cleanPhone}`;
  const waMsg = encodeURIComponent(`أهلاً بك! تم إرسال باقة فودافون فاميلي لرقمك من خط الأونر (${ownerNum}). لقبول وتفعيل الباقة فوراً اطلب الكود المجاني: *41# أو افتح تطبيق أنا فودافون واضغط قبول في قسم الرسائل.`);
  const waLink = `https://wa.me/${waIntl}?text=${waMsg}`;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modalInviteGuide';
  modal.innerHTML = `
    <div class="modal-dialog" style="max-width: 440px;">
      <div class="modal-head">
        <div>
          <h3 class="modal-heading">قبول دعوة الفرد</h3>
          <p class="modal-desc">للرقم: ${formatPhone(memberPhone)}</p>
        </div>
        <button class="modal-close-btn" id="btnCloseInviteGuide">&times;</button>
      </div>

      <div class="modal-content">
        <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 12px; padding: 14px; margin-bottom: 14px;">
          <div style="display: flex; align-items: center; gap: 8px; color: var(--mint); font-weight: 800; font-size: 0.95rem; margin-bottom: 6px;">
            <span>✓ الدعوة مسجلة بنجاح على شبكة فودافون</span>
          </div>
          <div style="font-size: 0.82rem; color: var(--text-soft); line-height: 1.5;">
            الدعوة معلقة حالياً في حساب الفرد وتظهر في تطبيق <strong>أنا فودافون</strong> بقسم <strong>الرسائل</strong>.
          </div>
        </div>

        <div style="font-size: 0.88rem; font-weight: 800; color: #fff; margin-bottom: 10px;">طرق قبول وتفعيل الباقة فوراً:</div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          <!-- Method 1: Ana Vodafone App -->
          <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
              <span style="background: var(--vf-red); color: #fff; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 900;">الطريقة 1</span>
              <strong style="color: #fff; font-size: 0.85rem;">تطبيق أنا فودافون</strong>
            </div>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin: 0;">
              افتح تطبيق أنا فودافون على هاتف الفرد، ادخل قسم <strong>الرسائل</strong>، واضغط زر <strong>[قبول]</strong> الأحمر.
            </p>
          </div>

          <!-- Method 2: USSD Code *41# -->
          <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
              <span style="background: #f59e0b; color: #000; font-size: 0.72rem; padding: 2px 7px; border-radius: 4px; font-weight: 900;">الطريقة 2 (الأسرع)</span>
              <strong style="color: #fff; font-size: 0.85rem;">الكود السريع المجاني</strong>
            </div>
            <p style="font-size: 0.82rem; color: #f59e0b; margin: 0; font-weight: 700;">
              اطلب من خط الفرد الكود: <span style="font-size: 1.1rem; letter-spacing: 2px;">*41#</span> واضغط اتصال
            </p>
          </div>
        </div>

        <!-- WhatsApp Share Button -->
        <div style="margin-top: 14px;">
          <a href="${waLink}" target="_blank" class="btn btn-primary" style="width: 100%; justify-content: center; background: #25D366; border-color: #25D366; color: #000; font-weight: 900;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
            <span>إرسال كود التفعيل للفرد عبر واتساب</span>
          </a>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn btn-soft" id="btnCloseInviteGuide2">إغلاق</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('btnCloseInviteGuide')?.addEventListener('click', () => modal.remove());
  document.getElementById('btnCloseInviteGuide2')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}
