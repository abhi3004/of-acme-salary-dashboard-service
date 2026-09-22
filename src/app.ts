import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import config from './config/config';
import {
  FILTERABLE_FIELDS,
  IdempotencyConflict,
  type EmployeeQuery,
  type Store,
  type ImportRecord,
} from './database/store';
import { COLUMNS } from './imports/validation';
import type { SalaryUpdate } from './model/salary-change';
import { dashboardSummary } from './dashboard';
import { EmployeeUpdateError, parseEmployeeUpdate } from './employees/update';
import { processChangeRequest } from './change-requests/process';
import { AuthService, PERMISSIONS, type AuthOptions, type Permission } from './auth';
import { AUDIT_CATEGORIES, type AuditCategory } from './database/audit';

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_PAGE_SIZE = 100;
const LIST_PARAMS = new Set<string>([
  ...FILTERABLE_FIELDS,
  'min_salary',
  'max_salary',
  'search',
  'sort',
  'order',
  'page',
  'limit',
]);

function parseListQuery(
  query: Record<string, unknown>,
): EmployeeQuery & { page: number } {
  for (const key of Object.keys(query)) {
    if (!LIST_PARAMS.has(key))
      throw new HttpError(
        400,
        `Unknown query parameter "${key}". Supported: ${[...LIST_PARAMS].join(', ')}.`,
      );
  }
  const single = (key: string): string | undefined => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim())
      throw new HttpError(400, `Provide "${key}" once with a non-empty value.`);
    return value.trim();
  };
  const integer = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = single(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new HttpError(
        400,
        `"${key}" must be an integer between ${min} and ${max}.`,
      );
    return value;
  };
  const salary = (key: string): number | undefined => {
    const raw = single(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      throw new HttpError(400, `"${key}" must be a non-negative number.`);
    return value;
  };
  const filters: EmployeeQuery['filters'] = {};
  for (const field of FILTERABLE_FIELDS) {
    const raw = query[field];
    if (raw === undefined) continue;
    const values = (Array.isArray(raw) ? raw : [raw])
      .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
      .map((value) => value.trim());
    if (
      !values.length ||
      values.some((value) => !value || value.length > 255)
    ) {
      throw new HttpError(
        400,
        `"${field}" values must be non-empty text of at most 255 characters (comma-separate or repeat the parameter for multiple values).`,
      );
    }
    filters[field] = [...new Set(values)];
  }
  const minSalary = salary('min_salary');
  const maxSalary = salary('max_salary');
  const search = single('search');
  if (search && search.length > 255)
    throw new HttpError(400, '"search" must be at most 255 characters.');
  if (
    minSalary !== undefined &&
    maxSalary !== undefined &&
    minSalary > maxSalary
  ) {
    throw new HttpError(400, '"min_salary" cannot exceed "max_salary".');
  }
  const sort = single('sort') ?? 'id';
  if (!(COLUMNS as readonly string[]).includes(sort))
    throw new HttpError(400, `"sort" must be one of: ${COLUMNS.join(', ')}.`);
  const order = (single('order') ?? 'asc').toLowerCase();
  if (!['asc', 'desc'].includes(order))
    throw new HttpError(400, '"order" must be "asc" or "desc".');
  const page = integer('page', 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = integer('limit', 25, 1, 10000);
  return {
    filters,
    search,
    minSalary,
    maxSalary,
    sort: sort as EmployeeQuery['sort'],
    order: order.toUpperCase() as EmployeeQuery['order'],
    limit,
    offset: (page - 1) * limit,
    page,
  };
}

function importResponse(record: ImportRecord) {
  return {
    id: record.id,
    filename: record.filename,
    status: record.status,
    total_rows: record.total_rows,
    processed_rows: record.processed_rows,
    progress: record.total_rows
      ? Math.floor((record.processed_rows / record.total_rows) * 100)
      : 0,
    attempts: record.attempts,
    error: record.error_json ? JSON.parse(record.error_json) : null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status_url: `/api/employees/imports/${record.id}`,
  };
}

function changeRequestResponse(record: ReturnType<Store['getChangeRequest']>) {
  if (!record) throw new HttpError(404, 'Change request not found.');
  const { __reason: _reason, ...changes } = JSON.parse(record.changes_json);
  return { ...record, changes, changes_json: undefined,
    status_url: `/api/employee-change-requests/${record.id}` };
}

function actor(req: express.Request): string {
  const value = req.get('X-Updated-By')?.trim();
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value))
    throw new HttpError(400, 'Provide your name or work email in X-Updated-By.');
  return value;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required.');
  return body as Record<string, unknown>;
}

