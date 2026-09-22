import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { employee, fixture, seed } from './helpers';

test('dashboard aggregates all employees and keeps currencies separate', async (t) => {
  const { store } = fixture(t);
  await seed(store, [
    ...Array.from({ length: 30 }, (_, i) => ({ ...employee(i + 1), salary: 1000.25 })),
    { ...employee(31), salary: 2500, currency: 'USD', country: 'US', department: 'Sales', status: 'on_leave' },
    { ...employee(32), salary: 0, currency: 'USD', country: 'US', department: 'Sales', status: 'inactive' },
  ]);
  const app = createApp(store);
  const response = await request(app).get('/api/dashboard').expect(200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.employees, 32);
  assert.equal(response.body.departments, 2);
  assert.equal(response.body.countries, 2);
  assert.deepEqual(response.body.salaries, [
    { currency: 'INR', employees: 30, total: 30007.5, average: 1000.25 },
    { currency: 'USD', employees: 2, total: 2500, average: 1250 },
  ]);
  assert.deepEqual(response.body.salary_by_department, [
    { department: 'Engineering', currency: 'INR', employees: 30, total: 30007.5 },
    { department: 'Sales', currency: 'USD', employees: 2, total: 2500 },
  ]);
  assert.deepEqual(response.body.statuses, [
    { status: 'active', employees: 30 },
    { status: 'inactive', employees: 1 },
    { status: 'on_leave', employees: 1 },
  ]);
  await request(app).get('/api/employees?department=Sales&limit=1').expect(200);
  assert.deepEqual((await request(app).get('/api/dashboard').expect(200)).body, response.body);
});

test('dashboard reflects salary changes and new currencies without stale totals', async (t) => {
  const { store } = fixture(t);
  await seed(store, [{ ...employee(), salary: 1000 }]);
  const app = createApp(store);
  store.updateSalary('EMP-1', { salary: 2000, currency: 'USD' }, 'dashboard-test');
  const { body } = await request(app).get('/api/dashboard').expect(200);
  assert.deepEqual(body.salaries, [{ currency: 'USD', employees: 1, total: 2000, average: 2000 }]);
  assert.deepEqual(body.salary_by_department, [{ department: 'Engineering', currency: 'USD', employees: 1, total: 2000 }]);
});

test('dashboard provides a useful empty state with no salary groups', async (t) => {
  const { store } = fixture(t);
  const { body } = await request(createApp(store)).get('/api/dashboard').expect(200);
  assert.equal(body.employees, 0);
  assert.deepEqual(body.organization, { employees: 0, departments: 0, countries: 0 });
  assert.deepEqual(body.salaries, []);
  assert.deepEqual(body.statuses, []);
  assert.deepEqual(body.country_options, []);
  assert.equal(body.compensation.currency, 'USD');
  assert.equal(body.compensation.total, 0);
  assert.equal(body.compensation.average, null);
  assert.deepEqual(body.compensation.departments, []);
});

test('Global converts all currencies to USD and uses a weighted average across all employees', async (t) => {
  const { store } = fixture(t);
  await seed(store, [
    { ...employee(1), country: 'India', salary: 10987.55 },
    { ...employee(2), country: 'India', salary: 114.6, currency: 'USD', status: 'inactive', department: 'Sales' },
    { ...employee(3), country: 'United States', salary: 229.2, currency: 'USD' },
    { ...employee(4), country: 'Japan', salary: 18094, currency: 'JPY', status: 'on_leave', department: 'Support' },
  ]);
  const app = createApp(store);
  const { body } = await request(app).get('/api/dashboard').expect(200);
  assert.equal(body.country, null);
  assert.equal(body.employees, 4);
  assert.equal(body.departments, 3);
  assert.deepEqual(body.country_options, ['India', 'Japan', 'United States']);
  assert.equal(body.compensation.currency, 'USD');
  assert.equal(body.compensation.total, 573);
  assert.equal(body.compensation.average, 143.25);
  assert.equal(body.compensation.approximate, true);
  assert.equal(body.compensation.exchange_rates.date, '2026-09-18');
  assert.deepEqual(body.compensation.departments, [
    { department: 'Engineering', employees: 2, total: 343.8 },
    { department: 'Sales', employees: 1, total: 114.6 },
    { department: 'Support', employees: 1, total: 114.6 },
  ]);
  const india = (await request(app).get('/api/dashboard?country=India').expect(200)).body;
  assert.equal(india.country, 'India');
  assert.equal(india.employees, 2);
  assert.equal(india.organization.employees, 4);
  assert.equal(india.departments, 2);
  assert.equal(india.compensation.currency, 'INR');
  assert.equal(india.compensation.total, 21975.1);
  assert.equal(india.compensation.average, 10987.55);
  assert.equal(india.compensation.approximate, true);
  assert.deepEqual(india.statuses, [{ status: 'active', employees: 1 }, { status: 'inactive', employees: 1 }]);
  const japan = (await request(app).get('/api/dashboard?country=Japan').expect(200)).body;
  assert.equal(japan.compensation.currency, 'JPY');
  assert.equal(japan.compensation.total, 18094);
  assert.equal(japan.compensation.average, 18094);
  assert.equal(japan.compensation.approximate, false);
  assert.equal(japan.employees, 1);
  assert.deepEqual(japan.statuses, [{ status: 'on_leave', employees: 1 }]);
  assert.equal(store.getEmployee('EMP-2')!.salary, 114.6); // Reporting never mutates salary records.
  assert.equal(store.getEmployee('EMP-2')!.currency, 'USD');
});

test('missing FX rates never produce partial totals, while native currency reporting still works', async (t) => {
  const { store } = fixture(t);
  await seed(store, [
    { ...employee(1), salary: 1000, currency: 'USD', country: 'US' },
    { ...employee(2), salary: 2000, currency: 'AED', country: 'UAE' },
  ]);
  const app = createApp(store);
  const global = (await request(app).get('/api/dashboard').expect(200)).body;
  assert.equal(global.employees, 2);
  assert.equal(global.compensation.total, null);
  assert.equal(global.compensation.average, null);
  assert.deepEqual(global.compensation.unavailable_currencies, ['AED']);
  assert.deepEqual(global.compensation.departments, []);
  const local = (await request(app).get('/api/dashboard?country=UAE').expect(200)).body;
  assert.equal(local.compensation.currency, 'AED');
  assert.equal(local.compensation.total, 2000);
  assert.equal(local.compensation.approximate, false);
});

test('dashboard validates country parameters and handles countries with no employees', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  for (const query of ['country=', 'country=India&country=Japan', 'country[x]=India', 'currency=INR', `country=${'x'.repeat(256)}`])
    await request(app).get(`/api/dashboard?${query}`).expect(400);
  const { body } = await request(app).get('/api/dashboard?country=Japan').expect(200);
  assert.equal(body.employees, 0);
  assert.equal(body.organization.employees, 1);
  assert.equal(body.compensation.average, null);
  assert.deepEqual(body.statuses, []);
});
