import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import type { Store } from './database/store';
import { transaction } from './database/transaction';

const scrypt = promisify(scryptCallback);

export const PERMISSIONS = [
  'employee.read', 'employee.profile.update', 'salary.read', 'salary.change.request',
  'salary.change.approve', 'salary.change.apply', 'payroll.read', 'payroll.manage',
  'audit.read', 'user.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  permissions: Permission[];
  is_admin: boolean;
}

export interface AuthOptions {
  enabled: boolean;
  adminEmail?: string;
  adminPassword?: string;
  secureCookies?: boolean;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
}

export class AuthService {
  private readonly readyPromise: Promise<void>;
  constructor(private readonly store: Store, private readonly options: AuthOptions) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT, permissions_json TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('invited', 'active', 'disabled')),
        created_at TEXT NOT NULL, last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_invitations (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, accepted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON user_sessions(expires_at);
    `);
    this.readyPromise = this.seedAdmin();
  }

  ready() { return this.readyPromise; }

  private async seedAdmin() {
    if (!this.options.enabled) return;
    const email = this.options.adminEmail?.trim().toLowerCase();
    const password = this.options.adminPassword;
    if (!email || !password || password.length < 12)
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (minimum 12 characters) are required when authentication is enabled.');
    const existing = this.store.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return;
    const passwordHash = await hashPassword(password);
    transaction(this.store.db, () => {
      if (this.store.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return;
      const id = randomUUID();
      this.store.db.prepare(`INSERT INTO users
        (id, name, email, password_hash, permissions_json, is_admin, status, created_at)
        VALUES (?, ?, ?, ?, ?, 1, 'active', ?)`)
        .run(id, 'ACME Administrator', email, passwordHash, JSON.stringify(PERMISSIONS), new Date().toISOString());
      this.store.audit.record({ category: 'users', action: 'user.admin_created', actor: 'System',
        resource_type: 'user', resource_id: id, summary: `Created administrator account ${email}`,
        metadata: { email, permissions: [...PERMISSIONS] } });
    });
  }

  private publicUser(row: Record<string, unknown>): AuthUser {
    return { id: String(row.id), name: String(row.name), email: String(row.email),
      permissions: JSON.parse(String(row.permissions_json)) as Permission[], is_admin: Boolean(row.is_admin) };
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
    await this.ready();
    const row = this.store.db.prepare("SELECT * FROM users WHERE email = ? AND status = 'active'").get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
    if (!row?.password_hash || !await verifyPassword(password, String(row.password_hash))) return null;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
    this.store.db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now.toISOString());
    this.store.db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(digest(token), String(row.id), expires, now.toISOString());
    this.store.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now.toISOString(), String(row.id));
    return { token, user: this.publicUser(row) };
  }

  userForRequest(req: Request): AuthUser | null {
    const token = cookie(req, 'acme_session');
    if (!token) return null;
    const row = this.store.db.prepare(`SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`)
      .get(digest(token), new Date().toISOString()) as Record<string, unknown> | undefined;
    return row ? this.publicUser(row) : null;
  }

  setSessionCookie(res: Response, token: string) {
    res.cookie('acme_session', token, { httpOnly: true, sameSite: 'strict', secure: this.options.secureCookies,
      maxAge: 12 * 60 * 60 * 1000, path: '/' });
  }

  logout(req: Request, res: Response) {
    const token = cookie(req, 'acme_session');
    if (token) this.store.db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(digest(token));
    res.clearCookie('acme_session', { httpOnly: true, sameSite: 'strict', secure: this.options.secureCookies, path: '/' });
  }

  invite(name: string, email: string, permissions: Permission[], actor: string) {
    const normalized = email.trim().toLowerCase();
    const now = new Date();
    const token = randomBytes(24).toString('base64url');
    const userId = randomUUID();
    return transaction(this.store.db, () => {
      this.store.db.prepare(`INSERT INTO users
        (id, name, email, password_hash, permissions_json, is_admin, status, created_at)
        VALUES (?, ?, ?, NULL, ?, 0, 'invited', ?)`)
        .run(userId, name.trim(), normalized, JSON.stringify(permissions), now.toISOString());
      this.store.db.prepare('INSERT INTO user_invitations (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .run(digest(token), userId, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), now.toISOString());
      this.store.audit.record({ category: 'users', action: 'user.invited', actor,
        resource_type: 'user', resource_id: userId, summary: `Invited ${normalized}`,
        metadata: { name: name.trim(), email: normalized, permissions } });
      return { token, expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() };
    });
  }

  async acceptInvitation(token: string, password: string) {
    const findInvitation = () => this.store.db.prepare(`SELECT i.user_id, u.email FROM user_invitations i
      JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND i.accepted_at IS NULL
      AND i.expires_at > ? AND u.status = 'invited'`).get(digest(token), new Date().toISOString());
    if (!findInvitation()) return null;
    const passwordHash = await hashPassword(password);
    return transaction(this.store.db, () => {
      const invitation = findInvitation();
      if (!invitation) return null;
      this.store.db.prepare("UPDATE users SET password_hash = ?, status = 'active' WHERE id = ?")
        .run(passwordHash, String(invitation.user_id));
      this.store.db.prepare('UPDATE user_invitations SET accepted_at = ? WHERE token_hash = ?')
        .run(new Date().toISOString(), digest(token));
      this.store.audit.record({ category: 'users', action: 'user.activated', actor: String(invitation.email),
        resource_type: 'user', resource_id: String(invitation.user_id),
        summary: `Accepted invitation and activated ${invitation.email}`, metadata: { email: invitation.email } });
      return true;
    });
  }

  listUsers() {
    return this.store.db.prepare(`SELECT id, name, email, permissions_json, is_admin, status, created_at, last_login_at
      FROM users ORDER BY is_admin DESC, name`).all().map((row) => {
        const value = row as Record<string, unknown>;
        return { ...value, permissions: JSON.parse(String(value.permissions_json)), permissions_json: undefined,
          is_admin: Boolean(value.is_admin) };
      });
  }
}
