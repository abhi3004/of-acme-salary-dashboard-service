import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { Store } from '../src/database/store';
import type { Employee } from '../src/model/employee';
import { COLUMNS } from '../src/imports/validation';
import { processImport } from '../src/imports/process-import';

export function employee(index = 1): Employee {
  return {
    id: `EMP-${index}`,
    first_name: 'Asha',
    last_name: 'Sharma',
    email: `employee${index}@example.com`,
    phone: '+91 9876543210',
    department: 'Engineering',
    role: 'Engineer',
    salary: 50000.25,
    status: 'active',
    country: 'IN',
    joining_date: '2024-02-29',
    currency: 'INR',
    last_updated_date: '2025-01-01T00:00:00Z',
    last_updated_by: 'original-hr',
  };
}
export function csv(employees: Employee[]): Buffer {
  const quote = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  return Buffer.from(
    [
      COLUMNS.join(','),
      ...employees.map((row) =>
        COLUMNS.map((key) => quote(row[key])).join(','),
      ),
    ].join('\n'),
  );
}
export function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'salary-service-test-'));
  const filename = path.join(directory, 'test.sqlite');
  const store = new Store(filename);
  t.after(() => {
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return { store, filename, directory };
}
export async function seed(store: Store, employees = [employee()]) {
  const record = store.createImport(
    'employees.csv',
    '.csv',
    csv(employees),
    null,
    'upload-hr',
  ).record;
  await processImport(store, record.id, 500);
  return record.id;
}
