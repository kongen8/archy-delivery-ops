// ===== UPLOAD: FILE PARSE HELPER =====
// Browser-side wrapper around SheetJS that returns a normalized
// { headers, rows } shape. Mirrors what the edge function's parse.ts does
// so the wizard can preview the same content the function will ingest.
// `XLSX` is the global from the browser bundle; in node tests it's injected.

const ROW_CAP = 5000;

function parseFile(arrayBuffer, fileType) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = (matrix[0] || []).map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const rows = matrix.slice(1)
    .map(row => row.map(cell => (cell == null ? '' : String(cell))))
    .filter(row => row.some(cell => cell.trim() !== ''));

  if (rows.length > ROW_CAP) {
    throw new Error('File exceeds 5000 row limit (' + rows.length + ' rows). Split into smaller files.');
  }
  return { headers, rows };
}

if (typeof window !== 'undefined') window.parseFile = parseFile;
