import { Queue } from 'bullmq';
import type { Store } from '../database/store';

export function createImportQueue(redisUrl: string, queueName: string) {
  return new Queue(queueName, {
    connection: { url: redisUrl, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000 },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 1000 },
    },
  });
}

// SQLite is the durable source of work. Reconcile it with Redis on every restart
// and periodically, including after Redis data loss or exhausted BullMQ retries.
export async function dispatchPending(store: Store, queue: Queue) {
  for (const record of store.pendingImports()) {
    const job = await queue.getJob(record.id);
    if (!job) {
      await queue.add('import-employees', { importId: record.id }, { jobId: record.id });
    } else {
      const state = await job.getState();
      if (state === 'failed' || state === 'completed') {
        await job.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true });
      }
    }
  }
}
