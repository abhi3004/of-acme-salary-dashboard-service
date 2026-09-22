import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/database/store';
import { processImport } from '../src/imports/process-import';
import { csv, employee } from './helpers';

test('upgrades the original import schema without losing an accepted upload', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'salary-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'old.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE employee_imports (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, extension TEXT NOT NULL,
    file BLOB, sha256 TEXT NOT NULL, idempotency_key TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', total_rows INTEGER,
    processed_rows INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    error_json TEXT, next_retry_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  old
    .prepare(
      `INSERT INTO employee_imports (id, filename, extension, file, sha256, created_at, updated_at)
    VALUES ('old-upload', 'employees.csv', '.csv', ?, 'old-hash', '2026-01-01', '2026-01-01')`,
    )
    .run(csv([employee()]));
  old.close();
  const store = new Store(filename);
  try {
    assert.equal(store.getImport('old-upload')!.requested_by, '');
    await processImport(store, 'old-upload', 500);
    assert.equal(store.getImport('old-upload')!.status, 'completed');
    assert.equal(
      store.salaryHistory('EMP-1', 50, 0).changes[0]!.changed_by,
      'original-hr',
    );
    store.updateSalary('EMP-1', { salary: 65000 }, 'hr-1');
  } finally {
    store.close();
  }
  const reopened = new Store(filename);
  try {
    assert.equal(reopened.getEmployee('EMP-1')!.salary, 65000);
    assert.equal(reopened.salaryHistory('EMP-1', 50, 0).total, 2);
  } finally {
    reopened.close();
  }
});
