import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { Store } from '../src/database/store';
import { processImport } from '../src/imports/process-import';
import { csv, employee, fixture, seed } from './helpers';

const options = { enabled: true, adminEmail: 'admin@acme.test', adminPassword: 'Assessment123!', secureCookies: false };
const failAudit = `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit storage failure'); END`;

test('import activity survives restart and reports 30 employees exactly once after retry', async (t) => {
  const { store, filename } = fixture(t);
  const rows = Array.from({ length: 30 }, (_, i) => employee(i));
  const data = csv(rows);
  const id = store.createImport('team.csv', '.csv', data, 'once', 'hr@admin.co').record.id;
  store.prepareRows(id, rows);
  store.insertBatch(id, 10);
  const restarted = new Store(filename);
  try {
    await processImport(restarted, id, 10);
    await processImport(restarted, id, 10);
    restarted.createImport('team.csv', '.csv', data, 'once', 'different@admin.co');
    const events = restarted.audit.list(1, 100).events;
    assert.equal(events.filter((event) => event.action === 'import.submitted').length, 1);
    assert.equal(events.filter((event) => event.action === 'import.progress').length, 2);
    const completed = events.filter((event) => event.action === 'import.completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.summary, 'Added 30 employee records from team.csv');
    assert.equal(completed[0]!.actor, 'hr@admin.co');
    assert.equal(completed[0]!.metadata.processed_rows, 30);
  } finally { restarted.close(); }
});

test('failed validation records an outcome but no completed import', async (t) => {
  const { store } = fixture(t);
  const record = store.createImport('invalid.csv', '.csv', csv([{ ...employee(), email: 'invalid' }]), null, 'hr@admin.co').record;
  await processImport(store, record.id, 10);
  await processImport(store, record.id, 10);
  assert.deepEqual(store.audit.list(1, 10).events.map((event) => event.action), ['import.failed', 'import.submitted']);
  assert.equal(store.getEmployee('EMP-1'), undefined);
});

test('employee edits capture exact before/after values; no-ops, conflicts and audit failures do not create changes', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  store.updateEmployee('EMP-1', { salary: 65000, department: 'Finance', reason: 'Annual review' }, 'hr@admin.co');
  const event = store.audit.list(1, 10, 'salaries').events[0]!;
  assert.equal(event.actor, 'hr@admin.co');
  assert.equal(event.resource_id, 'EMP-1');
  assert.deepEqual(event.metadata.changes, [
    { field: 'department', before: 'Engineering', after: 'Finance' },
    { field: 'salary', before: 50000.25, after: 65000 },
  ]);
  const before = store.getEmployee('EMP-1')!;
  const count = store.audit.list(1, 100).pagination.total;
  store.updateEmployee('EMP-1', { salary: 65000 }, 'hr@admin.co');
  assert.throws(() => store.updateEmployee('EMP-1', { salary: 70000, expected_last_updated_date: 'old' }, 'hr'), /Refresh/);
  store.db.exec(failAudit);
  assert.throws(() => store.updateEmployee('EMP-1', { salary: 70000 }, 'hr'), /audit storage failure/);
  assert.deepEqual(store.getEmployee('EMP-1'), before);
  assert.equal(store.salaryHistory('EMP-1', 100, 0).total, 2);
  assert.equal(store.audit.list(1, 100).pagination.total, count);
  store.db.exec('DROP TRIGGER fail_audit');
  store.updateEmployee('EMP-1', { status: 'inactive' }, 'hr@admin.co');
  assert.equal(store.audit.list(1, 10).events[0]!.action, 'employee.updated');
});