function textField(input: Record<string, unknown>, key: string, max = 255): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw new HttpError(400, `${key} must be non-empty text of at most ${max} characters.`);
  return value.trim();
}

function dateField(input: Record<string, unknown>, key: string): string {
  const value = textField(input, key, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw new HttpError(400, `${key} must be a valid YYYY-MM-DD date.`);
  return value;
}

function moneyField(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || Number(value.toFixed(2)) !== value)
    throw new HttpError(400, `${key} must be a positive number with at most two decimal places.`);
  return value;
}

export function createApp(
  store: Store,
  maxUploadBytes = config.maxUploadBytes,
  authOptions: AuthOptions = { enabled: false },
) {
  const app = express();
  const auth = new AuthService(store, authOptions);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.post('/api/auth/login', async (req, res) => {
    if (!authOptions.enabled) return res.status(404).json({ error: { message: 'Authentication is disabled.' } });
    const body = objectBody(req.body);
    const email = textField(body, 'email');
    const password = textField(body, 'password', 200);
    const result = await auth.login(email, password);
    if (!result) return res.status(401).json({ error: { message: 'Invalid email or password.' } });
    auth.setSessionCookie(res, result.token);
    return res.json({ user: result.user });
  });
  app.post('/api/auth/logout', (req, res) => { auth.logout(req, res); res.status(204).end(); });
  app.post('/api/auth/invitations/:token/accept', async (req, res) => {
    const body = objectBody(req.body);
    const password = textField(body, 'password', 200);
    if (password.length < 12) throw new HttpError(400, 'Password must be at least 12 characters.');
    if (!await auth.acceptInvitation(req.params.token as string, password))
      throw new HttpError(400, 'Invitation is invalid, expired, or already used.');
    res.status(204).end();
  });
  app.use('/api', async (req, res, next) => {
    if (!authOptions.enabled) return next();
    await auth.ready();
    const user = auth.userForRequest(req);
    if (!user) return res.status(401).json({ error: { message: 'Sign in to continue.' } });
    res.locals.authUser = user;
    req.headers['x-updated-by'] = user.email;
    next();
  });
  const permit = (permission: Permission): express.RequestHandler => (_req, res, next) => {
    if (!authOptions.enabled || res.locals.authUser?.permissions.includes(permission)) return next();
    res.status(403).json({ error: { message: `Missing permission: ${permission}.` } });
  };
  app.get('/api/auth/me', (req, res) => res.json({ user: res.locals.authUser }));
  app.get('/api/audit-events', permit('audit.read'), (req, res) => {
    for (const key of Object.keys(req.query)) {
      if (!['page', 'limit', 'category'].includes(key)) throw new HttpError(400, `Unknown query parameter "${key}".`);
    }
    const integer = (key: string, fallback: number, max: number) => {
      const raw = req.query[key];
      if (raw === undefined) return fallback;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max)
        throw new HttpError(400, `${key} must be an integer between 1 and ${max}.`);
      return Number(raw);
    };
    const category = req.query.category;
    if (category !== undefined && (typeof category !== 'string' || !AUDIT_CATEGORIES.includes(category as AuditCategory)))
      throw new HttpError(400, `category must be one of: ${AUDIT_CATEGORIES.join(', ')}.`);
    res.set('Cache-Control', 'no-store').json(store.audit.list(integer('page', 1, 1_000_000),
      integer('limit', 25, 100), category as AuditCategory | undefined));
  });
  app.get('/api/users', permit('user.manage'), (_req, res) => res.json({ users: auth.listUsers(), permissions: PERMISSIONS }));
  app.post('/api/users/invitations', permit('user.manage'), (req, res) => {
    const body = objectBody(req.body);
    const name = textField(body, 'name');
    const email = textField(body, 'email');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'email must be a valid address.');
    if (!Array.isArray(body.permissions) || body.permissions.some((value) => !PERMISSIONS.includes(value as Permission)))
      throw new HttpError(400, 'permissions must contain only supported permission keys.');
    try {
      const invitation = auth.invite(name, email, [...new Set(body.permissions as Permission[])], actor(req));
      res.status(201).json({ invitation: { email: email.toLowerCase(), ...invitation,
        accept_url: `/accept-invitation/${invitation.token}` } });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
        throw new HttpError(409, 'A user with this email already exists.');
      throw error;
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, callback) => {
      if (
        !['.csv', '.xls'].includes(
          path.extname(file.originalname).toLowerCase(),
        )
      ) {
        callback(new HttpError(415, 'Only .csv and .xls files are accepted.'));
      } else callback(null, true);
    },
  });
  const proofUpload = multer({
    storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes, files: 1, fields: 1, parts: 3 },
    fileFilter: (_req, file, callback) => path.extname(file.originalname).toLowerCase() === '.pdf'
      ? callback(null, true) : callback(new HttpError(415, 'Proof must be a PDF file.')),
  });
  app.get('/healthz', (_req, res) => {
    store.db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });
  app.get('/api/dashboard', permit('salary.read'), (req, res) => {
    if (Object.keys(req.query).some((key) => key !== 'country')) throw new HttpError(400, 'Only country can be supplied.');
    const country = req.query.country;
    if (country !== undefined && (typeof country !== 'string' || !country.trim() || country.length > 255))
      throw new HttpError(400, 'country must be supplied once as non-empty text of at most 255 characters.');
    res.set('Cache-Control', 'no-store').json(dashboardSummary(store, typeof country === 'string' ? country.trim() : undefined));
  });
  app.get('/api/employees', permit('employee.read'), (req, res) => {
    const query = parseListQuery(req.query as Record<string, unknown>);
    const { employees, total } = store.listEmployees(query);
    res.set('Cache-Control', 'no-store').json({
      data: employees,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        total_pages: Math.ceil(total / query.limit),
      },
    });
  });
  app.get('/api/employees/filters', permit('employee.read'), (_req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .json({ filters: store.filterValues() });
  });
  app.post('/api/employees/imports', permit('employee.profile.update'), upload.single('file'), (req, res) => {
    if (!req.file?.size)
      throw new HttpError(
        400,
        'Upload one non-empty file using the multipart field "file".',
      );
    const key = req.get('Idempotency-Key') ?? null;
    if (key !== null && !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new HttpError(
        400,
        'Idempotency-Key must contain 1–128 visible ASCII characters.',
      );
    const filename = path.basename(req.file.originalname).slice(0, 255);
    const actor = req.get('X-Updated-By')?.trim() ?? '';
    if (actor.length > 255 || /[\u0000-\u001f\u007f]/.test(actor))
      throw new HttpError(
        400,
        'X-Updated-By must be at most 255 characters without control characters.',
      );
    const result = store.createImport(
      filename,
      path.extname(filename).toLowerCase(),
      req.file.buffer,
      key,
      actor,
    );
    const body = importResponse(result.record);
    res
      .status(result.reused ? 200 : 202)
      .location(body.status_url)
      .json({ ...body, reused: result.reused });
  });
  app.get('/api/employees/imports/:id', permit('employee.read'), (req, res) => {
    const record = store.getImport(req.params.id as string);
    if (!record) throw new HttpError(404, 'Import not found.');
    res.set('Cache-Control', 'no-store').json(importResponse(record));
  });
  app.patch('/api/employees/:id/salary', permit('salary.change.apply'), (req, res) => {
    throw new HttpError(403, 'Direct salary edits are disabled. Submit a change request with an approved proof PDF.');
    /* Legacy validation retained below for backwards-readable migration history.
    const actor = req.get('X-Updated-By')?.trim();
    if (!actor || actor.length > 255 || /[\u0000-\u001f\u007f]/.test(actor))
      throw new HttpError(
        400,
        'X-Updated-By must identify the caller (1–255 characters without control characters).',
      );
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(400, 'A JSON object is required.');
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'salary',
            'currency',
            'reason',
            'expected_last_updated_date',
          ].includes(key),
      )
    )
      throw new HttpError(
        400,
        'Only salary, currency, reason, and expected_last_updated_date can be supplied.',
      );
    const salary = input.salary;
    if (
      typeof salary !== 'number' ||
      !Number.isFinite(salary) ||
      salary < 0 ||
      salary > Number.MAX_SAFE_INTEGER / 100 ||
      Number(salary.toFixed(2)) !== salary
    )
      throw new HttpError(
        400,
        'salary must be a non-negative number with at most two decimal places.',
      );
    if (
      input.currency !== undefined &&
      (typeof input.currency !== 'string' ||
        !Intl.supportedValuesOf('currency').includes(input.currency))
    )
      throw new HttpError(
        400,
        'currency must be an uppercase ISO 4217 currency code.',
      );
    if (
      input.reason !== undefined &&
      (typeof input.reason !== 'string' ||
        !input.reason.trim() ||
        input.reason.length > 500 ||
        /[\u0000-\u001f\u007f]/.test(input.reason))
    )
      throw new HttpError(
        400,
        'reason must be 1–500 characters without control characters.',
      );
    if (
      input.expected_last_updated_date !== undefined &&
      (typeof input.expected_last_updated_date !== 'string' ||
        input.expected_last_updated_date.length > 40)
    )
      throw new HttpError(
        400,
        'expected_last_updated_date must be the timestamp returned by the API.',
      );
    res
      .set('Cache-Control', 'no-store')
      .json(
        store.updateSalary(
          req.params.id as string,
          input as unknown as SalaryUpdate,
          actor,
        ),
      ); */
  });
  app.get('/api/employees/:id/salary-history', permit('audit.read'), (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new HttpError(
        400,
        'limit must be 1–100 and offset must be a non-negative integer.',
      );
    res
      .set('Cache-Control', 'no-store')
      .json(store.salaryHistory(req.params.id as string, limit, offset));
  });
  app.get('/api/employees/:id', permit('employee.read'), (req, res) => {
    const employee = store.getEmployee(req.params.id as string);
    if (!employee) throw new HttpError(404, 'Employee not found.');
    res.set('Cache-Control', 'no-store').json({ employee });
  });
  app.post('/api/employees/:id/change-requests', permit('salary.change.request'), proofUpload.single('proof'), (req, res) => {
    const actor = req.get('X-Updated-By')?.trim();
    if (!actor || actor.length > 255 || /[\u0000-\u001f\u007f]/.test(actor))
      throw new HttpError(400, 'Provide your name or work email in X-Updated-By.');
    if (!req.file?.size) throw new HttpError(400, 'Upload a non-empty PDF using the multipart field "proof".');
    let body: unknown;
    try { body = JSON.parse(String(req.body.changes ?? '')); }
    catch { throw new HttpError(400, 'The changes field must contain valid JSON.'); }
    const input = parseEmployeeUpdate(body);
    if (!input.reason) throw new HttpError(400, 'A reason matching the proof PDF is required.');
    const record = store.createChangeRequest(req.params.id as string, input, actor,
      path.basename(req.file.originalname).slice(0, 255), req.file.buffer);
    setImmediate(() => { void processChangeRequest(store, record.id); });
    const response = changeRequestResponse(record);
    res.status(202).location(response.status_url).json(response);
  });
  app.get('/api/employee-change-requests/:id', permit('salary.change.request'), (req, res) => {
    res.set('Cache-Control', 'no-store').json(changeRequestResponse(store.getChangeRequest(req.params.id as string)));
  });
  app.get('/api/employees/:id/change-requests', permit('audit.read'), (req, res) => {
    if (!store.getEmployee(req.params.id as string)) throw new HttpError(404, 'Employee not found.');
    res.set('Cache-Control', 'no-store').json({ requests: store.listChangeRequests(req.params.id as string).map(changeRequestResponse) });
  });
  app.post('/api/payroll-periods', permit('payroll.manage'), (req, res) => {
    actor(req);
    const input = objectBody(req.body);
    const period = { name: textField(input, 'name'), start_date: dateField(input, 'start_date'),
      end_date: dateField(input, 'end_date'), payment_due_date: dateField(input, 'payment_due_date') };
    if (period.start_date > period.end_date) throw new HttpError(400, 'start_date cannot be after end_date.');
    if (period.payment_due_date < period.end_date) throw new HttpError(400, 'payment_due_date cannot be before end_date.');
    res.status(201).json({ period: store.createPayrollPeriod(period, actor(req)) });
  });
  app.post('/api/payroll-periods/:id/generate', permit('payroll.manage'), (req, res) => {
    actor(req);
    res.json(store.generatePayrollPeriod(req.params.id as string, actor(req)));
  });
  app.post('/api/payroll-periods/:id/approve', permit('payroll.manage'), (req, res) => {
    res.json({ period: store.approvePayrollPeriod(req.params.id as string, actor(req)) });
  });
  app.get('/api/payroll-periods/:id', permit('payroll.read'), (req, res) => {
    const period = store.getPayrollPeriod(req.params.id as string);
    if (!period) throw new HttpError(404, 'Payroll period not found.');
    res.set('Cache-Control', 'no-store').json({ period, payroll: store.payrollPeriodEntries(period.id) });
  });
  app.post('/api/employee-payroll/:id/adjustments', permit('payroll.manage'), (req, res) => {
    const input = objectBody(req.body);
    const type = textField(input, 'type');
    if (!['bonus', 'reimbursement', 'deduction', 'tax'].includes(type))
      throw new HttpError(400, 'type must be bonus, reimbursement, deduction, or tax.');
    res.status(201).json({ payroll: store.addPayrollAdjustment(req.params.id as string,
      { type, amount: moneyField(input, 'amount'), description: textField(input, 'description', 500) }, actor(req)) });
  });
  app.post('/api/employee-payroll/:id/payments', permit('payroll.manage'), (req, res) => {
    const input = objectBody(req.body);
    const status = textField(input, 'status');
    if (!['pending', 'successful', 'failed'].includes(status)) throw new HttpError(400, 'status must be pending, successful, or failed.');
    const notes = input.notes === undefined ? undefined : textField(input, 'notes', 500);
    res.status(201).json(store.recordSalaryPayment(req.params.id as string, {
      amount: moneyField(input, 'amount'), currency: textField(input, 'currency', 3),
      payment_date: dateField(input, 'payment_date'), payment_method: textField(input, 'payment_method'),
      transaction_reference: textField(input, 'transaction_reference'), status: status as 'pending' | 'successful' | 'failed', notes,
    }, actor(req)));
  });
  app.get('/api/employees/:id/payroll', permit('payroll.read'), (req, res) => {
    res.set('Cache-Control', 'no-store').json(store.employeePayrollSummary(req.params.id as string));
  });
  app.patch('/api/employees/:id', permit('employee.profile.update'), (req, res) => {
    throw new HttpError(403, 'Direct employee edits are disabled. Submit a change request with an approved proof PDF.');
  });
  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Route not found.' } });
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      res
        .status(tooLarge ? 413 : 400)
        .json({
          error: {
            code: error.code,
            message: tooLarge
              ? `File size exceeds ${maxUploadBytes} bytes.`
              : 'Upload exactly one file in the "file" field, without additional form fields.',
          },
        });
    } else if (
      error instanceof HttpError ||
      error instanceof EmployeeUpdateError ||
      error instanceof IdempotencyConflict
    ) {
      res
        .status(error instanceof IdempotencyConflict ? 409 : error.status)
        .json({ error: { message: error.message } });
    } else if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      ['entity.parse.failed', 'entity.too.large'].includes(String(error.type))
    ) {
      res
        .status(error.type === 'entity.too.large' ? 413 : 400)
        .json({
          error: { message: 'Supply valid JSON within the 16 KiB body limit.' },
        });
    } else {
      console.error('Request failed:', error);
      res
        .status(503)
        .json({
          error: {
            message:
              'Storage is temporarily unavailable. Retry with the same Idempotency-Key.',
          },
        });
    }
  };
  app.use(errors);
  return app;
}
