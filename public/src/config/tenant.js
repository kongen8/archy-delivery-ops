// ===== TENANT TOKEN BOOTSTRAP =====
// Runs before supabase.js. Resolves the current tenant's access token
// from (priority): URL ?tok= → localStorage. Persists the URL token to
// localStorage then strips it so it never leaks into referrers, screenshots
// or browser history.
//
// When no token is found we render a minimal "paste access token" gate into
// #root and set window.__TENANT_GATE_ACTIVE__ so the React mount script in
// index.html short-circuits.
//
// When a token is found we expose it as window.__TENANT_TOKEN__ so that
// supabase.js can instantiate a tenant-scoped client that attaches the
// `x-tenant-token` header to every request (the header the RLS policies in
// migration 004_rls.sql consult).
(function () {
  const KEY = 'tenantToken';
  const QUERY_PARAM = 'tok';

  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get(QUERY_PARAM);
  if (urlToken) {
    try { localStorage.setItem(KEY, urlToken); } catch (e) { /* storage may be disabled */ }
    params.delete(QUERY_PARAM);
    const qs = params.toString();
    const cleanUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    try { window.history.replaceState(null, '', cleanUrl); } catch (e) {}
  }

  let token = null;
  try { token = localStorage.getItem(KEY); } catch (e) {}

  if (token) {
    window.__TENANT_TOKEN__ = token;
    window.tenantSignOut = function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      window.location.replace(window.location.pathname);
    };
    return;
  }

  window.__TENANT_GATE_ACTIVE__ = true;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderGate);
  } else {
    renderGate();
  }

  function renderGate() {
    const root = document.getElementById('root');
    if (!root) return;
    root.innerHTML = [
      '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;',
      'padding:24px;background:#f9fafb;font-family:\'DM Sans\',sans-serif;">',
      '  <form id="tenant-gate-form" style="background:#fff;border:1px solid #e5e7eb;',
      '  border-radius:16px;padding:32px;max-width:420px;width:100%;',
      '  box-shadow:0 1px 2px rgba(0,0,0,.05);">',
      '    <h1 style="font-size:20px;font-weight:600;margin:0 0 8px;color:#111827;">',
      '      Archy × Daymaker',
      '    </h1>',
      '    <p style="font-size:14px;color:#6b7280;margin:0 0 20px;line-height:1.5;">',
      '      Paste your access token to continue. Ask the admin for a token',
      '      or for a pre-signed link (<code>?tok=…</code>).',
      '    </p>',
      '    <label for="tenant-gate-input" style="display:block;font-size:12px;',
      '    font-weight:500;color:#374151;margin-bottom:6px;">Access token</label>',
      '    <input id="tenant-gate-input" type="password" autocomplete="off"',
      '    autofocus required placeholder="tok_…"',
      '    style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;',
      '    font-family:ui-monospace,Menlo,monospace;font-size:13px;box-sizing:border-box;"/>',
      '    <button type="submit" style="margin-top:16px;width:100%;background:#111827;',
      '    color:#fff;border:0;padding:10px 12px;border-radius:8px;font-weight:600;',
      '    font-size:14px;cursor:pointer;">',
      '      Continue',
      '    </button>',
      '    <p id="tenant-gate-err" style="color:#dc2626;font-size:12px;margin:10px 0 0;',
      '    min-height:16px;"></p>',
      '  </form>',
      '</div>',
    ].join('');

    const form = root.querySelector('#tenant-gate-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const input = root.querySelector('#tenant-gate-input');
      const err = root.querySelector('#tenant-gate-err');
      const val = (input.value || '').trim();
      if (!val) {
        err.textContent = 'Enter a token.';
        return;
      }
      try { localStorage.setItem(KEY, val); } catch (e2) {
        err.textContent = 'Could not save token (storage disabled).';
        return;
      }
      window.location.reload();
    });
  }
})();
