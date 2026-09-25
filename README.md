# Acme Salary Dashboard Service

The backend API and background import worker for the Acme salary management
workspace. It stores employee and payroll data, authenticates users, enforces
permissions, processes employee imports, and records an audit trail.

## A. Run the project and set up the environment

### Requirements

- Node.js 22.13 or newer (Node.js 24 is recommended)
- npm
- Redis on `redis://127.0.0.1:6379`, or another reachable Redis URL
- No separate SQL server: the project uses SQLite

Install the dependencies and create the local environment file:

```sh
npm install
cp .env.example .env
```

Review `.env` before starting:

```dotenv
PORT=3000
NODE_ENV=development
DATABASE_PATH=./data/salary.sqlite
REDIS_URL=redis://127.0.0.1:6379
IMPORT_BATCH_SIZE=500
IMPORT_DISPATCH_INTERVAL_MS=5000
ADMIN_EMAIL=admin@acme.test
ADMIN_PASSWORD=ChangeMe123!
```

Start Redis, then use separate terminals for the API and worker:

```sh
# Terminal 1: API with source watching
npm run dev

# Terminal 2: compile the worker, then run it
npm run build
npm run worker
```

The API is available at `http://localhost:3000`. Check it with:

```sh
curl http://localhost:3000/healthz
```

You can also start the frontend, backend, and worker together from the parent
`Salary-Management-Software` directory:

```sh
npm run dev
```

The API and worker must use the same `DATABASE_PATH` and `REDIS_URL`. The worker
runs compiled code, so rebuild and restart it after worker source changes.

### Generate sample employee data

From the parent workspace directory:

```sh
npm run generate:csv -- 5000 mock-employees-5000.csv
```

The file contains 90% active, 6% inactive, and 4% on-leave employees. From this
repository alone, the equivalent command is:

```sh
npm run mock:data -- 5000 mock-employees-5000.csv
```

## B. Tech stack

- Node.js and TypeScript
- Express 5 REST API
- SQLite through Node's built-in `node:sqlite` driver
- BullMQ and Redis for background employee imports
- Multer for file uploads
- `csv-parse` and SheetJS for CSV and XLS parsing
- PDFKit and `pdf-parse` for change-request proof documents
- Node's test runner, TSX, and Supertest for automated tests
- Docker for production-style builds

## C. Credentials

On the first authenticated startup, the service creates one administrator from
`ADMIN_EMAIL` and `ADMIN_PASSWORD`. The example development credentials are:

```text
Email: admin@acme.test
Password: ChangeMe123!
```

Set a unique password of at least 12 characters for any shared or production
environment. Production startup fails if the administrator credentials are
missing. Keep the real values in your host's secret manager or environment
settings, not in Git.

Redis credentials, when required by the Redis provider, belong in `REDIS_URL`.
The SQLite database is a local file and does not use a username or password;
protect the file and its volume with operating-system and hosting permissions.

## D. Authentication setup

- Passwords are salted and hashed with Node's `scrypt` implementation.
- Successful login creates a random session token. Only its SHA-256 digest is
  stored in SQLite.
- The `acme_session` cookie is HTTP-only, `SameSite=Strict`, valid for 12 hours,
  and `Secure` when `NODE_ENV=production`.
- The first administrator receives all permissions.
- Administrators can create seven-day, single-use invitation links and select
  the new user's permissions.
- The API enforces permissions for employee, salary, payroll, audit, import, and
  user-management routes.

There is no public sign-up, email delivery, password recovery, SSO, or custom
role editor. If the frontend and API are deployed separately, route frontend
`/api/*` requests through the same public origin so the strict session cookie
works correctly.

## E. Main functions and purpose

- Authenticate users and manage permission-based invitations
- List, filter, sort, paginate, create, and update employee records
- Import CSV and XLS employee files in resumable batches
- Track import progress and recover queued work after restarts
- Calculate dashboard salary, department, country, and employee summaries
- Keep salary history and process profile or salary change requests
- Read PDF proof and support approval or rejection workflows
- Create payroll periods, calculate employee payroll, record adjustments, and
  record full or partial payments
- Keep an append-only audit feed for important business changes
- Expose `/healthz` for API and SQLite health checks

Imports accept at most 10,000 employee rows and 10 MiB per file. The worker
validates the full file before inserting rows and writes batches transactionally.
Use synthetic data for local development; salary and audit information is
sensitive.

## F. AI skills used

The following Codex skills were installed as development guidance:

- `javascript-testing-patterns` — API, database, and boundary testing
- `e2e-testing-patterns` — end-to-end workflow guidance
- `web-design-guidelines` — accessibility and interface review guidance
- `responsive-design` — responsive frontend guidance shared with this workspace
- `security-best-practices` — Express, authentication, and data-security reviews

They are not application dependencies or proof of a completed audit. Sources,
pinned revisions, and usage notes are recorded in
[`docs/AI_SKILLS.md`](docs/AI_SKILLS.md).

## G. Tests and simple CI/CD

Run the main checks locally:

```sh
npm test
npm run build
```

Run the slower integration suite separately:

```sh
npm run test:integration
```

Tests use isolated data and should never point at a real employee database.

There is no GitHub Actions workflow checked in today. A simple CI job should run
on pull requests and execute:

1. Check out the repository.
2. Set up Node.js 24 with npm caching.
3. Start a Redis service container.
4. Run `npm ci`.
5. Run `npm test`, `npm run build`, and `npm run test:integration`.
6. Build the Docker image to catch packaging errors.

For delivery, build and deploy the included `Dockerfile`. Run the API image with
`node dist/server.js` and the worker from the same image with
`node dist/worker.js`. Both deployments need the same Redis service and shared,
persistent SQLite storage. Set production environment variables and secrets in
the hosting platform, run CI before deployment, and check `/healthz` afterward.

The repository also contains a Vercel server entry, but the long-running BullMQ
worker and persistent SQLite file need infrastructure that supports background
processes and durable storage. A container host is the simpler production model
for the complete service.
