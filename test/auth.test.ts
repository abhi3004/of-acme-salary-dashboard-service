import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app';
import { PERMISSIONS } from '../src/auth';
import { fixture, seed } from './helpers';

const options = { enabled: true, adminEmail: 'admin@acme.test', adminPassword: 'Assessment123!', secureCookies: false };

test('seeds one full-access admin and requires a session for API access', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store, undefined, options);
  await request(app).get('/api/employees').expect(401);
  await request(app).post('/api/auth/login').send({ email: options.adminEmail, password: 'wrong-password' }).expect(401);
  const admin = request.agent(app);
  const login = await admin.post('/api/auth/login').send({ email: options.adminEmail, password: options.adminPassword }).expect(200);
  assert.deepEqual([...login.body.user.permissions].sort(), [...PERMISSIONS].sort());
  assert.equal(login.body.user.is_admin, true);
  await admin.get('/api/users').expect(200);
  await admin.post('/api/auth/logout').expect(204);
  await admin.get('/api/users').expect(401);
});

test('admin invitations create limited users and enforce their permissions', async (t) => {
  const { store } = fixture(t);
  await seed(store);
  const app = createApp(store, undefined, options);
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ email: options.adminEmail, password: options.adminPassword }).expect(200);
  const invitation = await admin.post('/api/users/invitations').send({
    name: 'HR Viewer', email: 'viewer@acme.test', permissions: ['employee.read'],
  }).expect(201);
  const token = invitation.body.invitation.token;
  await request(app).post(`/api/auth/invitations/${token}/accept`).send({ password: 'ViewerPass123!' }).expect(204);
  await request(app).post(`/api/auth/invitations/${token}/accept`).send({ password: 'ViewerPass123!' }).expect(400);

  const viewer = request.agent(app);
  await viewer.post('/api/auth/login').send({ email: 'viewer@acme.test', password: 'ViewerPass123!' }).expect(200);
  await viewer.get('/api/employees').expect(200);
  await viewer.get('/api/dashboard').expect(403);
  await viewer.get('/api/users').expect(403);
  await viewer.post('/api/employees/imports').expect(403);
});

test('rejects unknown permissions and duplicate invitation emails', async (t) => {
  const { store } = fixture(t);
  const app = createApp(store, undefined, options);
  const admin = request.agent(app);
  await admin.post('/api/auth/login').send({ email: options.adminEmail, password: options.adminPassword }).expect(200);
  await admin.post('/api/users/invitations').send({ name: 'Bad', email: 'bad@acme.test', permissions: ['root.everything'] }).expect(400);
  const input = { name: 'Viewer', email: 'viewer@acme.test', permissions: ['employee.read'] };
  await admin.post('/api/users/invitations').send(input).expect(201);
  await admin.post('/api/users/invitations').send(input).expect(409);
});
