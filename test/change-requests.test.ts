import assert from 'node:assert/strict';
import { test } from 'node:test';
import PDFDocument from 'pdfkit';
import request from 'supertest';
import { createApp } from '../src/app';
import { processChangeRequest } from '../src/change-requests/process';
import { employee, fixture, seed } from './helpers';

function proof(lines: string[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const document = new PDFDocument();
    const chunks: Buffer[] = [];
    document.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    for (const line of lines) document.text(line);
    document.end();
  });
}

test('approved proof applies exactly the authorized employee changes', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const pdf = await proof(['Employee Change Authorization', 'Employee ID: EMP-1',
    'Reason: Manager approved leave', 'Approved By: manager@example.com',
    'Approval Date: 2026-09-20', 'Authorized Changes', '1. status: inactive']);
  const record = store.createChangeRequest('EMP-1', {
    status: 'inactive', expected_last_updated_date: employee().last_updated_date,
  }, 'hr@example.com', 'approval.pdf', pdf);
  await processChangeRequest(store, record.id);
  const reviewed = store.getChangeRequest(record.id)!;
  assert.equal(reviewed.status, 'approved');
  assert.equal(reviewed.approved_by, 'manager@example.com');
  assert.equal(reviewed.reason, 'Manager approved leave');
  assert.equal(store.getEmployee('EMP-1')!.status, 'inactive');
  assert.equal(store.getEmployee('EMP-1')!.last_updated_by, 'hr@example.com');
  const updates = store.audit.list(1, 100, 'employees').events;
  assert.equal(updates[0]!.actor, 'hr@example.com');
  assert.equal(updates[0]!.metadata.proof_signatory, 'manager@example.com');
  const approval = store.audit.list(1, 100, 'approvals').events[0]!;
  assert.equal(approval.actor, 'System');
  assert.equal(approval.action, 'change.approved');
  const count = store.audit.list(1, 100).pagination.total;
  await processChangeRequest(store, record.id);
  assert.equal(store.audit.list(1, 100).pagination.total, count);
});

test('mismatched proof is rejected without changing the employee', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const pdf = await proof(['Employee Change Authorization', 'Employee ID: EMP-1',
    'Reason: Approved', 'Approved By: manager@example.com', 'Approval Date: 2026-09-20',
    'Authorized Changes', 'status: active']);
  const record = store.createChangeRequest('EMP-1', {
    status: 'inactive', expected_last_updated_date: employee().last_updated_date,
  }, 'hr@example.com', 'wrong.pdf', pdf);
  await processChangeRequest(store, record.id);
  assert.equal(store.getChangeRequest(record.id)!.status, 'rejected');
  assert.match(store.getChangeRequest(record.id)!.error!, /does not authorize/);
  assert.equal(store.getEmployee('EMP-1')!.status, 'active');
  assert.equal(store.audit.list(1, 100, 'approvals').events[0]!.action, 'change.rejected');
  assert.equal(store.audit.list(1, 100, 'employees').events.length, 0);
});

test('direct employee edits are forbidden and PDF requests return 202', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store);
  await request(app).patch('/api/employees/EMP-1').set('X-Updated-By', 'hr@example.com')
    .send({ status: 'inactive', expected_last_updated_date: employee().last_updated_date }).expect(403);
  const pdf = await proof(['Employee Change Authorization', 'Employee ID: EMP-1', 'Reason: Approved',
    'Approved By: manager@example.com', 'Approval Date: 2026-09-20', 'status: inactive']);
  const response = await request(app).post('/api/employees/EMP-1/change-requests')
    .set('X-Updated-By', 'hr@example.com').field('changes', JSON.stringify({
      status: 'inactive', reason: 'Approved', expected_last_updated_date: employee().last_updated_date,
    })).attach('proof', pdf, 'approval.pdf').expect(202);
  assert.equal(response.body.status, 'pending');
  assert.equal(response.body.changes.status, 'inactive');
});
