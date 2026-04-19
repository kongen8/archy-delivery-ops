// ===== DESIGN MERGE =====
// Plan 5 — combine a campaign's default_design with a recipient's
// customizations to get the effective design for one cake.
//
// Inputs are jsonb-shaped: { cake_image_url?, card_image_url? }.
// Recipient values win except when null/""/missing — then we fall back to
// the campaign default. Extra keys on either side (e.g. Plan 3's `skipped`
// flag in customizations) are ignored — this helper only returns the
// design-relevant fields.
function mergeDesign(campaignDefault, recipientOverride) {
  const d = campaignDefault || {};
  const r = recipientOverride || {};
  return {
    cake_image_url: pick(r.cake_image_url, d.cake_image_url),
    card_image_url: pick(r.card_image_url, d.card_image_url),
  };
}

function pick(over, fallback) {
  if (over === null || over === undefined || over === '') {
    if (fallback === undefined || fallback === '' || fallback === null) return null;
    return fallback;
  }
  return over;
}

if (typeof window !== 'undefined') window.mergeDesign = mergeDesign;
