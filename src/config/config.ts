import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ quiet: true });

function integer(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

const config = {
  port: integer('PORT', 3000, 65535),
  nodeEnv: process.env.NODE_ENV || 'development',
  databasePath: path.resolve(process.env.DATABASE_PATH || 'data/salary.sqlite'),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  queueName: 'employee-imports',
  batchSize: integer('IMPORT_BATCH_SIZE', 500, 1000),
  dispatchIntervalMs: integer('IMPORT_DISPATCH_INTERVAL_MS', 5000, 60000),
  maxUploadBytes: 10 * 1024 * 1024,
};

export default config;
