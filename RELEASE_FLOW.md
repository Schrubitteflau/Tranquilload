# Release Flow

Both packages (`@tranquilload/core` and `@tranquilload/adapters`) are versioned together via [Changesets](https://github.com/changesets/changesets).

**Prerequisite:** `NPM_TOKEN` secret must be set in GitHub → Settings → Secrets and variables → Actions.

---

## Steps

### 1. Create a changeset (in your feature branch)

```bash
pnpm changeset
```

Interactive CLI: select affected packages, bump type (`patch` / `minor` / `major`), and describe the change. This generates a file in `.changeset/`.

```bash
git add .changeset/
git commit -m "chore: add changeset"
git push
```

### 2. Merge your PR to `master`

The `release.yml` workflow triggers automatically.

### 3. Changesets opens a "Version Packages" PR (automatic)

`changesets/action@v1` detects the changeset files, runs `changeset version`, and opens a PR that contains:

- version bumps in both `package.json` files
- generated `CHANGELOG.md` entries per package

Nothing to do on your end.

### 4. Merge the "Version Packages" PR

The `release.yml` workflow triggers again. No changesets remain → publish mode:

1. Builds all packages (`pnpm turbo build`)
2. Publishes to npm (`pnpm changeset publish`)
3. Creates GitHub Releases with the CHANGELOG entries

---

## Summary

| Step                            | Who            | Action                                          |
| ------------------------------- | -------------- | ----------------------------------------------- |
| Create changeset                | You            | `pnpm changeset`                                |
| Commit + push                   | You            | `git add .changeset/ && git commit && git push` |
| Open "Version Packages" PR      | GitHub Actions | automatic                                       |
| Merge version PR                | You            | merge on GitHub                                 |
| Publish to npm + GitHub Release | GitHub Actions | automatic                                       |

---

## No changeset in a PR?

Merging a PR without a changeset file is valid — the workflow runs but does nothing. Use this for docs, CI, or refactor PRs that don't warrant a release.
