# Salary dashboard service

AI development tooling: [quality skills, sources, and setup](docs/AI_SKILLS.md).
This records installation, not a completed accessibility or security audit.

## Run the API and import worker

Requires Node.js **22.13+** (Node 24 recommended) and Redis. SQLite uses Node's
built-in driver; no separate database server is needed.

```sh
npm install
npm run build
```

Merge the settings from `.env.example` into your existing `.env`, then start Redis,
`npm start`, and `npm run worker` in separate terminals. Both processes must use
the same `DATABASE_PATH` (default `data/salary.sqlite`). The worker must run from
the compiled `dist` directory; rebuild and restart it after source changes.

For persistent SQLite/Redis volumes and automatic process restarts, run:

```sh
docker compose up --build -d
docker compose logs -f worker
```

Compose exposes the API at `http://localhost:3000`, keeps Redis internal, enables
Redis persistence, and restarts the API/worker after crashes. SQLite and Redis data
live in named volumes. This setup shares a local SQLite file between the API and
worker on one host. `GET /healthz` checks API/SQLite availability.

## Authentication and access

The running server requires authentication. There is no public sign-up. On first
startup it creates one administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; the
password must contain at least 12 characters. Change the development defaults in
`.env` before sharing the application. Docker Compose requires `ADMIN_PASSWORD`
to be set explicitly:

```sh
ADMIN_PASSWORD='use-a-long-local-password' docker compose up --build -d
```

The administrator has all supported permissions and can open **Users** in the UI
to create seven-day, single-use invitation links with a limited permission set.
Email delivery, password recovery, SSO, custom roles, and account-deactivation UI
are deliberately outside this assessment implementation. A production system
would normally use the organization's identity provider.

Sessions are opaque random tokens stored as SHA-256 digests in SQLite and sent in
HTTP-only, SameSite=Strict cookies. Production cookies are marked Secure. Passwords
are salted and hashed with Node's scrypt implementation. API authorization is
enforced per permission; navigation visibility is only a usability aid. Audit
identity is taken from the authenticated session, so clients cannot impersonate
another updater using `X-Updated-By`.

Permissions are: `employee.read`, `employee.profile.update`, `salary.read`,
`salary.change.request`, `salary.change.approve`, `salary.change.apply`,
`payroll.read`, `payroll.manage`, `audit.read`, and `user.manage`.

## Upload employees

`POST /api/employees/imports` accepts one multipart field named `file`:

```sh
curl -X POST http://localhost:3000/api/employees/imports \
  -H 'Idempotency-Key: employee-upload-2026-09-19-001' \
  -H 'X-Updated-By: hr-42' \
  -F 'file=@examples/employees.csv'
```

The response is `202 Accepted`, with an import `id`, `status: "pending"`, and
`status_url`. Poll `GET /api/employees/imports/{id}` for `processed_rows`,
`total_rows`, `progress` (0–100), attempt count, and validation errors. Statuses
are `pending`, `validating`, `processing`, `retrying`, `completed`, and `failed`.
Validation happens in the worker, so an accepted upload may later become `failed`.

`Idempotency-Key` is optional (1–128 visible ASCII characters). Reusing a key with
the same file returns the original import with `200`; different content returns
`409`. Use a unique key per logical upload to safely retry an interrupted request.

- Formats: UTF-8 CSV and genuine `.xls` workbooks with exactly one worksheet.
  `.xlsx` is not accepted. Maximum file size: **10 MiB**.
- Maximum **10,000 employee rows**, excluding the required header. Empty files,
  invalid headers, duplicate IDs, and invalid values fail the entire validation.
- Headers must contain every `Employee` field exactly once, in any order:
  `id`, `first_name`, `last_name`, `email`, `phone`, `department`, `role`, `salary`,
  `status`, `country`, `joining_date`, `currency`, `last_updated_date`, `last_updated_by`.
- Text fields must be non-empty and at most 255 characters, without control
  characters. In Excel, format IDs and phone numbers as text to preserve zeros.
  Email must have an email address format. Phone accepts 7–15 digits, an optional
  leading `+`, spaces, parentheses, and hyphens.
- Salary must be non-negative with at most two decimal places. CSV salaries use
  plain decimal notation without currency symbols or thousands separators.
  Currency must be an uppercase ISO 4217 code such as `INR` or `USD`.
- Dates accept real `YYYY-MM-DD` dates, ISO timestamps with a timezone, or native
  Excel date cells. Workbook formulas/error cells are rejected. Department,
  role, status, and country are free-text values; no business-specific enum is assumed.

Errors report the row (header is row 1), field, and message, capped at 50 errors.
Missing uploads return `400`, oversized files `413`, unsupported extensions `415`.
Existing employee IDs, or IDs reserved by another import, cause validation failure;
imports never overwrite existing salary records.

