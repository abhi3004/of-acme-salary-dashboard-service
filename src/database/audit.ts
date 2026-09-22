import type { DatabaseSync } from 'node:sqlite';

export const AUDIT_CATEGORIES = ['imports', 'employees', 'salaries', 'approvals', 'payroll', 'users'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export interface AuditInput {
  category: AuditCategory;
  action: string;
  actor: string;
  resource_type: string;
  resource_id: string;
  summary: string;
  metadata?: Record<string, unknown>;
}
export interface AuditEvent extends Omit<AuditInput, 'metadata'> {
  id: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        summary TEXT NOT NULL, metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_category ON audit_events(category, id DESC);
      CREATE INDEX IF NOT EXISTS audit_events_resource ON audit_events(resource_type, resource_id, id DESC);
      CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
    `);
  }

  record(event: AuditInput) {
    // Make loss of audit data fail the business operation instead of silently dropping it.
    if (!this.db.isTransaction) throw new Error('Audit events must be written inside the business transaction.');
    this.db.prepare(`INSERT INTO audit_events
      (category, action, actor, resource_type, resource_id, summary, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.category, event.action, event.actor || 'System', event.resource_type, event.resource_id,
        event.summary, JSON.stringify(event.metadata ?? {}), new Date().toISOString());
  }

  list(page: number, limit: number, category?: AuditCategory) {
    const where = category ? 'WHERE category = ?' : '';
    const params = category ? [category] : [];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS total FROM audit_events ${where}`).get(...params)!.total);
    const rows = this.db.prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit);
    const events = rows.map(({ metadata_json, ...row }) => ({
      ...row, metadata: JSON.parse(String(metadata_json)),
    })) as unknown as AuditEvent[];
    return { events, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } };
  }
}
