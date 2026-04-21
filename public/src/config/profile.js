// ===== PROFILE BOOTSTRAP =====
// Resolves the current profile (admin | bakery | customer) from, in order:
//   1. window.location.hash           — canonical address (`#/admin`, `#/bakery/<uuid>`, `#/customer/<uuid>`)
//   2. ?profile=<type>:<uuid> query   — handoff from "Share link" URLs
//   3. localStorage 'profile'          — returning visitor
//   4. otherwise                       — render LandingPicker
//
// Plan 2 has no authentication: the profile is purely "which hat am I wearing".
// Token infrastructure from Plan 1 stays dormant in supabase.js (makeTenantClient).
(function () {
  const STORAGE_KEY = 'profile';
  const QUERY_PARAM = 'profile';

  const hashProfile = parseHash(window.location.hash);
  if (hashProfile) {
    persist(hashProfile);
    expose(hashProfile);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const urlProfile = parseQuery(params.get(QUERY_PARAM));
  if (urlProfile) {
    persist(urlProfile);
    params.delete(QUERY_PARAM);
    const qs = params.toString();
    const targetHash = '#/' + urlProfile.type + (urlProfile.id ? '/' + urlProfile.id : '');
    const cleanUrl = window.location.pathname + (qs ? '?' + qs : '') + targetHash;
    try { window.history.replaceState(null, '', cleanUrl); } catch (e) {}
    expose(urlProfile);
    return;
  }

  const stored = readStored();
  if (stored) {
    const targetHash = '#/' + stored.type + (stored.id ? '/' + stored.id : '');
    if (window.location.hash !== targetHash) window.location.hash = targetHash;
    expose(stored);
    return;
  }

  // No profile → render the landing picker into #root and short-circuit.
  installGlobalActions();
  window.__PROFILE_GATE_ACTIVE__ = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderLandingPicker);
  } else {
    renderLandingPicker();
  }

  // ----------------- helpers -----------------

  function parseHash(hash) {
    if (!hash) return null;
    const m = hash.match(/^#\/(admin|bakery|customer|driver)(?:\/([a-f0-9-]{36}))?/i);
    if (!m) return null;
    return { type: m[1].toLowerCase(), id: m[2] || null };
  }

  function parseQuery(value) {
    if (!value) return null;
    const [type, id] = value.split(':');
    if (!type || !/^(admin|bakery|customer|driver)$/i.test(type)) return null;
    // admin needs no id; driver may have no id (we show a bakery picker).
    if (type !== 'admin' && type !== 'driver' && !id) return null;
    return { type: type.toLowerCase(), id: id || null };
  }

  function readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.type) return null;
      return { type: obj.type, id: obj.id || null };
    } catch (e) { return null; }
  }

  function persist(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (e) {}
  }

  // Always defined — landing picker runs before expose() and still needs these.
  function installGlobalActions() {
    window.switchProfile = function (next) {
      persist(next);
      const h = '#/' + next.type + (next.id ? '/' + next.id : '');
      if (window.location.hash === h) {
        window.location.reload();
      } else {
        window.location.hash = h;
        window.location.reload();
      }
    };
    window.signOutProfile = function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      window.location.replace(window.location.pathname);
    };
  }

  function expose(p) {
    window.__CURRENT_PROFILE__ = p;
    installGlobalActions();
  }

  async function renderLandingPicker() {
    const root = document.getElementById('root');
    if (!root) return;
    root.innerHTML = landingShell();
    const sbClient = typeof sb !== 'undefined' ? sb : null;
    const bakeriesEl = root.querySelector('#landing-bakeries');
    const customersEl = root.querySelector('#landing-customers');
    if (!sbClient) {
      bakeriesEl.textContent = 'Supabase not configured.';
      customersEl.textContent = '';
      return;
    }
    try {
      const [{ data: bakeries }, { data: customers }] = await Promise.all([
        sbClient.from('bakeries').select('id, name').order('name'),
        sbClient.from('customers').select('id, name').order('name'),
      ]);
      bakeriesEl.innerHTML = (bakeries || []).map(b =>
        `<button class="landing-row" data-type="bakery" data-id="${b.id}">${escapeHtml(b.name)}</button>`
      ).join('') || '<div class="landing-empty">No bakeries yet.</div>';
      customersEl.innerHTML = (customers || []).map(c =>
        `<button class="landing-row" data-type="customer" data-id="${c.id}">${escapeHtml(c.name)}</button>`
      ).join('') || '<div class="landing-empty">No customers yet.</div>';
      root.querySelectorAll('.landing-row').forEach(el => {
        el.addEventListener('click', () => {
          window.switchProfile({ type: el.dataset.type, id: el.dataset.id });
        });
      });
      root.querySelector('#landing-admin').addEventListener('click', () => {
        window.switchProfile({ type: 'admin', id: null });
      });
    } catch (e) {
      bakeriesEl.textContent = 'Failed to load: ' + e.message;
    }
  }

  function landingShell() {
    return `
      <style>
        .landing-page { min-height:100vh; display:flex; align-items:center; justify-content:center;
          padding:24px; background:#f9fafb; font-family:'DM Sans',system-ui,sans-serif; }
        .landing-card { background:#fff; border:1px solid #e5e7eb; border-radius:16px; padding:32px;
          max-width:860px; width:100%; box-shadow:0 1px 2px rgba(0,0,0,.05); }
        .landing-title { font-size:20px; font-weight:600; margin:0 0 4px; color:#111827; }
        .landing-subtitle { font-size:14px; color:#6b7280; margin:0 0 24px; }
        .landing-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
        .landing-col { border:1px solid #e5e7eb; border-radius:8px; padding:16px; }
        .landing-col h3 { margin:0 0 8px; font-size:12px; font-weight:600; text-transform:uppercase;
          letter-spacing:0.05em; color:#6b7280; }
        #landing-admin { display:block; width:100%; padding:12px; background:#111827; color:#fff;
          border:0; border-radius:6px; font-weight:500; font-size:13px; cursor:pointer; }
        .landing-row { display:block; width:100%; text-align:left; padding:8px 10px; margin-bottom:4px;
          background:#f3f4f6; color:#111827; border:0; border-radius:4px; font-size:13px; cursor:pointer; }
        .landing-row:hover { background:#e5e7eb; }
        .landing-empty { font-size:12px; color:#9ca3af; }
      </style>
      <div class="landing-page">
        <div class="landing-card">
          <div class="landing-title">Archy × Daymaker — Delivery Operations</div>
          <div class="landing-subtitle">Pick a profile to continue.</div>
          <div class="landing-grid">
            <div class="landing-col">
              <h3>Admin</h3>
              <button id="landing-admin">Enter admin</button>
            </div>
            <div class="landing-col">
              <h3>Bakeries</h3>
              <div id="landing-bakeries">Loading…</div>
            </div>
            <div class="landing-col">
              <h3>Customers</h3>
              <div id="landing-customers">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }
})();
