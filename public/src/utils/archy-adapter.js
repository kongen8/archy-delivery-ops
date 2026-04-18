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

    for (const area of areas) {
      const bakery = bakeryById.get(area.bakery_id);
      if (!bakery) continue;
      const key = area.name.replace(/ \(migrated\)$/, '');
      const matchingRecips = recipients.filter(r => {
        if (r.bakery_id !== bakery.id) return false;
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return false;
        const tag = r.customizations && r.customizations.legacy_region;
        if (tag) return tag === key;
        return pointInGeometry(r.lon, r.lat, area.geometry);
      });
      if (!matchingRecips.length) continue;

      REGIONS[key] = {
        name: key,
        bakery: bakery.name,
        color: colorForArea(area.name),
        _bakeryId: bakery.id,
        _campaignId: ctx.campaign.id,
        _deliveryAreaId: area.id,
      };

      const depots = (depotsByBakery[bakery.id] || []).map(d => ({
        name: d.name, addr: d.address, lat: d.lat, lon: d.lon,
      }));

      const savedRoute = routes.find(r => r.delivery_area_id === area.id);

      if (savedRoute) {
        ROUTE_DATA[key] = savedRoute.data;
      } else {
        const stops = matchingRecips.map(r => {
          if (r.legacy_id) legacyIdToRecipientId[r.legacy_id] = r.id;
          return recipientToStop(r, bakery.name);
        });
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
