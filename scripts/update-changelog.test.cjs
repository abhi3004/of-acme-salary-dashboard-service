const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const source = path.resolve(__dirname, '..');
const initialChangelog =
  '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Existing note.\n';
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
]) {
  delete env[key];
}

function repository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'salary-changelog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const git = (...args) => run('git', args);
  const write = (name, content) =>
    writeFileSync(path.join(root, name), content);
  const read = (name) => readFileSync(path.join(root, name), 'utf8');
  git('init', '--quiet');
  git('config', 'user.name', 'Changelog Test');
  git('config', 'user.email', 'changelog@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  cpSync(path.join(source, '.githooks'), path.join(root, '.githooks'), {
    recursive: true,
  });
  chmodSync(path.join(root, '.githooks', 'post-commit'), 0o755);
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['install-git-hooks.cjs', 'update-changelog.cjs']) {
    cpSync(
      path.join(source, 'scripts', file),
      path.join(root, 'scripts', file),
    );
  }
  write('changelog.md', initialChangelog);
  write('app.txt', 'initial\n');
  git('add', '.');
  run(process.execPath, ['scripts/install-git-hooks.cjs']);
  return { root, run, git, write, read };
}

test('records successful commits with hash and date while preserving manual notes', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: add *salary* <summary>');
  const hash = repo.git('rev-parse', '--short', 'HEAD').trim();
  const changelog = repo.read('changelog.md');
  assert.match(
    changelog,
    /- \d{4}-\d{2}-\d{2}: feat: add \\\*salary\\\* \\<summary\\>/,
  );
  assert.ok(changelog.includes(`(\`${hash}\`)`));
  assert.ok(changelog.startsWith(initialChangelog));
  assert.equal(repo.git('show', 'HEAD:changelog.md'), initialChangelog);
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  assert.equal(repo.git('status', '--short'), ' M changelog.md\n');
});

test('lists history newest first without duplication across refreshes or commits', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: first commit');
  repo.write('app.txt', 'second\n');
  repo.git('add', 'app.txt', 'changelog.md');
  repo.git('commit', '-m', 'fix: second commit');
  const changelog = repo.read('changelog.md');
  assert.ok(
    changelog.indexOf('fix: second commit') <
      changelog.indexOf('feat: first commit'),
  );
  assert.equal((changelog.match(/## Commit history/g) || []).length, 1);
  repo.run(process.execPath, ['scripts/update-changelog.cjs']);
  assert.equal(repo.read('changelog.md'), changelog);
  assert.equal(repo.git('rev-list', '--count', 'HEAD').trim(), '2');
});

test('committing only the changelog leaves a clean checkout and stays excluded on later refreshes', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: initial');
  const generated = repo.read('changelog.md');
  repo.git('add', 'changelog.md');
  repo.git('commit', '-m', 'save generated history');
  assert.equal(repo.read('changelog.md'), generated);
  assert.equal(repo.git('status', '--short'), '');

  // Use a changelog-like subject for a real code change to verify path filtering.
  repo.write('app.txt', 'updated\n');
  repo.write('changelog.md', generated + '\nManual release note.\n');
  repo.git('add', 'app.txt', 'changelog.md');
  repo.git('commit', '-m', 'changelog added');
  const updated = repo.read('changelog.md');
  assert.match(updated, /changelog added/);
  assert.ok(!updated.includes('save generated history'));
  assert.ok(updated.endsWith('Manual release note.\n'));

  repo.git('add', 'changelog.md');
  repo.git('commit', '-m', 'save generated history again');
  repo.run(process.execPath, ['scripts/update-changelog.cjs']);
  assert.equal(repo.read('changelog.md'), updated);
  assert.equal(repo.git('status', '--short'), '');
});

test('refresh removes previously generated changelog-only entries', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: initial');
  repo.git('add', 'changelog.md');
  repo.git('commit', '-m', 'save generated history');
  const clean = repo.read('changelog.md');
  const hash = repo.git('rev-parse', '--short', 'HEAD').trim();
  repo.write(
    'changelog.md',
    clean.replace(
      '## Commit history\n',
      `## Commit history\n\n- 2026-09-18: save generated history (\`${hash}\`)\n`,
    ),
  );
  repo.run(process.execPath, ['scripts/update-changelog.cjs']);
  assert.equal(repo.read('changelog.md'), clean);
  assert.equal(repo.git('status', '--short'), '');
});

test('keeps manual edits and does not alter staged or unrelated working files', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: initial');
  const stagedChangelog = repo.read('changelog.md') + '\nManual staged note.\n';
  repo.write('changelog.md', stagedChangelog);
  repo.git('add', 'changelog.md');
  repo.write('changelog.md', stagedChangelog + '\nManual unstaged note.\n');
  repo.write('later.txt', 'next commit\n');
  repo.git('add', 'later.txt');
  repo.write('app.txt', 'updated\n');
  repo.git('commit', '-m', 'feat: partial commit', '--only', 'app.txt');
  assert.match(repo.read('changelog.md'), /feat: partial commit/);
  assert.ok(
    repo
      .read('changelog.md')
      .endsWith('Manual staged note.\n\nManual unstaged note.\n'),
  );
  assert.equal(repo.git('show', ':changelog.md'), stagedChangelog);
  assert.equal(
    repo.git('diff', '--cached', '--name-only'),
    'changelog.md\nlater.txt\n',
  );
  assert.equal(repo.read('later.txt'), 'next commit\n');
});

test('amend replaces the prior commit entry and records empty commits', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: old subject');
  repo.git('commit', '--amend', '-m', 'feat: corrected subject');
  assert.match(repo.read('changelog.md'), /feat: corrected subject/);
  assert.ok(!repo.read('changelog.md').includes('feat: old subject'));
  repo.git(
    'commit',
    '--allow-empty',
    '--no-verify',
    '-m',
    'chore: empty commit',
  );
  assert.match(repo.read('changelog.md'), /chore: empty commit/);
});

test('failed commits leave the changelog unchanged', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: initial');
  const before = repo.read('changelog.md');
  const result = spawnSync('git', ['commit', '-m', 'nothing staged'], {
    cwd: repo.root,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(repo.read('changelog.md'), before);
});

test('rejects malformed generated markers without modifying the file', (t) => {
  const repo = repository(t);
  repo.git('commit', '-m', 'feat: initial');
  const malformed =
    initialChangelog + '\n<!-- changelog:commits:start -->\nDraft\n';
  repo.write('changelog.md', malformed);
  const result = spawnSync(process.execPath, ['scripts/update-changelog.cjs'], {
    cwd: repo.root,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /markers/);
  assert.equal(repo.read('changelog.md'), malformed);
});

test('does not overwrite a different configured hooks path', (t) => {
  const repo = repository(t);
  repo.git('config', 'core.hooksPath', 'custom-hooks');
  const result = spawnSync(
    process.execPath,
    ['scripts/install-git-hooks.cjs'],
    {
      cwd: repo.root,
      env,
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(
    repo.git('config', '--get', 'core.hooksPath').trim(),
    'custom-hooks',
  );
});
