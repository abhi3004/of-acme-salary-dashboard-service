#!/usr/bin/env node
'use strict';

// Generates a CSV of valid mock employees for the import API.
// Usage: node scripts/generate-mock-data.cjs <rows> [output.csv]

const fs = require('node:fs');
const path = require('node:path');

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

function main() {
  const [rowsArg, outArg] = process.argv.slice(2);
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
