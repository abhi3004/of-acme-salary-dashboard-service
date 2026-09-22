import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, IdempotencyConflict } from '../src/database/store';
import { processImport } from '../src/imports/process-import';
import { csv, employee, fixture, seed } from './helpers';

test('durable upload and idempotency keys survive retries without duplicate jobs', (t) => {
  const { store } = fixture(t);
  const first = store.createImport(
    'employees.csv',
    '.csv',
    csv([employee()]),
    'request-1',
  );
  const next = store.createImport(
    'employees.csv',
    '.csv',
    csv([employee()]),
    'request-1',
  );
  assert.equal(next.record.id, first.record.id);
  assert.equal(next.reused, true);
  assert.throws(
    () =>
      store.createImport(
        'employees.csv',
        '.csv',
        csv([employee(2)]),
        'request-1',
      ),
    IdempotencyConflict,
  );
  assert.deepEqual(store.getFile(first.record.id), csv([employee()]));
});

test('reopens the SQLite database and resumes after a committed batch exactly once', async (t) => {
  const { store, filename } = fixture(t);
  const rows = Array.from({ length: 5 }, (_, index) => employee(index));
  const id = store.createImport('employees.csv', '.csv', csv(rows), null).record
    .id;
  await assert.rejects(
    processImport(store, id, 2, async () => {
      throw new Error('simulated interruption');
    }),
  );
  assert.equal(store.getImport(id)!.processed_rows, 2);
  assert.equal(store.getImport(id)!.status, 'retrying');
  const restarted = new Store(filename);
  try {
    await processImport(restarted, id, 2);
    await processImport(restarted, id, 2);
    assert.equal(restarted.getImport(id)!.status, 'completed');
    assert.equal(restarted.getImport(id)!.processed_rows, 5);
    assert.equal(
      restarted.db.prepare('SELECT COUNT(*) AS n FROM employees').get()!.n,
      5,
    );
    assert.equal(
      restarted.db.prepare('SELECT COUNT(*) AS n FROM salary_changes').get()!.n,
      5,
    );
    assert.equal(
      restarted.db.prepare('SELECT COUNT(*) AS n FROM import_rows').get()!.n,
      0,
    );
  } finally {
    restarted.close();
  }
});

test('invalid or duplicate data fails before inserting any employees from that upload', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  for (const rows of [
    [employee(2), employee()],
    [employee(3), { ...employee(4), email: 'invalid' }],
  ]) {
    const id = store.createImport('invalid.csv', '.csv', csv(rows), null).record
      .id;
    await processImport(store, id, 1);
    assert.equal(store.getImport(id)!.status, 'failed');
    assert.equal(store.getImport(id)!.processed_rows, 0);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM employees').get()!.n,
      1,
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM import_rows').get()!.n,
      0,
    );
  }
});

test('batch insertion, initial audit entries and checkpoints roll back together', async (t) => {
  const { store } = fixture(t);
  const id = store.createImport(
    'employees.csv',
    '.csv',
    csv([employee()]),
    null,
  ).record.id;
  store.db.exec(
    "CREATE TRIGGER simulate_audit_failure BEFORE INSERT ON salary_changes BEGIN SELECT RAISE(ABORT, 'test failure'); END",
  );
  await assert.rejects(processImport(store, id, 500));
  assert.equal(store.getImport(id)!.processed_rows, 0);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM employees').get()!.n,
    0,
  );
  store.db.exec('DROP TRIGGER simulate_audit_failure');
  await processImport(store, id, 500);
  assert.equal(store.getImport(id)!.status, 'completed');
});

test('10,000 employees complete in bounded batches with initial salary audit records', async (t) => {
  const { store } = fixture(t);
  const id = store.createImport(
    'employees.csv',
    '.csv',
    csv(Array.from({ length: 10000 }, (_, i) => employee(i))),
    null,
  ).record.id;
  const checkpoints: number[] = [];
  await processImport(store, id, 500, async (count) => {
    checkpoints.push(count);
  });
  assert.equal(checkpoints.length, 20);
  assert.equal(checkpoints[19], 10000);
  assert.equal(store.getImport(id)!.status, 'completed');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM salary_changes').get()!.n,
    10000,
  );
});