test('audit failure rolls back employee import rows and checkpoints; audit rows cannot be altered', (t) => {
  const { store } = fixture(t);
  const record = store.createImport('team.csv', '.csv', csv([employee()]), null).record;
  store.prepareRows(record.id, [employee()]);
  store.db.exec(failAudit);
  assert.throws(() => store.insertBatch(record.id, 10), /audit storage failure/);
  assert.equal(store.getEmployee('EMP-1'), undefined);
  assert.equal(store.getImport(record.id)!.processed_rows, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM salary_changes').get()!.count, 0);
  store.db.exec('DROP TRIGGER fail_audit');
  store.insertBatch(record.id, 10);
  assert.throws(() => store.db.exec("UPDATE audit_events SET actor = 'forged'"), /append-only/);
  assert.throws(() => store.db.exec('DELETE FROM audit_events'), /append-only/);
});

test('payroll audit covers creation, generation, adjustment, approval, payment and completion', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const input = { name: 'September 2026', start_date: '2026-09-01', end_date: '2026-09-30', payment_due_date: '2026-09-30' };
  store.db.exec(failAudit);
  assert.throws(() => store.createPayrollPeriod(input, 'payroll@acme.test'), /audit storage failure/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM payroll_periods').get()!.count, 0);
  store.db.exec('DROP TRIGGER fail_audit');
  const period = store.createPayrollPeriod(input, 'payroll@acme.test');
  const payroll = store.generatePayrollPeriod(period.id, 'payroll@acme.test').payroll[0]!;
  store.generatePayrollPeriod(period.id, 'payroll@acme.test'); // no new entries
  store.addPayrollAdjustment(payroll.id, { type: 'bonus', amount: 100, description: 'Award' }, 'payroll@acme.test');
  store.approvePayrollPeriod(period.id, 'payroll@acme.test');
  const payment = { amount: employee().salary + 100, currency: 'INR', payment_date: '2026-09-30',
    payment_method: 'bank', transaction_reference: 'PAY-1', status: 'successful' as const };
  store.db.exec(failAudit);
  assert.throws(() => store.recordSalaryPayment(payroll.id, payment, 'payroll@acme.test'), /audit storage failure/);
  assert.equal(store.getPayrollPeriod(period.id)!.status, 'approved');
  assert.equal(store.payrollPeriodEntries(period.id)[0]!.amount_paid, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM salary_payments').get()!.count, 0);
  store.db.exec('DROP TRIGGER fail_audit');
  store.recordSalaryPayment(payroll.id, payment, 'payroll@acme.test');
  const events = store.audit.list(1, 100, 'payroll').events;
  assert.deepEqual(events.map((event) => event.action), [
    'payroll.status_changed', 'payment.recorded', 'payroll.approved', 'payroll.adjusted', 'payroll.generated', 'payroll.created',
  ]);
  assert.ok(events.every((event) => event.actor === 'payroll@acme.test'));
});

test('audit API enforces access and uses authenticated identity without leaking invitation credentials', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store, undefined, options);
  await request(app).get('/api/audit-events').expect(401);
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ email: options.adminEmail, password: options.adminPassword }).expect(200);
  const invited = await admin.post('/api/users/invitations').set('X-Updated-By', 'forged@acme.test').send({
    name: 'Viewer', email: 'viewer@acme.test', permissions: ['employee.read'],
  }).expect(201);
  const token = invited.body.invitation.token;
  await request(app).post(`/api/auth/invitations/${token}/accept`).send({ password: 'ViewerPass123!' }).expect(204);
  const viewer = request.agent(app);
  await viewer.post('/api/auth/login').send({ email: 'viewer@acme.test', password: 'ViewerPass123!' }).expect(200);
  await viewer.get('/api/audit-events').expect(403);
  const upload = await admin.post('/api/employees/imports').set('X-Updated-By', 'forged@acme.test')
    .attach('file', csv([employee()]), 'team.csv').expect(202);
  await processImport(store, upload.body.id, 10);
  const response = await admin.get('/api/audit-events').expect(200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.events[0].actor, options.adminEmail);
  assert.equal(response.body.events.find((event: { action: string }) => event.action === 'user.invited').actor, options.adminEmail);
  const serialized = JSON.stringify(response.body);
  for (const secret of [token, 'ViewerPass123!', options.adminPassword, 'password_hash', 'token_hash', 'proof_pdf'])
    assert.ok(!serialized.includes(secret), `Audit must not contain ${secret}`);
});

test('invitation and activation roll back with audit failures; simultaneous acceptance logs only once', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store, undefined, options);
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ email: options.adminEmail, password: options.adminPassword }).expect(200);
  const input = { name: 'Viewer', email: 'viewer@acme.test', permissions: ['employee.read'] };
  store.db.exec(failAudit);
  await admin.post('/api/users/invitations').send(input).expect(503);
  assert.equal(store.db.prepare('SELECT id FROM users WHERE email = ?').get(input.email), undefined);
  store.db.exec('DROP TRIGGER fail_audit');
  const invite = await admin.post('/api/users/invitations').send(input).expect(201);
  const url = `/api/auth/invitations/${invite.body.invitation.token}/accept`;
  store.db.exec(failAudit);
  await request(app).post(url).send({ password: 'ViewerPass123!' }).expect(503);
  assert.equal(store.db.prepare('SELECT status FROM users WHERE email = ?').get(input.email)!.status, 'invited');
  store.db.exec('DROP TRIGGER fail_audit');
  const responses = await Promise.all([
    request(app).post(url).send({ password: 'ViewerPass123!' }),
    request(app).post(url).send({ password: 'ViewerPass123!' }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [204, 400]);
  assert.equal(store.audit.list(1, 100).events.filter((event) => event.action === 'user.activated').length, 1);
});

test('audit API provides stable newest-first ordering, category filters, validated pagination and empty results', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store);
  await request(app).get('/api/audit-events').expect(200).expect(({ body }) => assert.deepEqual(body.events, []));
  await seed(store);
  store.updateEmployee('EMP-1', { salary: 65000 }, 'hr@admin.co');
  const first = await request(app).get('/api/audit-events?limit=2').expect(200);
  const next = await request(app).get('/api/audit-events?limit=2&page=2').expect(200);
  assert.equal(first.body.events[0].action, 'salary.changed');
  assert.equal(first.body.pagination.total, 3);
  assert.equal(next.body.events.length, 1);
  assert.ok(first.body.events.at(-1).id > next.body.events[0].id);
  const filtered = await request(app).get('/api/audit-events?category=salaries').expect(200);
  assert.equal(filtered.body.pagination.total, 1);
  await request(app).get('/api/audit-events?category=users').expect(200).expect(({ body }) => assert.deepEqual(body.events, []));
  for (const query of ['page=0', 'page=1.5', 'page=1&page=2', 'limit=101', 'category=unknown', 'limit=x', 'extra=1'])
    await request(app).get(`/api/audit-events?${query}`).expect(400);
});
