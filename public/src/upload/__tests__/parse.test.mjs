import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(path.resolve(__dirname, '../parse.js'), 'utf8');
const ctx = {};
new Function('XLSX', 'ctx', src + '\nctx.parseFile = parseFile;')(XLSX, ctx);
const { parseFile } = ctx;

const csv = 'Company,Address\n"Acme Co","123 Main St"\nWidgets,"45 Oak Ave"\n';
const csvBuffer = new TextEncoder().encode(csv).buffer;

test('parses a clean CSV into headers + rows', () => {
  const out = parseFile(csvBuffer, 'csv');
  assert.deepEqual(out.headers, ['Company', 'Address']);
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows[0], ['Acme Co', '123 Main St']);
});

test('strips a UTF-8 BOM from the first header', () => {
  const withBom = '\uFEFFCompany,Address\nAcme,1 Main St\n';
  const out = parseFile(new TextEncoder().encode(withBom).buffer, 'csv');
  assert.equal(out.headers[0], 'Company');
});

test('drops fully empty trailing rows', () => {
  const messy = 'A,B\n1,2\n,\n,\n';
  const out = parseFile(new TextEncoder().encode(messy).buffer, 'csv');
  assert.equal(out.rows.length, 1);
});

test('rejects when row count exceeds the cap', () => {
  let body = 'Company,Address\n';
  for (let i = 0; i < 5001; i++) body += `Co${i},${i} Main St\n`;
  assert.throws(
    () => parseFile(new TextEncoder().encode(body).buffer, 'csv'),
    /5000 row limit/
  );
});
