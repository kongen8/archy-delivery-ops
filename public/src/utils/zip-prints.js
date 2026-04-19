// ===== ZIP EDIBLE PRINTS (Plan 5 Task 10) =====
// Bakery-side helper. Takes an array of {recipient, design, campaign} rows
// (only those with a resolved cake_image_url), fetches each PNG, zips them
// with safe filenames, and triggers a browser download.
//
// Naming: <ordinal>_<safe-company>_<recipient_id_short>.png — ordinal lets
// the bakery sort by delivery order in their printer's queue UI.
async function zipEdiblePrints(rows) {
  if (!window.JSZip) throw new Error('JSZip not loaded — check public/index.html');
  const zip = new window.JSZip();
  let added = 0;
  await Promise.all(rows.map(async (x, i) => {
    const url = x.design && x.design.cake_image_url;
    if (!url) return;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const safe = (x.recipient.company || 'unknown').replace(/[^a-z0-9]/gi, '_').slice(0, 32);
      const ord = String(i + 1).padStart(3, '0');
      zip.file(`${ord}_${safe}_${x.recipient.id.slice(0, 8)}.png`, blob);
      added++;
    } catch (e) {
      console.warn('zip-prints: skipped', x.recipient.id, e.message);
    }
  }));
  if (added === 0) throw new Error('No images could be fetched.');
  const out = await zip.generateAsync({ type: 'blob' });
  const campName = (rows[0] && rows[0].campaign && rows[0].campaign.name) || 'campaign';
  const safeCamp = campName.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  triggerBrowserDownload(out, `${safeCamp}_edible_prints.zip`);
  return added;
}

function triggerBrowserDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
}

if (typeof window !== 'undefined') window.zipEdiblePrints = zipEdiblePrints;
