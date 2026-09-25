// of-acme-salary-dashboard-service/api/index.ts
import config from '../src/config/config';
import { Store } from '../src/database/store';
import { createApp } from '../src/app';

// Use /tmp on Vercel serverless environment if using file-based SQLite
const dbPath = process.env.DATABASE_PATH || '/tmp/salary.sqlite';
const store = new Store(dbPath);

const app = createApp(store, config.maxUploadBytes, {
    enabled: true,
    adminEmail: config.adminEmail,
    adminPassword: config.adminPassword,
    secureCookies: config.nodeEnv === 'production',
});

export default app;
