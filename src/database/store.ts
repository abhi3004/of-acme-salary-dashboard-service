import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Employee } from '../model/employee';
import { COLUMNS, ValidationError } from '../imports/validation';

export type ImportStatus = 'pending' | 'validating' | 'processing' | 'retrying' | 'completed' | 'failed';
export interface ImportRecord {
  id: string; filename: string; extension: string; status: ImportStatus;
  total_rows: number | null; processed_rows: number; attempts: number;
  error_json: string | null; next_retry_at: number; created_at: string; updated_at: string;
}
export class IdempotencyConflict extends Error {}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS employee_imports (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, extension TEXT NOT NULL,
        file BLOB, sha256 TEXT NOT NULL, idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending', total_rows INTEGER,
        processed_rows INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        error_json TEXT, next_retry_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
        email TEXT NOT NULL, phone TEXT NOT NULL, department TEXT NOT NULL,
        role TEXT NOT NULL, salary REAL NOT NULL CHECK(salary >= 0),
        status TEXT NOT NULL, country TEXT NOT NULL, joining_date TEXT NOT NULL,
        currency TEXT NOT NULL, last_updated_date TEXT NOT NULL, last_updated_by TEXT NOT NULL,
        source_import_id TEXT NOT NULL REFERENCES employee_imports(id)
      );
      CREATE TABLE IF NOT EXISTS import_rows (
        import_id TEXT NOT NULL REFERENCES employee_imports(id),
        row_number INTEGER NOT NULL, employee_id TEXT NOT NULL UNIQUE,
        employee_json TEXT NOT NULL, PRIMARY KEY (import_id, row_number)
      );
      CREATE INDEX IF NOT EXISTS imports_status ON employee_imports(status, next_retry_at);
    `);
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getImport(id: string): ImportRecord | undefined {
    return this.db.prepare(`SELECT id, filename, extension, status, total_rows, processed_rows,
      attempts, error_json, next_retry_at, created_at, updated_at FROM employee_imports WHERE id = ?`).get(id) as unknown as ImportRecord | undefined;
  }
  createImport(filename: string, extension: string, file: Buffer, key: string | null) {
    const hash = createHash('sha256').update(extension).update(file).digest('hex');
    return this.transaction(() => {
      if (key) {
        const existing = this.db.prepare('SELECT id, sha256 FROM employee_imports WHERE idempotency_key = ?').get(key);
        if (existing) {
          if (existing.sha256 !== hash) throw new IdempotencyConflict('This Idempotency-Key was used for a different file.');
          return { record: this.getImport(existing.id as string)!, reused: true };
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO employee_imports
        (id, filename, extension, file, sha256, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, filename, extension, file, hash, key, now, now);
      return { record: this.getImport(id)!, reused: false };
    });
  }
  getFile(id: string): Buffer {
    const row = this.db.prepare('SELECT file FROM employee_imports WHERE id = ?').get(id);
    if (!row?.file) throw new Error('Import source is unavailable.');
    return Buffer.from(row.file as Uint8Array);
  }
  pendingImports(): ImportRecord[] {
    return this.db.prepare(`SELECT id, status, next_retry_at FROM employee_imports
      WHERE status NOT IN ('completed', 'failed') AND next_retry_at <= ?
      ORDER BY created_at LIMIT 100`).all(Date.now()) as unknown as ImportRecord[];
  }
  beginAttempt(id: string) {
    this.db.prepare(`UPDATE employee_imports SET attempts = attempts + 1,
      status = CASE WHEN total_rows IS NULL THEN 'validating' ELSE 'processing' END,
      error_json = NULL, next_retry_at = 0, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')`).run(new Date().toISOString(), id);
  }
  prepareRows(id: string, employees: Employee[]) {
    this.transaction(() => {
      const record = this.getImport(id)!;
      if (record.total_rows !== null || ['completed', 'failed'].includes(record.status)) return;
      const existing = this.db.prepare('SELECT id FROM employees WHERE id = ?');
      const reserved = this.db.prepare('SELECT employee_id FROM import_rows WHERE employee_id = ?');
      const insert = this.db.prepare('INSERT INTO import_rows (import_id, row_number, employee_id, employee_json) VALUES (?, ?, ?, ?)');
      for (let index = 0; index < employees.length; index++) {
        const employee = employees[index]!;
        if (existing.get(employee.id) || reserved.get(employee.id)) {
          throw new ValidationError([{ row: index + 2, field: 'id', message: 'Employee ID already exists or is reserved by another import.' }]);
        }
        insert.run(id, index + 1, employee.id, JSON.stringify(employee));
      }
      this.db.prepare(`UPDATE employee_imports SET total_rows = ?, status = 'processing',
        file = NULL, updated_at = ? WHERE id = ?`).run(employees.length, new Date().toISOString(), id);
    });
  }
  insertBatch(id: string, batchSize: number): ImportRecord {
    return this.transaction(() => {
      const record = this.getImport(id)!;
      if (['completed', 'failed'].includes(record.status)) return record;
      const rows = this.db.prepare(`SELECT employee_json FROM import_rows WHERE import_id = ?
        AND row_number > ? ORDER BY row_number LIMIT ?`).all(id, record.processed_rows, batchSize);
      if (!rows.length) throw new Error('No staged rows available for this batch.');
      const insert = this.db.prepare(`INSERT INTO employees (${COLUMNS.join(', ')}, source_import_id)
        VALUES (${[...COLUMNS, 'source_import_id'].map(() => '?').join(', ')})`);
      for (const row of rows) {
        const employee = JSON.parse(row.employee_json as string) as Employee;
        insert.run(...COLUMNS.map((column) => employee[column]), id);
      }
      const processed = record.processed_rows + rows.length;
      const completed = processed === record.total_rows;
      this.db.prepare(`UPDATE employee_imports SET processed_rows = ?, status = ?,
        error_json = NULL, next_retry_at = 0, updated_at = ? WHERE id = ?`)
        .run(processed, completed ? 'completed' : 'processing', new Date().toISOString(), id);
      if (completed) this.db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(id);
      return this.getImport(id)!;
    });
  }
  failValidation(id: string, error: ValidationError) {
    this.transaction(() => {
      // Validation precedes all inserts; also release any staged reservations.
      this.db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(id);
      this.db.prepare(`UPDATE employee_imports SET status = 'failed', file = NULL,
        error_json = ?, updated_at = ? WHERE id = ? AND status != 'completed'`)
        .run(JSON.stringify({ code: 'VALIDATION_ERROR', errors: error.errors }), new Date().toISOString(), id);
    });
  }
  retryLater(id: string) {
    const record = this.getImport(id)!;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(record.attempts, 6));
    this.db.prepare(`UPDATE employee_imports SET status = 'retrying', error_json = ?,
      next_retry_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed')`)
      .run(JSON.stringify({ code: 'TEMPORARY_FAILURE', message: 'Processing interrupted; retry scheduled.' }), Date.now() + delay, new Date().toISOString(), id);
  }
}
