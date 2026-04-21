// ===== HASH ROUTER =====
// Ultra-thin router. Parses location.hash into a structured route and
// exposes subscribe/navigate helpers. React components read the current
// route via useRoute() (below) which subscribes to hashchange.
(function () {
  const ROUTES = [
    // Order matters: more specific patterns first.
    { pattern: /^#\/admin\/bakery\/new$/i, build: () => ({ view: 'admin', page: 'bakery-editor', id: null, isNew: true }) },
    { pattern: /^#\/admin\/bakery\/([a-f0-9-]{36})$/i, build: m => ({ view: 'admin', page: 'bakery-editor', id: m[1], isNew: false }) },
    { pattern: /^#\/admin\/customer\/new$/i, build: () => ({ view: 'admin', page: 'customer-editor', id: null, isNew: true }) },
    { pattern: /^#\/admin\/customer\/([a-f0-9-]{36})$/i, build: m => ({ view: 'admin', page: 'customer-editor', id: m[1], isNew: false }) },
    { pattern: /^#\/admin$/i, build: () => ({ view: 'admin', page: 'list', id: null }) },
    { pattern: /^#\/bakery\/([a-f0-9-]{36})$/i, build: m => ({ view: 'bakery', page: 'home', id: m[1] }) },
    // Driver link: read-only-ish ops view with no route-adjusting controls.
    { pattern: /^#\/driver\/([a-f0-9-]{36})$/i, build: m => ({ view: 'driver', page: 'home', id: m[1] }) },
    { pattern: /^#\/driver$/i, build: () => ({ view: 'driver', page: 'picker', id: null }) },
    // Upload-wizard route — campaignId can be the literal "new" (draft hasn't
    // been created yet) or a UUID (resume an existing draft).
    { pattern: /^#\/customer\/([a-f0-9-]{36})\/upload\/(new|[a-f0-9-]{36})$/i, build: m => ({ view: 'customer', page: 'upload', customerId: m[1], campaignId: m[2] }) },
    { pattern: /^#\/customer\/([a-f0-9-]{36})$/i, build: m => ({ view: 'customer', page: 'home', id: m[1] }) },
  ];

  function parseRoute(hash) {
    for (const r of ROUTES) {
      const m = hash.match(r.pattern);
      if (m) return r.build(m);
    }
    // Unknown hash → fall back to the profile's home.
    const p = window.__CURRENT_PROFILE__;
    if (!p) return { view: 'landing' };
    if (p.type === 'admin') return { view: 'admin', page: 'list', id: null };
    if (p.type === 'bakery' && p.id) return { view: 'bakery', page: 'home', id: p.id };
    if (p.type === 'customer' && p.id) return { view: 'customer', page: 'home', id: p.id };
    if (p.type === 'driver') return p.id ? { view: 'driver', page: 'home', id: p.id } : { view: 'driver', page: 'picker', id: null };
    return { view: 'landing' };
  }

  function currentRoute() {
    return parseRoute(window.location.hash);
  }

  window.currentRoute = currentRoute;
  window.navigate = function (hash) {
    if (window.location.hash === hash) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = hash;
    }
  };

  // React hook: re-renders on hashchange.
  window.useRoute = function () {
    const [route, setRoute] = React.useState(currentRoute());
    React.useEffect(() => {
      const on = () => setRoute(currentRoute());
      window.addEventListener('hashchange', on);
      return () => window.removeEventListener('hashchange', on);
    }, []);
    return route;
  };
})();
