import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { employee, csv, fixture, seed } from './helpers';
import { processImport } from '../src/imports/process-import';

test('upload endpoint persists a file, returns progress, and supports safe request retries', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store);
  const response = await request(app)
    .post('/api/employees/imports')
    .set('Idempotency-Key', 'upload-1')
    .attach('file', csv([employee()]), 'employees.csv')
    .expect(202);
  assert.equal(response.body.status, 'pending');
  assert.equal(response.headers.location, response.body.status_url);
  const retry = await request(app)
    .post('/api/employees/imports')
    .set('Idempotency-Key', 'upload-1')
    .attach('file', csv([employee()]), 'employees.csv')
    .expect(200);
  assert.equal(retry.body.id, response.body.id);
  await request(app)
    .post('/api/employees/imports')
    .set('Idempotency-Key', 'upload-1')
    .attach('file', csv([employee(2)]), 'employees.csv')
    .expect(409);
  await processImport(store, response.body.id, 500);
  const status = await request(app).get(response.body.status_url).expect(200);
  assert.equal(status.body.status, 'completed');
  assert.equal(status.body.progress, 100);
  assert.equal(status.body.processed_rows, 1);
});

test('upload endpoint rejects missing, unsupported, multiple, and oversized files', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store, 1024);
  await request(app).post('/api/employees/imports').expect(400);
  await request(app)
    .post('/api/employees/imports')
    .attach('file', Buffer.from('test'), 'file.xlsx')
    .expect(415);
  await request(app)
    .post('/api/employees/imports')
    .attach('file', Buffer.alloc(1025), 'file.csv')
    .expect(413);
  await request(app)
    .post('/api/employees/imports')
    .attach('file', csv([employee()]), 'file.csv')
    .attach('file', csv([employee()]), 'file2.csv')
    .expect(400);
  await request(app).get('/api/employees/imports/missing').expect(404);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM employee_imports').get()!.n,
    0,
  );
});

test('salary PATCH records before/after values and sets server metadata, without authentication', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  const first = await request(app)
    .patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'hr-42')
    .send({ salary: 65000.75, reason: 'Annual review' })
    .expect(200);
  assert.equal(first.body.employee.salary, 65000.75);
  assert.equal(first.body.employee.last_updated_by, 'hr-42');
  assert.ok(
    Date.now() - Date.parse(first.body.employee.last_updated_date) < 5000,
  );
  assert.equal(first.body.changed, true);
  const second = await request(app)
    .patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'hr-43')
    .send({
      salary: 70000,
      currency: 'USD',
      expected_last_updated_date: first.body.employee.last_updated_date,
    })
    .expect(200);
  const history = await request(app)
    .get('/api/employees/EMP-1/salary-history')
    .expect(200);
  assert.equal(history.body.total, 3);
  const [latest, previous, initial] = history.body.changes;
  assert.deepEqual(
    [
      latest.old_salary,
      latest.new_salary,
      latest.old_currency,
      latest.new_currency,
      latest.changed_by,
    ],
    [65000.75, 70000, 'INR', 'USD', 'hr-43'],
  );
  assert.equal(latest.changed_at, second.body.employee.last_updated_date);
  assert.equal(
    latest.previous_updated_at,
    first.body.employee.last_updated_date,
  );
  assert.equal(latest.previous_updated_by, 'hr-42');
  assert.equal(previous.old_salary, employee().salary);
  assert.equal(previous.reason, 'Annual review');
  assert.equal(initial.action, 'import');
  assert.equal(initial.old_salary, null);
  assert.equal(initial.new_salary, employee().salary);
  assert.equal(initial.changed_by, 'upload-hr');
});

test('salary PATCH rejects invalid input and stale writes; no-op retries create no audit entry', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  await request(app)
    .patch('/api/employees/EMP-1/salary')
    .send({ salary: 10 })
    .expect(400);
  for (const input of [
    { salary: -1 },
    { salary: '123' },
    { salary: 1.001 },
    { salary: 1.000001 },
    { salary: 5, currency: 'bad' },
    { salary: 5, last_updated_by: 'forged' },
    { salary: 5, last_updated_date: '2024-01-01' },
  ])
    await request(app)
      .patch('/api/employees/EMP-1/salary')
      .set('X-Updated-By', 'hr-1')
      .send(input)
      .expect(400);
  await request(app)
    .patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'hr-1')
    .send({ salary: 5, expected_last_updated_date: 'outdated' })
    .expect(409);
  const unchanged = await request(app)
    .patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'hr-1')
    .send({ salary: employee().salary })
    .expect(200);
  assert.equal(unchanged.body.changed, false);
  assert.equal(store.salaryHistory('EMP-1', 100, 0).total, 1);
  await request(app)
    .patch('/api/employees/missing/salary')
    .set('X-Updated-By', 'hr-1')
    .send({ salary: 5 })
    .expect(404);
  await request(app)
    .get('/api/employees/EMP-1/salary-history?limit=101')
    .expect(400);
  await request(app).get('/api/employees/missing/salary-history').expect(404);
  await request(app)
    .patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'hr-1')
    .set('Content-Type', 'application/json')
    .send('{invalid')
    .expect(400);
});

test('salary and audit changes are atomic and history is append-only', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const before = store.getEmployee('EMP-1');
  store.db.exec(
    "CREATE TRIGGER simulate_salary_failure BEFORE UPDATE ON employees BEGIN SELECT RAISE(ABORT, 'test write failure'); END",
  );
  assert.throws(() => store.updateSalary('EMP-1', { salary: 70000 }, 'hr-1'));
  assert.deepEqual(store.getEmployee('EMP-1'), before);
  assert.equal(store.salaryHistory('EMP-1', 100, 0).total, 1);
  assert.throws(
    () => store.db.prepare('DELETE FROM salary_changes').run(),
    /append-only/,
  );
  assert.throws(
    () => store.db.prepare('UPDATE salary_changes SET new_salary = 1').run(),
    /append-only/,
  );
});

test('employee listing and filters continue working after salary changes', async (t) => {
  const { store } = fixture(t);
  await seed(store, [
    employee(),
    { ...employee(2), department: 'Finance', salary: 70000 },
  ]);
  const app = createApp(store);
  const response = await request(app)
    .get('/api/employees?department=Finance&sort=salary&order=desc')
    .expect(200);
  assert.equal(response.body.pagination.total, 1);
  assert.equal(response.body.data[0].id, 'EMP-2');
  await request(app).get('/api/employees/filters').expect(200);
});

test('employee search matches name, ID, country and email case-insensitively', async (t) => {
  const { store } = fixture(t);
  await seed(store, [
    { ...employee(), first_name: 'Asha', last_name: 'Singh', country: 'India' },
    { ...employee(2), first_name: 'Mateo', last_name: 'Silva', country: 'Brazil', email: 'mateo@example.com' },
  ]);
  const app = createApp(store);
  for (const term of ['asha singh', 'emp-1', 'INDIA', 'mateo@example.com']) {
    const response = await request(app).get(`/api/employees?search=${encodeURIComponent(term)}`).expect(200);
    assert.equal(response.body.pagination.total, 1);
  }
  await request(app).get(`/api/employees?search=${'x'.repeat(256)}`).expect(400);
});
