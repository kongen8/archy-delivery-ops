(function () {
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const intersect =
        (yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInGeometry(lon, lat, geom) {
    if (!geom) return false;
    if (geom.type === 'Polygon') {
      const [outer, ...holes] = geom.coordinates;
      if (!pointInRing(lon, lat, outer)) return false;
      return !holes.some(h => pointInRing(lon, lat, h));
    }
    if (geom.type === 'MultiPolygon') {
      return geom.coordinates.some(poly => {
        const [outer, ...holes] = poly;
        if (!pointInRing(lon, lat, outer)) return false;
        return !holes.some(h => pointInRing(lon, lat, h));
      });
    }
    return false;
  }

  function recipientToStop(r, bakeryName) {
    return {
      id: r.id,
      co: r.company,
      ci: r.city || '',
      st: r.state || '',
      cn: r.contact_name || '',
      ph: r.phone || '',
      ad: r.address,
      zp: r.zip || '',
      lt: r.lat,
      ln: r.lon,
      bk: bakeryName,
      eta: 0,
      dt: 0,
    };
  }

  function colorForArea(name) {
    const palette = (typeof DRIVER_COLORS !== 'undefined' && DRIVER_COLORS) || ['#2563eb'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  async function buildLegacyShape() {
    const ctx = await DB2.loadArchyContext();
    if (!ctx) return null;

    const [recipients, areasRes, routes, depotsByBakery] = await Promise.all([
      DB2.loadRecipients(ctx.campaign.id),
      sb.from('delivery_areas').select('*'),
      DB2.loadRoutes(ctx.campaign.id),
      DB2.loadAllDepots(),
    ]);
    const areas = areasRes.data || [];

    const bakeryById = new Map(ctx.bakeries.map(b => [b.id, b]));
    const REGIONS = {};
    const ROUTE_DATA = {};
    const legacyIdToRecipientId = {};
    // Build the legacy→uuid map eagerly so it's available for remapping saved routes
    // (which contain stops keyed by the original Archy string id like "SF_220_Dentistry_21").
    for (const r of recipients) {
      if (r.legacy_id) legacyIdToRecipientId[r.legacy_id] = r.id;
    }

    function remapSavedRoute(data) {
      if (!data || !Array.isArray(data.days)) return data;
      const days = data.days.map(dd => ({
        ...dd,
        routes: (dd.routes || []).map(rt => ({
          ...rt,
          stops: (rt.stops || []).map(s => {
            const mapped = legacyIdToRecipientId[s.id];
            return mapped ? { ...s, id: mapped, _legacyId: s.id } : s;
          }),
        })),
      }));
      return { ...data, days };
    }

    for (const area of areas) {
      const bakery = bakeryById.get(area.bakery_id);
      if (!bakery) continue;
      // Plan 2 polygons save with name: null. Fall back to a stable-per-area
      // label so the region shows up in the legacy shape; keep the legacy
      // `(migrated)` suffix-strip for Archy-era named areas.
      const rawName = area.name || (bakery.name + ' · area ' + area.id.slice(0, 6));
      const key = rawName.replace(/ \(migrated\)$/, '');
      const matchingRecips = recipients.filter(r => {
        if (r.bakery_id !== bakery.id) return false;
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return false;
        // Legacy Archy regions migrated with both a named area and a
        // legacy_region tag on each recipient -- trust the tag in that case.
        // Plan 2 admin-drawn areas have name=null, so fall back to polygon
        // containment regardless of any legacy tag the recipient carries.
        const tag = r.customizations && r.customizations.legacy_region;
        if (area.name && tag) return tag === key;
        return pointInGeometry(r.lon, r.lat, area.geometry);
      });
      if (!matchingRecips.length) continue;

      REGIONS[key] = {
        name: key,
        bakery: bakery.name,
        color: colorForArea(rawName),
        _bakeryId: bakery.id,
        _campaignId: ctx.campaign.id,
        _deliveryAreaId: area.id,
      };

      const depots = (depotsByBakery[bakery.id] || []).map(d => ({
        id: d.id, name: d.name, addr: d.address, lat: d.lat, lon: d.lon,
      }));

      const savedRoute = routes.find(r => r.delivery_area_id === area.id);

      if (savedRoute) {
        // Saved route was serialized before multi-tenant depot ids existed; overlay
        // the authoritative depot list (with ids) so DepotManager can edit them.
        ROUTE_DATA[key] = { ...remapSavedRoute(savedRoute.data), depots };
      } else {
        const stops = matchingRecips.map(r => recipientToStop(r, bakery.name));
        ROUTE_DATA[key] = {
          ts: stops.length,
          ndays: 1,
          nd: 1,
          depots,
          days: [{
            day: 1,
            nd: 1,
            routes: [{
              drv: 0,
              ns: stops.length,
              tt: 0,
              td: 0,
              depot: depots[0]?.name || '',
              stops,
            }],
            depots_active: depots.map(d => d.name),
          }],
          _bakeryId: bakery.id,
          _campaignId: ctx.campaign.id,
          _deliveryAreaId: area.id,
        };
      }
    }

    return { REGIONS, ROUTE_DATA, legacyIdToRecipientId, context: ctx };
  }

  window.ArchyAdapter = { buildLegacyShape };
})();
