const { execFileSync } = require('node:child_process');
const { chmodSync, realpathSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();

let gitRoot;
try {
  gitRoot = git('rev-parse', '--show-toplevel');
} catch {
  console.log('Skipping Git hook installation outside a Git checkout.');
  process.exit(0);
}

// Do not configure a parent repository when installing from a source archive.
if (realpathSync(gitRoot) !== realpathSync(root)) {
  console.log('Skipping Git hook installation outside the service repository.');
  process.exit(0);
}

let existingHooksPath;
try {
  existingHooksPath = git('config', '--get', 'core.hooksPath');
} catch (error) {
  if (error.status !== 1) throw error;
}

if (existingHooksPath && existingHooksPath !== '.githooks') {
  console.error(
    `Git already uses hooks at ${existingHooksPath}. Integrate the changelog hook there before changing core.hooksPath.`,
  );
  process.exit(1);
}

chmodSync(path.join(root, '.githooks', 'post-commit'), 0o755);
git('config', '--local', 'core.hooksPath', '.githooks');
console.log('Automatic changelog updates enabled for this checkout.');