Uploads are stored in SQLite before acknowledgment, even when Redis is unavailable.
The worker validates all rows first, then reserves IDs and stores normalized rows.
It inserts batches of 500 (configurable with `IMPORT_BATCH_SIZE`) and commits each
batch's employees, initial salary audit entries, and progress checkpoint together.
Completed batches survive restarts and are not inserted twice. Raw upload data is
released after validation; normalized rows are released after completion.

BullMQ retries temporary failures with backoff and recovers stalled jobs. A
reconciliation loop requeues unfinished SQLite imports if Redis loses a job or
BullMQ exhausts its retry budget. Temporary failures keep retrying; invalid data
stops with `failed` and requires a corrected upload. Compose provides process
restart; running `npm run worker` alone requires a supervisor or manual restart
after a process crash. Rows from completed batches can exist while an import is
still processing; salary updates wait until that employee's import completes.

## Audit log and notifications

Open **Notifications** in the frontend to review organization activity. Access to
both the page and `GET /api/audit-events` requires `audit.read` (included for the
administrator). This permission grants visibility into all audit details, including
salary values, employee changes, and invited users' permissions.

The append-only `audit_events` table is created automatically when the service or
worker opens the database. Each record includes an action, category, actor snapshot,
resource type/ID, summary, UTC timestamp, and structured metadata. It intentionally
keeps actor and resource references as snapshots rather than foreign keys so history
remains readable independently of the lifecycle of a user or business record.

Logged operations include import submission, committed batches, completion and
validation failure; employee/profile and salary changes with before/after values;
change requests and automated approval/rejection; payroll creation, generation,
approval, adjustments, payment recording and resulting period status changes; and
administrator creation, user invitations (including granted permissions), and account
activation. Every event commits in the same SQLite transaction as its business
operation. SQLite triggers prohibit updates/deletions. No-op edits, reused imports,
and repeat processing of terminal requests produce no duplicate success events.
Passwords, session/invitation tokens, and PDF contents are never audit metadata.

For PDF changes, the actor is the authenticated requester and the document's claimed
signatory is recorded separately as `proof_signatory`. Automatic review events use
`System` as their actor; PDF text does not establish an authenticated approval identity.

The read-only API accepts `page` (default 1), `limit` (default 25, maximum 100), and
optional `category`: `imports`, `employees`, `salaries`, `approvals`, `payroll`, or
`users`. Results are ordered by descending event ID and include pagination totals.
The Notifications page refreshes every 30 seconds on page one and provides a manual
Refresh button, filters, pagination, employee links, and expandable change details.

History starts when this feature is installed; earlier activity is not backfilled.
This is an in-app activity feed, without email/push delivery or unread tracking.
Internal worker retries, login/session housekeeping, and direct SQL maintenance or
development payroll seeds are outside the business-activity log. Existing salary
history and import records remain available separately. A database administrator
can alter SQLite itself; triggers protect application writes, not external tampering.

## Dashboard summary

`GET /api/dashboard` defaults to Global; `?country=India` scopes employee and
department counts, salary summaries, department totals, and statuses to that exact
country. `organization` always contains global counts, and `country_options` lists
all countries for the top-level selector. Repeated/empty country values and unrelated
query parameters are rejected. Summary aggregation ignores table pagination and
other employee-list filters. Responses use `Cache-Control: no-store`.

Raw `salaries` and `salary_by_department` groups retain their original currencies.
`compensation` supplies normalized total/average/department totals, reporting
currency, approximation flag, missing currencies, and rate-source metadata.
Global uses approximate USD; country views use local reporting currencies. For the
eight seeded countries, an explicit mapping (including common country codes) selects
the currency. Other countries use their sole recorded currency; ambiguous mixed
currencies return unavailable totals rather than guessing a local currency.

Conversion uses a checked-in [ECB reference-rate snapshot](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml)
dated **2026-09-18** in `src/exchange-rates.ts`. This assessment-level approach keeps
tests deterministic and avoids a live-rate API dependency. Rates require manual
updates and are not appropriate for payroll settlement. Each currency group is
converted before summing; averages divide by all scoped employees, not by currency
groups. All employment statuses count. Financial totals are rounded only after
aggregation. No employee salary records are rewritten. Missing rates yield null
total/average and an empty chart rather than partial totals; native-currency views
still work without a rate. An empty database returns zero counts/total, null average,
and empty group arrays.

## Generate mock employees and payroll history

Generate an employee import CSV:

```sh
npm run mock:data -- 5000 data/mock-employees.csv
```

After importing employees and starting the service once so the SQLite schema exists,
seed six completed historical months plus current and upcoming payroll directly into
the development database:

