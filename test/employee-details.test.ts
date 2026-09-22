import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { employee, fixture, seed } from './helpers';

const version = employee().last_updated_date;

test('employee details can be loaded by encoded ID without exposing import internals', async (t) => {
  const { store } = fixture(t);
  const record = { ...employee(), id: 'EMP / A#1' };
  await seed(store, [record]);
  const app = createApp(store);
  const response = await request(app).get(`/api/employees/${encodeURIComponent(record.id)}`).expect(200);
  assert.deepEqual(response.body, { employee: record });
  assert.equal(response.headers['cache-control'], 'no-store');
  await request(app).get('/api/employees/missing').expect(404);
  await request(app).get('/api/employees/filters').expect(200);
});

test('updates profile, status and salary together and refreshes summaries, filters and audit history', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  const changes = {
    first_name: '  Priya ', last_name: 'Rao', email: 'priya@example.com', phone: '+1 1234567890',
    department: 'Finance', role: 'Director', salary: 70000.75, currency: 'USD', status: 'on_leave',
    country: 'US', joining_date: '2020-02-29', expected_last_updated_date: version, reason: 'Annual review',
  };
  const response = await request(app).patch('/api/employees/EMP-1')
    .set('X-Updated-By', 'hr@example.com').send(changes).expect(200);
  const updated = response.body.employee;
  assert.equal(response.body.changed, true);
  assert.equal(updated.first_name, 'Priya');
  assert.equal(updated.status, 'on_leave');
  assert.equal(updated.salary, 70000.75);
  assert.equal(updated.last_updated_by, 'hr@example.com');
  assert.notEqual(updated.last_updated_date, version);
  const { reason, expected_last_updated_date, ...fields } = changes;
  assert.deepEqual(updated, {
    ...employee(), ...fields, first_name: 'Priya',
    last_updated_date: updated.last_updated_date, last_updated_by: 'hr@example.com',
  });
  const history = store.salaryHistory('EMP-1', 100, 0);
  assert.equal(history.total, 2);
  assert.equal(history.changes[0]!.id, response.body.audit_id);
  assert.equal(history.changes[0]!.old_salary, employee().salary);
  assert.equal(history.changes[0]!.new_salary, 70000.75);
  assert.equal(history.changes[0]!.reason, 'Annual review');
  assert.equal(history.changes[0]!.previous_updated_at, version);
  const summary = (await request(app).get('/api/dashboard').expect(200)).body;
  assert.deepEqual(summary.statuses, [{ status: 'on_leave', employees: 1 }]);
  assert.deepEqual(summary.salaries, [{ currency: 'USD', employees: 1, total: 70000.75, average: 70000.75 }]);
  const filters = (await request(app).get('/api/employees/filters').expect(200)).body.filters;
  assert.deepEqual(filters.department, ['Finance']);
  assert.deepEqual(filters.status, ['on_leave']);
  const list = (await request(app).get('/api/employees?status=on_leave').expect(200)).body;
  assert.deepEqual(list.data, [updated]);
});

test('status-only edits and no-op requests preserve salary audit records and omitted fields', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  const response = await request(app).patch('/api/employees/EMP-1')
    .set('X-Updated-By', 'hr@example.com')
    .send({ status: 'inactive', expected_last_updated_date: version }).expect(200);
  assert.equal(response.body.audit_id, null);
  assert.equal(response.body.employee.salary, employee().salary);
  assert.equal(response.body.employee.email, employee().email);
  assert.equal(store.salaryHistory('EMP-1', 100, 0).total, 1);
  const unchanged = await request(app).patch('/api/employees/EMP-1')
    .set('X-Updated-By', 'hr@example.com')
    .send({ status: 'inactive', expected_last_updated_date: response.body.employee.last_updated_date }).expect(200);
  assert.equal(unchanged.body.changed, false);
  assert.deepEqual(unchanged.body.employee, response.body.employee);
});

