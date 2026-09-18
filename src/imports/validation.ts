import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import type { Employee } from '../model/employee';

export const MAX_ROWS = 10_000;
export const COLUMNS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'department', 'role',
  'salary', 'status', 'country', 'joining_date', 'currency',
  'last_updated_date', 'last_updated_by',
] as const satisfies readonly (keyof Employee)[];

export interface RowError { row: number; field: string; message: string }
export class ValidationError extends Error {
  constructor(public readonly errors: RowError[]) {
    super('The file contains invalid employee data.');
    this.name = 'ValidationError';
  }
}
const invalid = (message: string, row = 1, field = 'file'): never => {
  throw new ValidationError([{ row, field, message }]);
};

function readRows(buffer: Buffer, extension: string): unknown[][] {
  if (extension === '.csv') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return invalid('CSV must use UTF-8 encoding.'); }
    try {
      return parse(text, {
        bom: true, trim: true, skip_empty_lines: true, max_record_size: 16_384,
        to: MAX_ROWS + 2,
      }) as unknown[][];
    } catch {
      return invalid('Malformed CSV: check quoting, column counts, and record size (16 KiB maximum).');
    }
  }
  if (extension !== '.xls') return invalid('Only .csv and .xls files are supported.');
  const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
  const isBiff = buffer.length > 4 && [0x0009, 0x0209, 0x0409, 0x0809].includes(buffer.readUInt16LE(0));
  if (!buffer.subarray(0, 8).equals(oleSignature) && !isBiff) {
    return invalid('The file is not an XLS workbook. Renaming another file to .xls is not supported.');
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer', cellDates: true, cellFormula: true, cellHTML: false,
      sheetRows: MAX_ROWS + 2, sheets: 0,
    });
  } catch { return invalid('The XLS workbook is corrupt, encrypted, or unsupported.'); }
  if (workbook.SheetNames.length !== 1) return invalid('Use a workbook with exactly one worksheet.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  const reference = sheet?.['!fullref'] || sheet?.['!ref'];
  if (!sheet || !reference) return invalid('The workbook is empty.');
  const range = XLSX.utils.decode_range(reference);
  if (range.e.r > MAX_ROWS) return invalid(`A file can contain at most ${MAX_ROWS} employee rows plus one header row.`);
  if (range.e.c >= COLUMNS.length) return invalid(`Exactly ${COLUMNS.length} columns are required.`);
  const rows: unknown[][] = [];
  for (let row = 0; row <= range.e.r; row++) {
    const values: unknown[] = [];
    for (let col = 0; col < COLUMNS.length; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      if (cell?.f || cell?.t === 'e') return invalid('Formula and error cells are not accepted; provide literal values.', row + 1, COLUMNS[col]);
      values.push(cell?.v ?? '');
    }
    rows.push(values);
  }
  return rows;
}

function validDate(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return false;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1] && Number.isFinite(Date.parse(value));
}

export function parseEmployees(buffer: Buffer, extension: string): Employee[] {
  const rows = readRows(buffer, extension);
  if (rows.length < 2) return invalid('Include a header and at least one employee row.');
  if (rows.length - 1 > MAX_ROWS) return invalid(`A file can contain at most ${MAX_ROWS} employee rows.`);
  const header = rows[0]!.map((value) => String(value).trim());
  if (header.length !== COLUMNS.length || new Set(header).size !== COLUMNS.length || COLUMNS.some((name) => !header.includes(name))) {
    return invalid(`Headers must contain each Employee field exactly once: ${COLUMNS.join(', ')}.`, 1, 'headers');
  }
  const currencies = new Set(Intl.supportedValuesOf('currency'));
  const errors: RowError[] = [];
  const employees: Employee[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < rows.length; index++) {
    const source = rows[index]!;
    const employee = {} as Employee;
    const report = (field: string, message: string) => {
      if (errors.length < 50) errors.push({ row: index + 1, field, message });
    };
    for (const field of COLUMNS) {
      const raw = source[header.indexOf(field)];
      if (field === 'salary') {
        const salary = typeof raw === 'number' ? raw : typeof raw === 'string' && /^(?:\d+)(?:\.\d{1,2})?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
        if (!Number.isFinite(salary) || salary < 0 || salary > Number.MAX_SAFE_INTEGER / 100 || Math.abs(salary * 100 - Math.round(salary * 100)) > 0.001) {
          report(field, 'Use a non-negative salary with at most two decimal places, without currency symbols or separators.');
        }
        employee.salary = salary;
        continue;
      }
      let value: string;
      if ((field === 'joining_date' || field === 'last_updated_date') && raw instanceof Date && Number.isFinite(raw.getTime())) {
        value = raw.toISOString();
      } else if (typeof raw === 'string') value = raw.trim();
      else { report(field, 'A text value is required. Format IDs and phone numbers as text in Excel.'); value = ''; }
      if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) report(field, 'A non-empty text value of at most 255 characters without control characters is required.');
      employee[field] = value;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) report('email', 'Use a valid email address.');
    const digits = employee.phone.replace(/\D/g, '');
    if (!/^\+?[\d ()-]+$/.test(employee.phone) || digits.length < 7 || digits.length > 15) report('phone', 'Use 7–15 digits with an optional leading +, spaces, parentheses, or hyphens.');
    for (const field of ['joining_date', 'last_updated_date'] as const) {
      if (!validDate(employee[field])) report(field, 'Use a real YYYY-MM-DD date or ISO 8601 timestamp with timezone.');
    }
    if (!currencies.has(employee.currency)) report('currency', 'Use an uppercase ISO 4217 currency code, such as INR or USD.');
    if (seen.has(employee.id)) report('id', 'Employee IDs must be unique within the file.');
    seen.add(employee.id);
    employees.push(employee);
  }
  if (errors.length) throw new ValidationError(errors);
  return employees;
}