```sh
npm run mock:data -- --payroll-db data/salary.sqlite 6
```

The payroll seed includes full payments, partial payments, unpaid overdue salaries,
additions, deductions, and approved future payroll. It is idempotent and can safely
be run again without duplicating records. Use this only for local development data.

## Read and update employee details

`GET /api/employees/{id}` returns `{ employee }` or `404` for an unknown employee.
URL-encode the employee ID. `PATCH /api/employees/{id}` accepts any subset of
`first_name`, `last_name`, `email`, `phone`, `department`, `role`, `status`,
`country`, `joining_date`, `salary`, and `currency`, plus an optional salary-change
`reason`. Supply `X-Updated-By` and the employee's current `last_updated_date` as
`expected_last_updated_date`. A stale version returns `409`; invalid values return
`400`. ID and update metadata cannot be supplied as editable fields.

The response contains `employee`, `changed`, and `audit_id`. All changed fields
and any salary audit entry commit in a single transaction. Status/profile edits
update the server-managed timestamp and caller attribution without adding a salary
audit entry. An unchanged request leaves the record and history untouched. Edits
wait until the employee's import is complete. This endpoint uses the same existing
unauthenticated, caller-supplied attribution model as the salary endpoint.

## Change salary and read audit history

`PATCH /api/employees/{id}/salary` requires a JSON `salary` and the
`X-Updated-By` header. Optional fields are `currency`, `reason`, and
`expected_last_updated_date`:

```sh
curl -X PATCH http://localhost:3000/api/employees/EMP-DEMO-1/salary \
  -H 'Content-Type: application/json' \
  -H 'X-Updated-By: hr-42' \
  -d '{"salary":65000.75,"currency":"INR","reason":"Annual review"}'
```

The response includes `employee`, `changed`, and `audit_id`. The server automatically
sets `last_updated_date` and `last_updated_by`. The change and its audit record
commit in **one transaction**, preserving old/new salary and currency, prior update
metadata, timestamp, updater, and reason. Audit records are append-only, with SQLite
triggers rejecting updates/deletes. Each newly imported employee also gets an initial
audit entry. Existing databases upgrade automatically without resetting employee data;
older salaries without historical records remain available as the old value of the
next change.

Provide the employee's current `last_updated_date` as `expected_last_updated_date`
to reject stale edits with `409`. Unknown employees return `404`; invalid payloads
return `400`. Submitting the current salary/currency is a no-op and produces no
extra audit entry. Only salary/currency may be changed through this endpoint;
client-supplied `last_updated_date` and `last_updated_by` fields are rejected.

```sh
curl 'http://localhost:3000/api/employees/EMP-DEMO-1/salary-history?limit=50&offset=0'
```

History is newest first and includes `total`, `limit`, `offset`, and `changes`.
The maximum page size is 100. The existing `GET /api/employees` and
`GET /api/employees/filters` endpoints remain available.

## Verification

```sh
npm run build
npm test
npm run test:integration
```

Integration tests require `redis-server` on `PATH`. They launch an isolated Redis
instance on a temporary port and worker processes with a temporary SQLite database,
then terminate/restart them to check recovery without touching your running services.

## Automatic changelog

Run `npm install` after cloning. Its `prepare` script enables the repository's
versioned Git hooks. For an existing checkout, run `npm run hooks:install`.
Node.js and Git must be available when committing.

Commit normally:

```sh
git add src/
git commit -m "feat: add salary summaries"
```

After each successful local commit, the `post-commit` hook refreshes the generated
**Commit history** section in `changelog.md` using the current branch's reachable
history. Entries include the subject, UTC commit date, and short hash, newest first.
Amendments replace the old history entry, and repeated runs produce no duplicates.
Commits that change only `changelog.md` are excluded by their changed files,
regardless of the commit message. Committing the generated update therefore leaves
the changelog clean. Commits that also change other files are still recorded.

The update remains **unstaged in your working tree**. Include it in a later commit
when desired. The hook never creates extra commits or rewrites existing ones.
Manual changelog content outside the generated markers is preserved, as are staged
changes and unrelated files. Do not edit inside the generated markers by hand.

To refresh history manually, including after switching branches, pulling, rebasing,
or fetching commits created elsewhere:

```sh
npm run changelog:update
```

Each clone must enable the hooks. Installs using `--ignore-scripts` require
`npm run hooks:install`. The installer refuses to replace a different configured
hooks path; integrate the changelog command into those hooks if you already use one.
The post-commit hook also runs for empty commits and `git commit --no-verify`.
If an update fails, the commit still succeeds; fix the reported issue and run the
manual refresh command.

Run `npm test` to verify the automation in temporary Git repositories.
