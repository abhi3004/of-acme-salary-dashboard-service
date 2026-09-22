import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Employee } from '../model/employee';
import type { SalaryChange, SalaryUpdate } from '../model/salary-change';
import { COLUMNS, ValidationError } from '../imports/validation';
import { EDITABLE_FIELDS, EmployeeUpdateError, type EmployeeUpdate } from '../employees/update';
import type { ChangeRequest } from '../model/change-request';
import type { EmployeePayroll, PayrollPeriod, PaymentStatus } from '../model/payroll';
import { AuditLog } from './audit';
import { transaction } from './transaction';

export type ImportStatus =
  'pending' | 'validating' | 'processing' | 'retrying' | 'completed' | 'failed';
export interface ImportRecord {
  id: string;
  filename: string;
  extension: string;
  requested_by: string;
  status: ImportStatus;
  total_rows: number | null;
  processed_rows: number;
  attempts: number;
  error_json: string | null;
  next_retry_at: number;
  created_at: string;
  updated_at: string;
}
export class IdempotencyConflict extends Error {}
export class SalaryUpdateError extends EmployeeUpdateError {}

export const FILTERABLE_FIELDS = [
  'department',
  'role',
  'status',
  'country',
  'currency',
] as const satisfies readonly (keyof Employee)[];
export type FilterableField = (typeof FILTERABLE_FIELDS)[number];
export interface EmployeeQuery {
  filters: Partial<Record<FilterableField, string[]>>;
  search?: string;
  minSalary?: number;
  maxSalary?: number;
  sort: keyof Employee;
  order: 'ASC' | 'DESC';
  limit: number;
  offset: number;
}

