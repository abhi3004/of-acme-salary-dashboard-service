import { UnrecoverableError, type Job } from 'bullmq';
import config from '../config/config';
import { Store } from '../database/store';
import { processImport } from './process-import';

// BullMQ runs this processor in a child process so parsing cannot block lock renewal.
export default async function processor(job: Job<{ importId: string }>) {
  const store = new Store(config.databasePath);
  try {
    await processImport(store, job.data.importId, config.batchSize);
    if (store.getImport(job.data.importId)?.status === 'failed') {
      throw new UnrecoverableError('Import validation failed; see the import status for row errors.');
    }
  }
  finally { store.close(); }
}
