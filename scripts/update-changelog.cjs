const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const changelogPath = path.join(root, 'changelog.md');
const start = '<!-- changelog:commits:start -->';
const end = '<!-- changelog:commits:end -->';
const escapeMarkdown = (text) => text.replace(/[\\`*_[\]<>]/g, '\\$&');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });

function changesOnlyChangelog(hash) {
  const files = git(
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '--no-renames',
    '--diff-merges=first-parent',
    '-r',
    '-z',
    hash,
    '--',
  )
    .split('\0')
    .filter(Boolean);
  // Keep empty commits and commits that also change other files. Compare paths,
  // not subjects, so this works with any commit message.
  return files.length > 0 && files.every((file) => file === 'changelog.md');
}

try {
  const original = readFileSync(changelogPath, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const startIndex = original.indexOf(start);
  const endIndex = original.indexOf(end);
  const hasMarkers = startIndex !== -1 || endIndex !== -1;
  if (
    hasMarkers &&
    (startIndex === -1 ||
      endIndex < startIndex ||
      original.indexOf(start, startIndex + start.length) !== -1 ||
      original.indexOf(end, endIndex + end.length) !== -1)
  ) {
    throw new Error(
      'The generated commit-history markers are missing, duplicated, or out of order.',
    );
  }

  const history = git(
    'log',
    '--date-order',
    '--format=%H%x00%h%x00%cI%x00%s',
    'HEAD',
    '--',
  );
  const entries = history
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((record) => record.split('\0'))
    // Filter all history so later refreshes cannot bring these entries back.
    .filter(([fullHash]) => !changesOnlyChangelog(fullHash))
    .map(([, hash, timestamp, subject]) => {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      return `- ${date}: ${escapeMarkdown(subject)} (\`${hash}\`)`;
    });
  const generated = [
    start,
    '',
    '## Commit history',
    '',
    ...entries,
    '',
    end,
  ].join(eol);
  const updated = hasMarkers
    ? original.slice(0, startIndex) +
      generated +
      original.slice(endIndex + end.length)
    : original +
      (original.endsWith(eol + eol)
        ? ''
        : original.endsWith(eol)
          ? eol
          : eol + eol) +
      generated +
      eol;

  // Only the working file changes. Never alter the index or rewrite a commit.
  if (updated !== original) writeFileSync(changelogPath, updated);
} catch (error) {
  console.error(`Changelog update failed: ${error.message}`);
  console.error(
    'Fix the issue and run npm run changelog:update. Existing commits are unaffected.',
  );
  process.exitCode = 1;
}
