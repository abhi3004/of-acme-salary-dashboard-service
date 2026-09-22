import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { Worker } from 'bullmq';
import { Store } from '../../src/database/store';
import { createApp } from '../../src/app';
import { createImportQueue, dispatchPending } from '../../src/imports/queue';
import { processImport } from '../../src/imports/process-import';
import { csv, employee } from '../helpers';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeout = 20_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for integration test condition.');
}
async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  group = false,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (group && process.platform !== 'win32') process.kill(-child.pid!, signal);
  else child.kill(signal);
  await exited;
}

test(
  'real Redis and worker recover a durable upload after worker termination and Redis data loss',
  { timeout: 90_000 },
  async (t) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'salary-worker-integration-'),
    );
    const filename = path.join(directory, 'salary.sqlite');
    const store = new Store(filename);
    const port = await freePort();
    const url = `redis://127.0.0.1:${port}`;
    const children: { child: ChildProcess; group: boolean }[] = [];
    let logs = '';
    const capture = (child: ChildProcess) => {
      child.stdout?.on('data', (data) => {
        logs = (logs + data.toString()).slice(-20_000);
      });
      child.stderr?.on('data', (data) => {
        logs = (logs + data.toString()).slice(-20_000);
      });
    };
    t.after(async () => {
      for (const { child, group } of children.reverse())
        await stop(child, 'SIGKILL', group);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    async function startRedis() {
      const child = spawn(
        'redis-server',
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--save',
          '',
          '--appendonly',
          'no',
          '--dir',
          directory,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push({ child, group: false });
      capture(child);
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`Redis exited with ${code}: ${logs}`)),
        );
        child.stdout!.on('data', (data) => {
          if (data.toString().includes('Ready to accept connections'))
            resolve();
        });
      });
      return child;
    }
    function startWorker(batchSize: number) {
      const child = spawn(process.execPath, ['dist/worker.js'], {
        cwd: path.resolve(__dirname, '../..'),
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          DATABASE_PATH: filename,
          REDIS_URL: url,
          IMPORT_BATCH_SIZE: String(batchSize),
          IMPORT_DISPATCH_INTERVAL_MS: '1000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push({ child, group: true });
      capture(child);
      return child;
    }
    try {
      // Redis is intentionally unavailable while the API durably accepts the file.
      const app = createApp(store);
      const response = await request(app)
        .post('/api/employees/imports')
        .attach(
          'file',
          csv(Array.from({ length: 3000 }, (_, index) => employee(index))),
          'employees.csv',
        )
        .expect(202);
      const id = response.body.id as string;
      assert.equal(store.getImport(id)!.status, 'pending');
      const redis = await startRedis();
      const worker = startWorker(1);
      await waitFor(() => {
        const record = store.getImport(id)!;
        return record.processed_rows >= 10 && record.processed_rows < 3000;
      });
      await stop(worker, 'SIGKILL', true);
      const checkpoint = store.getImport(id)!.processed_rows;
      assert.ok(
        checkpoint > 0 && checkpoint < 3000,
        `Expected partial progress, got ${checkpoint}`,
      );
      // Losing Redis must not lose the accepted upload or its SQLite checkpoint.
      await stop(redis);
      await startRedis();
      const recoveredWorker = startWorker(500);
      await waitFor(() => store.getImport(id)!.status === 'completed');
      assert.equal(store.getImport(id)!.processed_rows, 3000);
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM employees').get()!.n,
        3000,
      );
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM salary_changes').get()!.n,
        3000,
      );

      const invalid = await request(app)
        .post('/api/employees/imports')
        .attach('file', csv([{ ...employee(4000), salary: -1 }]), 'invalid.csv')
        .expect(202);
      await waitFor(
        () => store.getImport(invalid.body.id)!.status === 'failed',
      );
      const status = await request(app)
        .get(invalid.body.status_url)
        .expect(200);
      assert.equal(status.body.error.code, 'VALIDATION_ERROR');
      assert.equal(status.body.processed_rows, 0);

      await stop(recoveredWorker, 'SIGTERM', true);
      const queue = createImportQueue(url, 'employee-imports');
      queue.on('error', () => {});
      await queue.waitUntilReady();
      try {
        const completedJob = await queue.getJob(id);
        assert.ok(completedJob);
        // Reconciliation is idempotent after completion.
        await dispatchPending(store, queue);
        assert.equal(store.getImport(id)!.processed_rows, 3000);

        // Exhaust the BullMQ retry budget, then let reconciliation restart the job.
        const retryId = store.createImport(
          'retry.csv',
          '.csv',
          csv([employee(5000)]),
          null,
        ).record.id;
        let firstAttempt = true;
        const retryWorker = new Worker(
          'employee-imports',
          async (job) => {
            if (firstAttempt) {
              firstAttempt = false;
              throw new Error('simulated temporary failure');
            }
            await processImport(store, job.data.importId, 500);
          },
          { connection: { url, maxRetriesPerRequest: null } },
        );
        try {
          const retryJob = await queue.add(
            'import-employees',
            { importId: retryId },
            { jobId: retryId, attempts: 1 },
          );
          await waitFor(async () => (await retryJob.getState()) === 'failed');
          await dispatchPending(store, queue);
          await waitFor(() => store.getImport(retryId)!.status === 'completed');
        } finally {
          await retryWorker.close();
        }

        // Simulate a worker that stops renewing its lock midway through a batch run.
      const stalledId = store.createImport(
          'stalled.csv',
          '.csv',
          csv([employee(6000), employee(6001)]),
          null,
      ).record.id;
      const stalledQueue = createImportQueue(url, 'employee-stall-recovery');
      stalledQueue.on('error', () => {});
      await stalledQueue.waitUntilReady();
      let paused = false;
      const stalledWorker = new Worker(
        'employee-stall-recovery',
          async (job) => {
            await processImport(store, job.data.importId, 1, async () => {
              paused = true;
              await new Promise<void>(() => {});
            });
          },
          {
            connection: { url, maxRetriesPerRequest: null },
            lockDuration: 300,
            stalledInterval: 200,
          },
        );
      await dispatchPending(store, stalledQueue);
        await waitFor(() => paused);
        await stalledWorker.close(true);
      const replacement = new Worker(
        'employee-stall-recovery',
          async (job) => {
            await processImport(store, job.data.importId, 500);
          },
          {
            connection: { url, maxRetriesPerRequest: null },
            lockDuration: 300,
            stalledInterval: 200,
          },
        );
        try {
          await waitFor(
            () => store.getImport(stalledId)!.status === 'completed',
          );
          assert.equal(store.getImport(stalledId)!.processed_rows, 2);
          assert.equal(store.salaryHistory('EMP-6000', 50, 0).total, 1);
      } finally {
        await replacement.close();
        await stalledQueue.close();
      }
      } finally {
        await queue.close();
      }
    } catch (error) {
      throw new Error(`${(error as Error).message}\nWorker logs:\n${logs}`, {
        cause: error,
      });
    }
  },
);
