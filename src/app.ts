import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import path from 'node:path';
import config from './config/config';
import { IdempotencyConflict, type Store, type ImportRecord } from './database/store';

class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function importResponse(record: ImportRecord) {
  return {
    id: record.id, filename: record.filename, status: record.status,
    total_rows: record.total_rows, processed_rows: record.processed_rows,
    progress: record.total_rows ? Math.floor(record.processed_rows / record.total_rows * 100) : 0,
    attempts: record.attempts,
    error: record.error_json ? JSON.parse(record.error_json) : null,
    created_at: record.created_at, updated_at: record.updated_at,
    status_url: `/api/employees/imports/${record.id}`,
  };
}

export function createApp(store: Store, maxUploadBytes = config.maxUploadBytes) {
  const app = express();
  app.disable('x-powered-by');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, callback) => {
      if (!['.csv', '.xls'].includes(path.extname(file.originalname).toLowerCase())) {
        callback(new HttpError(415, 'Only .csv and .xls files are accepted.'));
      } else callback(null, true);
    },
  });
  app.get('/healthz', (_req, res) => {
    store.db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  });
  app.post('/api/employees/imports', upload.single('file'), (req, res) => {
    if (!req.file?.size) throw new HttpError(400, 'Upload one non-empty file using the multipart field "file".');
    const key = req.get('Idempotency-Key') ?? null;
    if (key !== null && (!/^[\x21-\x7e]{1,128}$/.test(key))) throw new HttpError(400, 'Idempotency-Key must contain 1–128 visible ASCII characters.');
    const filename = path.basename(req.file.originalname).slice(0, 255);
    const result = store.createImport(filename, path.extname(filename).toLowerCase(), req.file.buffer, key);
    const body = importResponse(result.record);
    res.status(result.reused ? 200 : 202).location(body.status_url).json({ ...body, reused: result.reused });
  });
  app.get('/api/employees/imports/:id', (req, res) => {
    const record = store.getImport(req.params.id as string);
    if (!record) throw new HttpError(404, 'Import not found.');
    res.set('Cache-Control', 'no-store').json(importResponse(record));
  });
  app.use((_req, res) => { res.status(404).json({ error: { message: 'Route not found.' } }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      res.status(tooLarge ? 413 : 400).json({ error: { code: error.code, message: tooLarge ? `File size exceeds ${maxUploadBytes} bytes.` : 'Upload exactly one file in the "file" field, without additional form fields.' } });
    } else if (error instanceof HttpError || error instanceof IdempotencyConflict) {
      res.status(error instanceof HttpError ? error.status : 409).json({ error: { message: error.message } });
    } else {
      console.error('Request failed:', error);
      res.status(503).json({ error: { message: 'Storage is temporarily unavailable. Retry with the same Idempotency-Key.' } });
    }
  };
  app.use(errors);
  return app;
}