test('rejects stale edits across both profile and legacy salary endpoints', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  const first = await request(app).patch('/api/employees/EMP-1')
    .set('X-Updated-By', 'first-hr').send({ status: 'on_leave', expected_last_updated_date: version }).expect(200);
  await request(app).patch('/api/employees/EMP-1')
    .set('X-Updated-By', 'second-hr').send({ salary: 90000, expected_last_updated_date: version }).expect(409);
  await request(app).patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'second-hr').send({ salary: 90000, expected_last_updated_date: version }).expect(409);
  assert.deepEqual({ ...store.getEmployee('EMP-1') }, first.body.employee);
  const second = await request(app).patch('/api/employees/EMP-1/salary')
    .set('X-Updated-By', 'second-hr').send({ salary: 90000, expected_last_updated_date: first.body.employee.last_updated_date }).expect(200);
  assert.ok(second.body.employee.last_updated_date > first.body.employee.last_updated_date);
  await request(app).patch('/api/employees/EMP-1')
    .set('X-Updated-By', 'first-hr').send({ role: 'Manager', expected_last_updated_date: first.body.employee.last_updated_date }).expect(409);
});

test('validates edits and protects employee ID and update metadata', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  const before = store.getEmployee('EMP-1');
  for (const input of [
    {}, { reason: 'No fields' }, { id: 'NEW-ID' }, { last_updated_date: version }, { last_updated_by: 'forged' },
    { status: '' }, { status: '   ' }, { status: null }, { status: ['active'] }, { status: 'bad\nstatus' },
    { first_name: 42 }, { first_name: 'x'.repeat(256) }, { email: 'invalid' }, { phone: '123' },
    { phone: '+1234567890123456' }, { joining_date: '2025-02-29' }, { salary: -1 }, { salary: '123' },
    { salary: 1.001 }, { salary: Number.MAX_SAFE_INTEGER }, { currency: 'bad' }, { country: '' },
    { salary: 500, reason: 'x'.repeat(501) }, { salary: 500, reason: null },
    { status: 'active', expected_last_updated_date: 'invalid' },
  ]) {
    const response = await request(app).patch('/api/employees/EMP-1').set('X-Updated-By', 'hr@example.com')
      .send({ expected_last_updated_date: version, ...input });
    assert.equal(response.status, 400, `${JSON.stringify(input)}: ${response.text}`);
  }
  await request(app).patch('/api/employees/EMP-1').set('X-Updated-By', 'hr@example.com').send({ status: 'inactive' }).expect(400);
  await request(app).patch('/api/employees/EMP-1').send({ status: 'inactive', expected_last_updated_date: version }).expect(400);
  await request(app).patch('/api/employees/missing').set('X-Updated-By', 'hr@example.com')
    .send({ status: 'inactive', expected_last_updated_date: version }).expect(404);
  assert.deepEqual(store.getEmployee('EMP-1'), before);
  assert.equal(store.salaryHistory('EMP-1', 100, 0).total, 1);
});

test('combined edits roll back together if audit or employee persistence fails', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const before = store.getEmployee('EMP-1');
  store.db.exec("CREATE TRIGGER fail_edit BEFORE UPDATE ON employees BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
  assert.throws(() => store.updateEmployee('EMP-1', { salary: 80000, status: 'inactive', email: 'new@example.com' }, 'hr'));
  assert.deepEqual(store.getEmployee('EMP-1'), before);
  assert.equal(store.salaryHistory('EMP-1', 100, 0).total, 1);
  store.db.exec('DROP TRIGGER fail_edit');
  store.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON salary_changes BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END");
  assert.throws(() => store.updateEmployee('EMP-1', { salary: 80000, status: 'inactive' }, 'hr'));
  assert.deepEqual(store.getEmployee('EMP-1'), before);
});

test('blocks edits while an employee import is incomplete', async (t) => {
  const { store } = fixture(t);
  const importId = await seed(store);
  store.db.prepare("UPDATE employee_imports SET status = 'processing' WHERE id = ?").run(importId);
  await request(createApp(store)).patch('/api/employees/EMP-1').set('X-Updated-By', 'hr@example.com')
    .send({ status: 'inactive', expected_last_updated_date: version }).expect(409);
  assert.equal(store.getEmployee('EMP-1')!.status, 'active');
});
