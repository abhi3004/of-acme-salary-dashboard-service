#!/usr/bin/env node
'use strict';

// Generates a CSV of valid mock employees, or seeds payroll history for employees already in SQLite.
// Usage: node scripts/generate-mock-data.cjs <rows> [output.csv]
//        node scripts/generate-mock-data.cjs --payroll-db [database.sqlite] [past-months]

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_ROWS = 10_000;
const COLUMNS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'department', 'role',
  'salary', 'status', 'country', 'joining_date', 'currency',
  'last_updated_date', 'last_updated_by',
];

const FIRST_NAMES = ['Aarav', 'Priya', 'Rohan', 'Ananya', 'Vikram', 'Neha', 'Arjun', 'Kavya', 'Rahul', 'Sneha', 'Amit', 'Divya', 'Karan', 'Pooja', 'Sanjay', 'Meera'];
const LAST_NAMES = ['Sharma', 'Patel', 'Singh', 'Gupta', 'Reddy', 'Iyer', 'Nair', 'Mehta', 'Joshi', 'Kapoor', 'Verma', 'Rao', 'Das', 'Chopra', 'Malhotra', 'Bose'];
const DEPARTMENTS = ['Engineering', 'Human Resources', 'Finance', 'Sales', 'Marketing', 'Operations', 'Legal', 'Support'];
const ROLES = ['Software Engineer', 'Senior Engineer', 'Manager', 'Analyst', 'Director', 'Associate', 'Lead', 'Consultant'];
const STATUSES = ['active', 'inactive', 'on_leave'];
const COUNTRIES = [
  { country: 'India', currency: 'INR', dial: '91' },
  { country: 'United States', currency: 'USD', dial: '1' },
  { country: 'United Kingdom', currency: 'GBP', dial: '44' },
  { country: 'Germany', currency: 'EUR', dial: '49' },
  { country: 'Japan', currency: 'JPY', dial: '81' },
  { country: 'Australia', currency: 'AUD', dial: '61' },
  { country: 'Singapore', currency: 'SGD', dial: '65' },
  { country: 'Canada', currency: 'CAD', dial: '1' },
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function randomDate(startYear, endYear) {
  const start = Date.UTC(startYear, 0, 1);
  const end = Date.UTC(endYear, 11, 31);
  return new Date(randomInt(start, end)).toISOString().slice(0, 10);
}

function makeRow(index) {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const location = pick(COUNTRIES);
  const joining = randomDate(2015, 2024);
  const updated = randomDate(2025, 2026);
  return {
    id: `EMP-${String(index + 1).padStart(5, '0')}`,
    first_name: first,
    last_name: last,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${index + 1}@example.com`,
    phone: `+${location.dial} ${randomInt(200, 999)} ${randomInt(100, 999)} ${randomInt(1000, 9999)}`,
    department: pick(DEPARTMENTS),
    role: pick(ROLES),
    salary: `${randomInt(30000, 250000)}.${String(randomInt(0, 99)).padStart(2, '0')}`,
    status: pick(STATUSES),
    country: location.country,
    joining_date: joining,
    currency: location.currency,
    last_updated_date: updated,
    last_updated_by: `hr.${pick(FIRST_NAMES).toLowerCase()}@example.com`,
  };
}

function monthPeriod(offset) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const iso = (date) => date.toISOString().slice(0, 10);
  return {
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    name: start.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    start: iso(start), end: iso(end), due: iso(end),
  };
}

function seedPayroll(databaseArg, monthsArg) {
  const databasePath = path.resolve(databaseArg ?? process.env.DATABASE_PATH ?? 'data/salary.sqlite');
  const months = Number(monthsArg ?? 6);
  if (!Number.isInteger(months) || months < 1 || months > 24) {
    console.error('past-months must be an integer between 1 and 24.');
    process.exit(1);
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    const employees = db.prepare('SELECT id, salary, currency, joining_date, status FROM employees ORDER BY id').all();
    if (!employees.length) throw new Error('No employees found. Import mock employees before seeding payroll.');
    const createdAt = new Date().toISOString();
    const insertPeriod = db.prepare(`INSERT OR IGNORE INTO payroll_periods
      (id, name, start_date, end_date, payment_due_date, status, created_at, approved_at, approved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertPayroll = db.prepare(`INSERT OR IGNORE INTO employee_payroll
      (id, payroll_period_id, employee_id, salary_snapshot, currency, additions, deductions, carried_forward,
       net_payable, amount_paid, outstanding_amount, status, calculated_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`);
    const insertPayment = db.prepare(`INSERT OR IGNORE INTO salary_payments
      (id, employee_payroll_id, amount, currency, payment_date, payment_method, transaction_reference,
       status, recorded_by, notes, created_at) VALUES (?, ?, ?, ?, ?, 'bank_transfer', ?, 'successful', ?, ?, ?)`);
    let payrollRows = 0;
    let paymentRows = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let offset = -months; offset <= 1; offset++) {
        const period = monthPeriod(offset);
        const future = offset >= 0;
        const periodId = `mock-payroll-${period.key}`;
        insertPeriod.run(periodId, period.name, period.start, period.end, period.due,
          future ? 'approved' : 'completed', createdAt, createdAt, 'mock.cfo@example.com');
        employees.forEach((employee, index) => {
          if (String(employee.joining_date).slice(0, 10) > period.end) return;
          const variation = ((index + offset + months) % 5) * 250;
          const additions = !future && index % 6 === 0 ? 1500 + variation : 0;
          const deductions = !future ? 500 + (index % 4) * 125 : 0;
          const net = Math.max(0, Number(employee.salary) + additions - deductions);
          let paid = future ? 0 : net;
          if (offset === -1 && index % 7 === 0) paid = Number((net * 0.6).toFixed(2));
          if (offset === -2 && index % 11 === 0) paid = 0;
          const outstanding = Number((net - paid).toFixed(2));
          const status = paid === 0 ? 'pending' : outstanding > 0 ? 'partially_paid' : 'paid';
          const payrollId = `mock-${period.key}-${employee.id}`;
          const inserted = insertPayroll.run(payrollId, periodId, employee.id, employee.salary, employee.currency,
            additions, deductions, net, paid, outstanding, status, createdAt, status === 'paid' ? period.due : null);
          payrollRows += Number(inserted.changes);
          if (paid > 0) {
            const payment = insertPayment.run(`mock-payment-${period.key}-${employee.id}`, payrollId, paid,
              employee.currency, period.due, `MOCK-${period.key}-${employee.id}`, 'mock.payroll@example.com',
              status === 'partially_paid' ? 'Mock partial salary payment' : 'Mock monthly salary payment', createdAt);
            paymentRows += Number(payment.changes);
          }
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    console.log(`Seeded ${payrollRows} payroll records and ${paymentRows} payments across ${months} historical months plus current/upcoming payroll in ${databasePath}`);
  } finally {
    db.close();
  }
}

function main() {
  const [rowsArg, outArg] = process.argv.slice(2);
  if (rowsArg === '--payroll-db') {
    seedPayroll(outArg, process.argv[4]);
    return;
  }
  const rows = Number(rowsArg);
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    console.error(`Usage: node scripts/generate-mock-data.cjs <rows 1-${MAX_ROWS}> [output.csv]`);
    process.exit(1);
  }
  const outFile = path.resolve(outArg ?? `mock-employees-${rows}.csv`);
  const lines = [COLUMNS.join(',')];
  for (let i = 0; i < rows; i++) {
    const row = makeRow(i);
    lines.push(COLUMNS.map((field) => row[field]).join(','));
  }
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${rows} employee rows to ${outFile}`);
}

main();
