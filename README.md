# Salary dashboard service

## Automatic changelog

Run `npm install` after cloning. Its `prepare` script enables the repository's
versioned Git hooks. For an existing checkout, run `npm run hooks:install`.
Node.js and Git must be available when committing.

Commit normally:

```sh
git add src/
git commit -m "feat: add salary summaries"
```

After each successful local commit, the `post-commit` hook refreshes the generated
**Commit history** section in `changelog.md` using the current branch's reachable
history. Entries include the subject, UTC commit date, and short hash, newest first.
Amendments replace the old history entry, and repeated runs produce no duplicates.
Commits that change only `changelog.md` are excluded by their changed files,
regardless of the commit message. Committing the generated update therefore leaves
the changelog clean. Commits that also change other files are still recorded.

The update remains **unstaged in your working tree**. Include it in a later commit
when desired. The hook never creates extra commits or rewrites existing ones.
Manual changelog content outside the generated markers is preserved, as are staged
changes and unrelated files. Do not edit inside the generated markers by hand.

To refresh history manually, including after switching branches, pulling, rebasing,
or fetching commits created elsewhere:

```sh
npm run changelog:update
```

Each clone must enable the hooks. Installs using `--ignore-scripts` require
`npm run hooks:install`. The installer refuses to replace a different configured
hooks path; integrate the changelog command into those hooks if you already use one.
The post-commit hook also runs for empty commits and `git commit --no-verify`.
If an update fails, the commit still succeeds; fix the reported issue and run the
manual refresh command.

Run `npm test` to verify the automation in temporary Git repositories.
