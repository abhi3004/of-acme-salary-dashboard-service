import { Worker } from 'bullmq';
import path from 'node:path';
import config from './config/config';
import { Store } from './database/store';
import { createImportQueue, dispatchPending } from './imports/queue';

const store = new Store(config.databasePath);
const queue = createImportQueue(config.redisUrl, config.queueName);
const worker = new Worker(config.queueName, path.join(__dirname, 'imports/processor.js'), {
  connection: { url: config.redisUrl, maxRetriesPerRequest: null },
  concurrency: 1,
  maxStalledCount: 3,
  lockDuration: 30_000,
  stalledInterval: 30_000,
});
worker.on('error', (error) => console.error('Worker connection error:', error.message));
worker.on('failed', (job, error) => console.error(`Import job ${job?.id} failed:`, error.message));
queue.on('error', (error) => console.error('Queue connection error:', error.message));
let stopping = false;
let dispatching: Promise<void> | undefined;
function reconcile() {
  if (stopping || dispatching) return;
  dispatching = dispatchPending(store, queue)
    .catch((error: Error) => console.error('Import dispatch will retry:', error.message))
    .finally(() => { dispatching = undefined; });
}
const interval = setInterval(reconcile, config.dispatchIntervalMs);
queue.waitUntilReady().then(reconcile).catch((error: Error) => console.error('Waiting for Redis:', error.message));
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  const timeout = setTimeout(() => process.exit(1), 30_000);
  timeout.unref();
  await dispatching;
  await worker.close();
  await queue.close();
  store.close();
  clearTimeout(timeout);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
console.log('Employee import worker started.');
