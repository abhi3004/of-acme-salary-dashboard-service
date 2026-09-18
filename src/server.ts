import config from './config/config';
import { Store } from './database/store';
import { createApp } from './app';

const store = new Store(config.databasePath);
const server = createApp(store).listen(config.port, () => {
  console.log(`Salary service listening on port ${config.port}`);
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.on('error', (error) => { console.error(error); store.close(); process.exit(1); });
