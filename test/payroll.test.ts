import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { employee, fixture, seed } from './helpers';

test('payroll snapshots salary and tracks adjustments, partial payments and outstanding balances', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const period = store.createPayrollPeriod({ name: 'August 2026', start_date: '2026-08-01', end_date: '2026-08-31', payment_due_date: '2026-08-31' });
  const generated = store.generatePayrollPeriod(period.id);
  assert.equal(generated.employees, 1);
  const payroll = generated.payroll[0]!;
  assert.equal(payroll.salary_snapshot, employee().salary);
  store.addPayrollAdjustment(payroll.id, { type: 'bonus', amount: 1000, description: 'Performance bonus' }, 'cfo@example.com');
  store.addPayrollAdjustment(payroll.id, { type: 'tax', amount: 250, description: 'Payroll tax' }, 'cfo@example.com');
  store.approvePayrollPeriod(period.id, 'cfo@example.com');
  store.updateEmployee('EMP-1', { salary: 80000, expected_last_updated_date: employee().last_updated_date }, 'approved-change');
  const payment = store.recordSalaryPayment(payroll.id, { amount: 20000, currency: 'INR', payment_date: '2026-08-31',
    payment_method: 'bank_transfer', transaction_reference: 'PAY-0001', status: 'successful' }, 'payroll@example.com');
  assert.equal((payment.payroll as { amount_paid: number }).amount_paid, 20000);
  assert.equal((payment.payroll as { outstanding_amount: number }).outstanding_amount, 30750.25);
  const summary = store.employeePayrollSummary('EMP-1');
  assert.deepEqual(summary.outstanding.by_currency, [{ currency: 'INR', amount: 30750.25 }]);
  assert.equal(summary.previous[0]!.salary_snapshot, 50000.25);
  assert.equal(store.getEmployee('EMP-1')!.salary, 80000);
});

test('payroll APIs create, generate and approve a monthly period', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  const created = await request(app).post('/api/payroll-periods').set('X-Updated-By', 'payroll@example.com').send({
    name: 'October 2026', start_date: '2026-10-01', end_date: '2026-10-31', payment_due_date: '2026-10-31',
  }).expect(201);
  const id = created.body.period.id;
  const generated = await request(app).post(`/api/payroll-periods/${id}/generate`).set('X-Updated-By', 'payroll@example.com').expect(200);
  assert.equal(generated.body.payroll.length, 1);
  await request(app).post(`/api/payroll-periods/${id}/approve`).set('X-Updated-By', 'cfo@example.com').expect(200);
  const summary = await request(app).get('/api/employees/EMP-1/payroll').expect(200);
  assert.equal(summary.body.upcoming.period_name, 'October 2026');
  assert.equal(summary.body.upcoming.salary_snapshot, employee().salary);
});

test('payroll rejects payments before approval and overpayments', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const period = store.createPayrollPeriod({ name: 'September 2026', start_date: '2026-09-01', end_date: '2026-09-30', payment_due_date: '2026-09-30' });
  const payroll = store.generatePayrollPeriod(period.id).payroll[0]!;
  const input = { amount: 60000, currency: 'INR', payment_date: '2026-09-30', payment_method: 'bank_transfer',
    transaction_reference: 'PAY-OVER', status: 'successful' as const };
  assert.throws(() => store.recordSalaryPayment(payroll.id, input, 'payroll'), /approved/);
  store.approvePayrollPeriod(period.id, 'cfo');
  assert.throws(() => store.recordSalaryPayment(payroll.id, input, 'payroll'), /exceeds/);
});
