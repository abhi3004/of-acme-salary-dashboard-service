import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import {
  COLUMNS,
  parseEmployees,
  ValidationError,
} from '../src/imports/validation';
import { csv, employee } from './helpers';

test('CSV accepts valid rows, BOM, quoted commas and preserves text IDs', () => {
  const row = { ...employee(), id: '00001', first_name: 'Asha, Anne' };
  assert.deepEqual(
    parseEmployees(Buffer.concat([Buffer.from('\uFEFF'), csv([row])]), '.csv'),
    [row],
  );
});

test('accepts exactly 10000 employees and rejects 10001', () => {
  const rows = Array.from({ length: 10000 }, (_, index) => employee(index));
  assert.equal(parseEmployees(csv(rows), '.csv').length, 10000);
  assert.throws(
    () => parseEmployees(csv([...rows, employee(10000)]), '.csv'),
    ValidationError,
  );
});

test('rejects invalid values, impossible dates, duplicate IDs and invalid headers', () => {
  for (const change of [
    { email: 'not-an-email' },
    { salary: -10 },
    { salary: 1.000001 },
    { joining_date: '2025-02-29' },
    { last_updated_date: '2025-01-01T24:00:00Z' },
    { currency: 'ZZZ' },
    { first_name: '' },
    { phone: 'abc' },
    { last_updated_by: 'line\nbreak' },
  ])
    assert.throws(
      () => parseEmployees(csv([{ ...employee(), ...change }]), '.csv'),
      ValidationError,
    );
  assert.throws(
    () => parseEmployees(csv([employee(), employee()]), '.csv'),
    ValidationError,
  );
  assert.throws(
    () =>
      parseEmployees(
        Buffer.from(csv([employee()]).toString().replace('first_name', 'id')),
        '.csv',
      ),
    ValidationError,
  );
  assert.throws(
    () => parseEmployees(Buffer.from('id,first_name\n1,"unclosed'), '.csv'),
    ValidationError,
  );
});

function workbookBuffer(sheet: XLSX.WorkSheet, extraSheet = false): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Employees');
  if (extraSheet)
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['extra']]),
      'Extra',
    );
  return XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' });
}

test('accepts genuine XLS files with Excel dates and text identifiers', () => {
  const values = COLUMNS.map((key) => employee()[key]) as unknown[];
  values[COLUMNS.indexOf('joining_date')] = new Date('2024-02-29T00:00:00Z');
  const parsed = parseEmployees(
    workbookBuffer(XLSX.utils.aoa_to_sheet([[...COLUMNS], values])),
    '.xls',
  );
  assert.equal(parsed[0]!.id, 'EMP-1');
  assert.equal(parsed[0]!.salary, 50000.25);
  assert.match(parsed[0]!.joining_date, /^2024-02-29/);
});

test('rejects disguised, multi-sheet, numeric identifier and oversized XLS files', () => {
  assert.throws(
    () => parseEmployees(csv([employee()]), '.xls'),
    ValidationError,
  );
  const sheet = XLSX.utils.aoa_to_sheet([
    [...COLUMNS],
    COLUMNS.map((key) => employee()[key]),
  ]);
  assert.throws(
    () => parseEmployees(workbookBuffer(sheet, true), '.xls'),
    ValidationError,
  );
  sheet.A2 = { t: 'n', v: 123 };
  assert.throws(
    () => parseEmployees(workbookBuffer(sheet), '.xls'),
    ValidationError,
  );
  sheet.A2 = { t: 's', v: 'EMP-1' };
  sheet.A10002 = { t: 's', v: 'beyond-limit' };
  sheet['!ref'] = 'A1:N10002';
  assert.throws(
    () => parseEmployees(workbookBuffer(sheet), '.xls'),
    ValidationError,
  );
});
