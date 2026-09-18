import type { Store } from '../database/store';
import { parseEmployees, ValidationError } from './validation';

export async function processImport(store: Store, id: string, batchSize: number, afterBatch?: (processed: number) => Promise<void>) {
  let record = store.getImport(id);
  if (!record || ['completed', 'failed'].includes(record.status)) return;
  try {
    store.beginAttempt(id);
    if (record.total_rows === null) {
      store.prepareRows(id, parseEmployees(store.getFile(id), record.extension));
    }
    while (true) {
      record = store.insertBatch(id, batchSize);
      if (afterBatch) await afterBatch(record.processed_rows);
      if (['completed', 'failed'].includes(record.status)) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      store.failValidation(id, error);
      return;
    }
    store.retryLater(id);
    throw error;
  }
}