export class Store {
  readonly db: DatabaseSync;
  readonly audit: AuditLog;
  constructor(filename: string) {
    if (filename !== ':memory:')
      mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS employee_imports (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, extension TEXT NOT NULL,
        file BLOB, sha256 TEXT NOT NULL, idempotency_key TEXT UNIQUE,
        requested_by TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS salary_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        action TEXT NOT NULL CHECK(action IN ('import', 'salary_update')),
        old_salary REAL, new_salary REAL NOT NULL,
        old_currency TEXT, new_currency TEXT NOT NULL,
        previous_updated_at TEXT, previous_updated_by TEXT,
        changed_at TEXT NOT NULL, changed_by TEXT NOT NULL,
        reason TEXT, import_id TEXT REFERENCES employee_imports(id)
      );
      CREATE INDEX IF NOT EXISTS salary_changes_employee ON salary_changes(employee_id, id DESC);
      CREATE TABLE IF NOT EXISTS employee_change_requests (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id),
        requested_by TEXT NOT NULL, approved_by TEXT, reason TEXT,
        changes_json TEXT NOT NULL, expected_last_updated_date TEXT NOT NULL,
        filename TEXT NOT NULL, proof_pdf BLOB,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
        error TEXT, created_at TEXT NOT NULL, reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS change_requests_employee ON employee_change_requests(employee_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS payroll_periods (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        payment_due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'approved', 'processing', 'completed', 'closed')),
        created_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS payroll_period_dates ON payroll_periods(start_date, end_date);
      CREATE TABLE IF NOT EXISTS employee_payroll (
        id TEXT PRIMARY KEY, payroll_period_id TEXT NOT NULL REFERENCES payroll_periods(id),
        employee_id TEXT NOT NULL REFERENCES employees(id), salary_snapshot REAL NOT NULL CHECK(salary_snapshot >= 0),
        currency TEXT NOT NULL, additions REAL NOT NULL DEFAULT 0 CHECK(additions >= 0),
        deductions REAL NOT NULL DEFAULT 0 CHECK(deductions >= 0), carried_forward REAL NOT NULL DEFAULT 0,
        net_payable REAL NOT NULL CHECK(net_payable >= 0), amount_paid REAL NOT NULL DEFAULT 0 CHECK(amount_paid >= 0),
        outstanding_amount REAL NOT NULL CHECK(outstanding_amount >= 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'partially_paid', 'paid')),
        calculated_at TEXT NOT NULL, paid_at TEXT, UNIQUE(payroll_period_id, employee_id)
      );
      CREATE INDEX IF NOT EXISTS employee_payroll_employee ON employee_payroll(employee_id, calculated_at DESC);
      CREATE TABLE IF NOT EXISTS salary_payments (
        id TEXT PRIMARY KEY, employee_payroll_id TEXT NOT NULL REFERENCES employee_payroll(id),
        amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL, payment_date TEXT NOT NULL,
        payment_method TEXT NOT NULL, transaction_reference TEXT NOT NULL, status TEXT NOT NULL
          CHECK(status IN ('pending', 'successful', 'failed', 'reversed')),
        recorded_by TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS salary_payment_reference ON salary_payments(transaction_reference) WHERE transaction_reference != '';
      CREATE TABLE IF NOT EXISTS payroll_adjustments (
        id TEXT PRIMARY KEY, employee_payroll_id TEXT NOT NULL REFERENCES employee_payroll(id),
        type TEXT NOT NULL CHECK(type IN ('bonus', 'reimbursement', 'deduction', 'tax', 'correction')),
        amount REAL NOT NULL CHECK(amount > 0), description TEXT NOT NULL, approved_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS salary_changes_no_update BEFORE UPDATE ON salary_changes
        BEGIN SELECT RAISE(ABORT, 'Salary audit records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS salary_changes_no_delete BEFORE DELETE ON salary_changes
        BEGIN SELECT RAISE(ABORT, 'Salary audit records are append-only'); END;
      CREATE INDEX IF NOT EXISTS employees_department ON employees(department);
      CREATE INDEX IF NOT EXISTS employees_role ON employees(role);
      CREATE INDEX IF NOT EXISTS employees_status ON employees(status);
      CREATE INDEX IF NOT EXISTS employees_country ON employees(country);
      CREATE INDEX IF NOT EXISTS employees_currency ON employees(currency);
    `);
    this.audit = new AuditLog(this.db);
    // Upgrade existing imports without resetting data. The transaction also
    // serializes simultaneous API/worker startup against an older database.
    this.transaction(() => {
      const columns = this.db
        .prepare('PRAGMA table_info(employee_imports)')
        .all();
      if (!columns.some((column) => column.name === 'requested_by')) {
        this.db.exec(
          "ALTER TABLE employee_imports ADD COLUMN requested_by TEXT NOT NULL DEFAULT ''",
        );
      }
    });
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }
  getImport(id: string): ImportRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, filename, extension, requested_by, status, total_rows, processed_rows,
      attempts, error_json, next_retry_at, created_at, updated_at FROM employee_imports WHERE id = ?`,
      )
      .get(id) as unknown as ImportRecord | undefined;
  }
  createImport(
    filename: string,
    extension: string,
    file: Buffer,
    key: string | null,
    requestedBy = '',
  ) {
    const hash = createHash('sha256')
      .update(extension)
      .update(file)
      .digest('hex');
    return this.transaction(() => {
      if (key) {
        const existing = this.db
          .prepare(
            'SELECT id, sha256 FROM employee_imports WHERE idempotency_key = ?',
          )
          .get(key);
        if (existing) {
          if (existing.sha256 !== hash)
            throw new IdempotencyConflict(
              'This Idempotency-Key was used for a different file.',
            );
          return {
            record: this.getImport(existing.id as string)!,
            reused: true,
          };
        }
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO employee_imports
        (id, filename, extension, file, sha256, idempotency_key, requested_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, filename, extension, file, hash, key, requestedBy, now, now);
      this.audit.record({ category: 'imports', action: 'import.submitted', actor: requestedBy,
        resource_type: 'import', resource_id: id, summary: `Submitted employee import ${filename}`,
        metadata: { filename } });
      return { record: this.getImport(id)!, reused: false };
    });
  }
  getFile(id: string): Buffer {
    const row = this.db
      .prepare('SELECT file FROM employee_imports WHERE id = ?')
      .get(id);
    if (!row?.file) throw new Error('Import source is unavailable.');
    return Buffer.from(row.file as Uint8Array);
  }
  pendingImports(): ImportRecord[] {
    return this.db
      .prepare(
        `SELECT id, status, next_retry_at FROM employee_imports
      WHERE status NOT IN ('completed', 'failed') AND next_retry_at <= ?
      ORDER BY created_at LIMIT 100`,
      )
      .all(Date.now()) as unknown as ImportRecord[];
  }
  beginAttempt(id: string) {
    this.db
      .prepare(
        `UPDATE employee_imports SET attempts = attempts + 1,
      status = CASE WHEN total_rows IS NULL THEN 'validating' ELSE 'processing' END,
      error_json = NULL, next_retry_at = 0, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed')`,
      )
      .run(new Date().toISOString(), id);
  }
  prepareRows(id: string, employees: Employee[]) {
    this.transaction(() => {
      const record = this.getImport(id)!;
      if (
        record.total_rows !== null ||
        ['completed', 'failed'].includes(record.status)
      )
        return;
      const existing = this.db.prepare('SELECT id FROM employees WHERE id = ?');
      const reserved = this.db.prepare(
        'SELECT employee_id FROM import_rows WHERE employee_id = ?',
      );
      const insert = this.db.prepare(
        'INSERT INTO import_rows (import_id, row_number, employee_id, employee_json) VALUES (?, ?, ?, ?)',
      );
      for (let index = 0; index < employees.length; index++) {
        const employee = employees[index]!;
        if (existing.get(employee.id) || reserved.get(employee.id)) {
          throw new ValidationError([
            {
              row: index + 2,
              field: 'id',
              message:
                'Employee ID already exists or is reserved by another import.',
            },
          ]);
        }
        insert.run(id, index + 1, employee.id, JSON.stringify(employee));
      }
      this.db
        .prepare(
          `UPDATE employee_imports SET total_rows = ?, status = 'processing',
        file = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(employees.length, new Date().toISOString(), id);
    });
  }
  insertBatch(id: string, batchSize: number): ImportRecord {
    return this.transaction(() => {
      const record = this.getImport(id)!;
      if (['completed', 'failed'].includes(record.status)) return record;
      const rows = this.db
        .prepare(
          `SELECT employee_json FROM import_rows WHERE import_id = ?
        AND row_number > ? ORDER BY row_number LIMIT ?`,
        )
        .all(id, record.processed_rows, batchSize);
      if (!rows.length)
        throw new Error('No staged rows available for this batch.');
      const insert = this.db
        .prepare(`INSERT INTO employees (${COLUMNS.join(', ')}, source_import_id)
        VALUES (${[...COLUMNS, 'source_import_id'].map(() => '?').join(', ')})`);
      for (const row of rows) {
        const employee = JSON.parse(row.employee_json as string) as Employee;
        insert.run(...COLUMNS.map((column) => employee[column]), id);
        this.db
          .prepare(
            `INSERT INTO salary_changes
          (employee_id, action, new_salary, new_currency, changed_at, changed_by, import_id)
          VALUES (?, 'import', ?, ?, ?, ?, ?)`,
          )
          .run(
            employee.id,
            employee.salary,
            employee.currency,
            new Date().toISOString(),
            record.requested_by || employee.last_updated_by,
            id,
          );
      }
      const processed = record.processed_rows + rows.length;
      const completed = processed === record.total_rows;
      this.db
        .prepare(
          `UPDATE employee_imports SET processed_rows = ?, status = ?,
        error_json = NULL, next_retry_at = 0, updated_at = ? WHERE id = ?`,
        )
        .run(
          processed,
          completed ? 'completed' : 'processing',
          new Date().toISOString(),
          id,
        );
      if (completed)
        this.db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(id);
      this.audit.record({ category: 'imports', action: completed ? 'import.completed' : 'import.progress',
        actor: record.requested_by, resource_type: 'import', resource_id: id,
        summary: completed ? `Added ${processed} employee records from ${record.filename}`
          : `Added ${rows.length} employee records (${processed} of ${record.total_rows})`,
        metadata: { filename: record.filename, batch_rows: rows.length, processed_rows: processed,
          total_rows: record.total_rows, completed } });
      return this.getImport(id)!;
    });
  }
  failValidation(id: string, error: ValidationError) {
    this.transaction(() => {
      const record = this.getImport(id);
      if (!record || ['completed', 'failed'].includes(record.status)) return;
      // Validation precedes all inserts; also release any staged reservations.
      this.db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(id);
      this.db
        .prepare(
          `UPDATE employee_imports SET status = 'failed', file = NULL,
        error_json = ?, updated_at = ? WHERE id = ? AND status != 'completed'`,
        )
        .run(
          JSON.stringify({ code: 'VALIDATION_ERROR', errors: error.errors }),
          new Date().toISOString(),
          id,
        );
      this.audit.record({ category: 'imports', action: 'import.failed', actor: record.requested_by,
        resource_type: 'import', resource_id: id, summary: `Employee import ${record.filename} failed validation`,
        metadata: { filename: record.filename, errors: error.errors, processed_rows: record.processed_rows } });
    });
  }
  listEmployees(query: EmployeeQuery): {
    employees: Employee[];
    total: number;
  } {
    // sort/order are interpolated into SQL, so they must come from the whitelist.
    if (
      !COLUMNS.includes(query.sort) ||
      !['ASC', 'DESC'].includes(query.order)
    ) {
      throw new Error('Invalid sort column or order.');
    }
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.search) {
      const term = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(id LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR country LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR email LIKE ? ESCAPE '\\' COLLATE NOCASE)`);
      params.push(term, term, term, term, term, term);
    }
    for (const field of FILTERABLE_FIELDS) {
      const values = query.filters[field];
      if (values?.length) {
        clauses.push(`${field} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      }
    }
    if (query.minSalary !== undefined) {
      clauses.push('salary >= ?');
      params.push(query.minSalary);
    }
    if (query.maxSalary !== undefined) {
      clauses.push('salary <= ?');
      params.push(query.maxSalary);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM employees ${where}`)
      .get(...params)!.count as number;
    const employees = this.db
      .prepare(
        `SELECT ${COLUMNS.join(', ')} FROM employees ${where}
      ORDER BY ${query.sort} ${query.order}, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as unknown as Employee[];
    return { employees, total };
  }
  filterValues(): Record<FilterableField, string[]> {
    const values = {} as Record<FilterableField, string[]>;
    for (const field of FILTERABLE_FIELDS) {
      values[field] = this.db
        .prepare(
          `SELECT DISTINCT ${field} AS value FROM employees ORDER BY value`,
        )
        .all()
        .map((row) => row.value as string);
    }
    return values;
  }
  retryLater(id: string) {
    const record = this.getImport(id)!;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(record.attempts, 6));
    this.db
      .prepare(
        `UPDATE employee_imports SET status = 'retrying', error_json = ?,
      next_retry_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed')`,
      )
      .run(
        JSON.stringify({
          code: 'TEMPORARY_FAILURE',
          message: 'Processing interrupted; retry scheduled.',
        }),
        Date.now() + delay,
        new Date().toISOString(),
        id,
      );
  }
  getEmployee(id: string): Employee | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS.join(', ')} FROM employees WHERE id = ?`)
      .get(id) as unknown as Employee | undefined;
  }
  updateSalary(id: string, input: SalaryUpdate, actor: string) {
    return this.updateEmployee(id, input, actor);
  }
  createChangeRequest(employeeId: string, changes: EmployeeUpdate, requestedBy: string, filename: string, proof: Buffer) {
    return this.transaction(() => {
      if (!this.getEmployee(employeeId)) throw new EmployeeUpdateError(404, 'Employee not found.');
      const id = randomUUID();
      const now = new Date().toISOString();
      const { expected_last_updated_date, reason, ...requested } = changes;
      this.db.prepare(`INSERT INTO employee_change_requests
        (id, employee_id, requested_by, changes_json, expected_last_updated_date, filename, proof_pdf, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, employeeId, requestedBy, JSON.stringify({ ...requested, __reason: reason }), expected_last_updated_date!, filename, proof, now);
      this.audit.record({ category: 'approvals', action: 'change.requested', actor: requestedBy,
        resource_type: 'employee', resource_id: employeeId, summary: `Requested changes to ${employeeId}`,
        metadata: { change_request_id: id, requested, reason: reason ?? null, filename } });
      return this.getChangeRequest(id)!;
    });
  }
  getChangeRequest(id: string): ChangeRequest | undefined {
    return this.db.prepare(`SELECT id, employee_id, requested_by, approved_by, reason, changes_json,
      expected_last_updated_date, filename, status, error, created_at, reviewed_at
      FROM employee_change_requests WHERE id = ?`).get(id) as unknown as ChangeRequest | undefined;
  }
  listChangeRequests(employeeId: string): ChangeRequest[] {
    return this.db.prepare(`SELECT id, employee_id, requested_by, approved_by, reason, changes_json,
      expected_last_updated_date, filename, status, error, created_at, reviewed_at
      FROM employee_change_requests WHERE employee_id = ? ORDER BY created_at DESC`).all(employeeId) as unknown as ChangeRequest[];
  }
  getChangeRequestFile(id: string): Buffer {
    const row = this.db.prepare('SELECT proof_pdf FROM employee_change_requests WHERE id = ?').get(id);
    if (!row?.proof_pdf) throw new Error('Proof PDF is unavailable.');
    return Buffer.from(row.proof_pdf as Uint8Array);
  }
  approveChangeRequest(id: string, input: EmployeeUpdate, approvedBy: string, reason: string) {
    return this.transaction(() => {
      const request = this.getChangeRequest(id);
      if (!request || request.status !== 'pending') return request;
      // The PDF signatory is a claim in the document, not an authenticated account.
      const result = this.updateEmployee(request.employee_id, input, request.requested_by,
        { change_request_id: id, proof_signatory: approvedBy, approval_method: 'pdf_validation' });
      this.db.prepare(`UPDATE employee_change_requests SET status = 'approved', approved_by = ?, reason = ?,
        error = NULL, proof_pdf = NULL, reviewed_at = ? WHERE id = ?`)
        .run(approvedBy, reason, new Date().toISOString(), id);
      this.audit.record({ category: 'approvals', action: 'change.approved', actor: 'System',
        resource_type: 'employee', resource_id: request.employee_id,
        summary: `Automatically approved the change request for ${request.employee_id} after PDF validation`,
        metadata: { change_request_id: id, requested_by: request.requested_by, proof_signatory: approvedBy,
          reason, approval_method: 'pdf_validation' } });
      return { request: this.getChangeRequest(id)!, result };
    });
  }
  rejectChangeRequest(id: string, error: string) {
    this.transaction(() => {
      const request = this.getChangeRequest(id);
      if (!request || request.status !== 'pending') return;
      this.db.prepare(`UPDATE employee_change_requests SET status = 'rejected', error = ?, proof_pdf = NULL,
        reviewed_at = ? WHERE id = ? AND status = 'pending'`).run(error.slice(0, 1000), new Date().toISOString(), id);
      this.audit.record({ category: 'approvals', action: 'change.rejected', actor: 'System',
        resource_type: 'employee', resource_id: request.employee_id,
        summary: `Rejected the change request for ${request.employee_id}`,
        metadata: { change_request_id: id, requested_by: request.requested_by, error: error.slice(0, 1000) } });
    });
  }
  updateEmployee(id: string, input: EmployeeUpdate, actor: string, context: Record<string, unknown> = {}) {
    return this.transaction(() => {
      const employee = this.getEmployee(id);
      if (!employee) throw new SalaryUpdateError(404, 'Employee not found.');
      const source = this.db
        .prepare(
          `SELECT i.status FROM employee_imports i
        JOIN employees e ON e.source_import_id = i.id WHERE e.id = ?`,
        )
        .get(id);
      if (source?.status !== 'completed')
        throw new SalaryUpdateError(
          409,
          'Wait for this employee import to complete before editing employee details.',
        );
      if (
        input.expected_last_updated_date !== undefined &&
        input.expected_last_updated_date !== employee.last_updated_date
      ) {
        throw new SalaryUpdateError(
          409,
          'Employee was updated since it was read. Refresh before retrying.',
        );
      }
      const currency = input.currency ?? employee.currency;
      const salary = input.salary ?? employee.salary;
      const changedFields = EDITABLE_FIELDS.filter((field) =>
        input[field] !== undefined && input[field] !== employee[field],
      );
      if (!changedFields.length)
        return { employee, changed: false, audit_id: null };
      const previousChange = this.db
        .prepare(
          'SELECT changed_at FROM salary_changes WHERE employee_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(id);
      const previousServerTime = previousChange
        ? Date.parse(previousChange.changed_at as string)
        : 0;
      const changedAt = new Date(
        Math.max(Date.now(), previousServerTime + 1, Date.parse(employee.last_updated_date) + 1),
      ).toISOString();
      const salaryChanged = salary !== employee.salary || currency !== employee.currency;
      const audit = salaryChanged ? this.db
        .prepare(
          `INSERT INTO salary_changes
        (employee_id, action, old_salary, new_salary, old_currency, new_currency,
         previous_updated_at, previous_updated_by, changed_at, changed_by, reason)
        VALUES (?, 'salary_update', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          employee.salary,
          salary,
          employee.currency,
          currency,
          employee.last_updated_date,
          employee.last_updated_by,
          changedAt,
          actor,
          input.reason ?? null,
        ) : null;
      this.db
        .prepare(
          `UPDATE employees SET ${changedFields.map((field) => `${field} = ?`).join(', ')}, last_updated_date = ?, last_updated_by = ? WHERE id = ?`,
        )
        .run(...changedFields.map((field) => input[field]!), changedAt, actor, id);
      this.audit.record({ category: salaryChanged ? 'salaries' : 'employees',
        action: salaryChanged ? 'salary.changed' : 'employee.updated', actor,
        resource_type: 'employee', resource_id: id,
        summary: salaryChanged ? `Changed salary for ${id} from ${employee.currency} ${employee.salary} to ${currency} ${salary}`
          : `Updated employee details for ${id}`,
        metadata: { ...context, reason: input.reason ?? null, salary_change_id: audit ? Number(audit.lastInsertRowid) : null,
          changes: changedFields.map((field) => ({ field, before: employee[field], after: input[field] })) } });
      return {
        employee: this.getEmployee(id)!,
        changed: true,
        audit_id: audit ? Number(audit.lastInsertRowid) : null,
      };
    });
  }
  salaryHistory(id: string, limit: number, offset: number) {
    if (!this.getEmployee(id))
      throw new SalaryUpdateError(404, 'Employee not found.');
    const total = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM salary_changes WHERE employee_id = ?',
      )
      .get(id)!.count as number;
    const changes = this.db
      .prepare(
        'SELECT * FROM salary_changes WHERE employee_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .all(id, limit, offset) as unknown as SalaryChange[];
    return { employee_id: id, total, limit, offset, changes };
  }
  createPayrollPeriod(input: { name: string; start_date: string; end_date: string; payment_due_date: string }, actor = 'System') {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      return this.transaction(() => {
        this.db.prepare(`INSERT INTO payroll_periods (id, name, start_date, end_date, payment_due_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.name, input.start_date, input.end_date, input.payment_due_date, createdAt);
        this.audit.record({ category: 'payroll', action: 'payroll.created', actor,
          resource_type: 'payroll_period', resource_id: id, summary: `Created payroll period ${input.name}`, metadata: { ...input } });
        return this.getPayrollPeriod(id)!;
      });
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new EmployeeUpdateError(409, 'A payroll period already exists for these dates.');
      throw error;
    }
  }
  getPayrollPeriod(id: string): PayrollPeriod | undefined {
    return this.db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(id) as unknown as PayrollPeriod | undefined;
  }
  generatePayrollPeriod(id: string, actor = 'System') {
    return this.transaction(() => {
      const period = this.getPayrollPeriod(id);
      if (!period) throw new EmployeeUpdateError(404, 'Payroll period not found.');
      if (period.status !== 'draft') throw new EmployeeUpdateError(409, 'Only draft payroll periods can be generated.');
      const employees = this.db.prepare(`SELECT id, salary, currency FROM employees WHERE status = 'active' ORDER BY id`).all();
      const insert = this.db.prepare(`INSERT OR IGNORE INTO employee_payroll
        (id, payroll_period_id, employee_id, salary_snapshot, currency, net_payable, outstanding_amount, calculated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const calculatedAt = new Date().toISOString();
      let added = 0;
      for (const employee of employees) added += Number(insert.run(randomUUID(), id, employee.id, employee.salary, employee.currency,
        employee.salary, employee.salary, calculatedAt).changes);
      if (added) this.audit.record({ category: 'payroll', action: 'payroll.generated', actor,
        resource_type: 'payroll_period', resource_id: id,
        summary: `Generated ${added} employee payroll records for ${period.name}`, metadata: { employees_added: added } });
      return { period, employees: employees.length, payroll: this.payrollPeriodEntries(id) };
    });
  }
  payrollPeriodEntries(id: string): EmployeePayroll[] {
    return this.db.prepare('SELECT * FROM employee_payroll WHERE payroll_period_id = ? ORDER BY employee_id')
      .all(id) as unknown as EmployeePayroll[];
  }
  approvePayrollPeriod(id: string, actor: string) {
    return this.transaction(() => {
      const period = this.getPayrollPeriod(id);
      if (!period) throw new EmployeeUpdateError(404, 'Payroll period not found.');
      if (period.status !== 'draft') throw new EmployeeUpdateError(409, 'Only draft payroll periods can be approved.');
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM employee_payroll WHERE payroll_period_id = ?').get(id)!.count as number;
      if (!count) throw new EmployeeUpdateError(409, 'Generate employee payroll entries before approval.');
      this.db.prepare(`UPDATE payroll_periods SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?`)
        .run(new Date().toISOString(), actor, id);
      this.audit.record({ category: 'payroll', action: 'payroll.approved', actor,
        resource_type: 'payroll_period', resource_id: id, summary: `Approved payroll period ${period.name}`,
        metadata: { employees: count, before: period.status, after: 'approved' } });
      return this.getPayrollPeriod(id)!;
    });
  }
  addPayrollAdjustment(payrollId: string, input: { type: string; amount: number; description: string }, actor: string) {
    return this.transaction(() => {
      const payroll = this.db.prepare(`SELECT ep.*, pp.status AS period_status FROM employee_payroll ep
        JOIN payroll_periods pp ON pp.id = ep.payroll_period_id WHERE ep.id = ?`).get(payrollId);
      if (!payroll) throw new EmployeeUpdateError(404, 'Employee payroll record not found.');
      if (payroll.period_status !== 'draft') throw new EmployeeUpdateError(409, 'Adjustments can only be added before payroll approval.');
      const addition = ['bonus', 'reimbursement'].includes(input.type) ? input.amount : 0;
      const deduction = ['deduction', 'tax'].includes(input.type) ? input.amount : 0;
      if (input.type === 'correction') throw new EmployeeUpdateError(400, 'Use a bonus or deduction to specify the correction direction.');
      const net = Number(payroll.net_payable) + addition - deduction;
      if (net < 0) throw new EmployeeUpdateError(400, 'Deductions cannot exceed the payable amount.');
      const adjustmentId = randomUUID();
      this.db.prepare(`INSERT INTO payroll_adjustments
        (id, employee_payroll_id, type, amount, description, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(adjustmentId, payrollId, input.type, input.amount, input.description, actor, new Date().toISOString());
      this.db.prepare(`UPDATE employee_payroll SET additions = additions + ?, deductions = deductions + ?,
        net_payable = ?, outstanding_amount = ? - amount_paid WHERE id = ?`)
        .run(addition, deduction, net, net, payrollId);
      this.audit.record({ category: 'payroll', action: 'payroll.adjusted', actor,
        resource_type: 'employee', resource_id: String(payroll.employee_id),
        summary: `Added ${input.type} of ${payroll.currency} ${input.amount} for ${payroll.employee_id}`,
        metadata: { adjustment_id: adjustmentId, employee_payroll_id: payrollId, payroll_period_id: payroll.payroll_period_id,
          ...input, currency: payroll.currency, changes: [{ field: 'net_payable', before: payroll.net_payable, after: net }] } });
      return this.db.prepare('SELECT * FROM employee_payroll WHERE id = ?').get(payrollId);
    });
  }
  recordSalaryPayment(payrollId: string, input: { amount: number; currency: string; payment_date: string; payment_method: string; transaction_reference: string; status: PaymentStatus; notes?: string }, actor: string) {
    return this.transaction(() => {
      const payroll = this.db.prepare(`SELECT ep.*, pp.status AS period_status FROM employee_payroll ep
        JOIN payroll_periods pp ON pp.id = ep.payroll_period_id WHERE ep.id = ?`).get(payrollId);
      if (!payroll) throw new EmployeeUpdateError(404, 'Employee payroll record not found.');
      if (!['approved', 'processing'].includes(String(payroll.period_status)))
        throw new EmployeeUpdateError(409, 'Payroll must be approved before recording payments.');
      if (input.currency !== payroll.currency) throw new EmployeeUpdateError(400, 'Payment currency must match the payroll currency.');
      if (input.status === 'successful' && input.amount > Number(payroll.outstanding_amount))
        throw new EmployeeUpdateError(400, 'Payment exceeds the outstanding amount.');
      const paymentId = randomUUID();
      this.db.prepare(`INSERT INTO salary_payments
        (id, employee_payroll_id, amount, currency, payment_date, payment_method, transaction_reference, status, recorded_by, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(paymentId, payrollId, input.amount, input.currency, input.payment_date, input.payment_method,
          input.transaction_reference, input.status, actor, input.notes ?? null, new Date().toISOString());
      if (input.status === 'successful') {
        const paid = Number(payroll.amount_paid) + input.amount;
        const outstanding = Number(payroll.net_payable) - paid;
        const status = outstanding === 0 ? 'paid' : 'partially_paid';
        this.db.prepare(`UPDATE employee_payroll SET amount_paid = ?, outstanding_amount = ?, status = ?,
          paid_at = CASE WHEN ? = 'paid' THEN ? ELSE NULL END WHERE id = ?`)
          .run(paid, outstanding, status, status, input.payment_date, payrollId);
      }
      this.db.prepare(`UPDATE payroll_periods SET status = CASE WHEN status = 'approved' THEN 'processing' ELSE status END
        WHERE id = ?`).run(payroll.payroll_period_id);
      const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM employee_payroll WHERE payroll_period_id = ? AND status != 'paid'`)
        .get(payroll.payroll_period_id)!.count as number;
      if (!remaining) this.db.prepare("UPDATE payroll_periods SET status = 'completed' WHERE id = ?").run(payroll.payroll_period_id);
      const updated = this.db.prepare('SELECT * FROM employee_payroll WHERE id = ?').get(payrollId)!;
      this.audit.record({ category: 'payroll', action: 'payment.recorded', actor,
        resource_type: 'employee', resource_id: String(payroll.employee_id),
        summary: `Recorded ${input.status} payment of ${input.currency} ${input.amount} for ${payroll.employee_id}`,
        metadata: { payment_id: paymentId, employee_payroll_id: payrollId, payroll_period_id: payroll.payroll_period_id,
          ...input, changes: [{ field: 'amount_paid', before: payroll.amount_paid, after: updated.amount_paid },
            { field: 'outstanding_amount', before: payroll.outstanding_amount, after: updated.outstanding_amount }] } });
      const periodAfter = this.getPayrollPeriod(String(payroll.payroll_period_id))!;
      if (periodAfter.status !== payroll.period_status) this.audit.record({ category: 'payroll', action: 'payroll.status_changed', actor,
        resource_type: 'payroll_period', resource_id: periodAfter.id,
        summary: `Payroll period ${periodAfter.name} is now ${periodAfter.status}`,
        metadata: { payment_id: paymentId, changes: [{ field: 'status', before: payroll.period_status, after: periodAfter.status }] } });
      return { payment: this.db.prepare('SELECT * FROM salary_payments WHERE id = ?').get(paymentId),
        payroll: this.db.prepare('SELECT * FROM employee_payroll WHERE id = ?').get(payrollId) };
    });
  }
  employeePayrollSummary(employeeId: string) {
    const employee = this.getEmployee(employeeId);
    if (!employee) throw new EmployeeUpdateError(404, 'Employee not found.');
    const history = this.db.prepare(`SELECT ep.*, pp.name AS period_name, pp.start_date, pp.end_date, pp.payment_due_date,
      pp.status AS period_status FROM employee_payroll ep JOIN payroll_periods pp ON pp.id = ep.payroll_period_id
      WHERE ep.employee_id = ? ORDER BY pp.payment_due_date DESC`).all(employeeId) as Record<string, unknown>[];
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = history.filter((row) => String(row.payment_due_date) >= today && row.period_status !== 'closed')
      .sort((a, b) => String(a.payment_due_date).localeCompare(String(b.payment_due_date)))[0] ?? null;
    const previous = history.filter((row) => String(row.payment_due_date) < today).slice(0, 24);
    const overdue = history.filter((row) => String(row.payment_due_date) < today && row.period_status !== 'draft' && Number(row.outstanding_amount) > 0);
    const totals = new Map<string, number>();
    for (const row of overdue) totals.set(String(row.currency), (totals.get(String(row.currency)) ?? 0) + Number(row.outstanding_amount));
    const now = new Date();
    const projectedDue = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    const projection = upcoming ? null : { period_name: projectedDue.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      payment_due_date: projectedDue.toISOString().slice(0, 10), salary_snapshot: employee.salary, currency: employee.currency,
      additions: 0, deductions: 0, carried_forward: 0, net_payable: employee.salary, amount_paid: 0,
      outstanding_amount: employee.salary, status: 'projected', period_status: 'projected' };
    return { employee_id: employeeId, upcoming, projection, previous,
      outstanding: { by_currency: [...totals].map(([currency, amount]) => ({ currency, amount })), periods: overdue } };
  }
}
