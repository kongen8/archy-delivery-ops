import * as XLSX from 'xlsx';

export interface ParsedFile {
  headers: string[];
  rows: string[][];
}

export function parseFile(b64: string, fileType: 'csv' | 'xlsx'): ParsedFile {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const wb = XLSX.read(bin, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' });
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = (matrix[0] || []).map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const rows = matrix.slice(1)
    .map(row => row.map(cell => (cell == null ? '' : String(cell))))
    .filter(row => row.some(cell => cell.trim() !== ''));
  if (rows.length > 5000) throw new Error('File exceeds 5000 row limit');
  return { headers, rows };
}
