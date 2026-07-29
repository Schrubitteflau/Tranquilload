// Copies the monorepo README + LICENSE into the package being packed.
//
// Wired into each published package's `prepack` hook. npm/pnpm only
// force-include README and LICENSE when they exist *in the package directory*,
// and ours live at the repo root — without this, published tarballs ship
// neither (verified on 0.1.7 and 0.1.8).
//
// The copies are gitignored; they reach the tarball because they are listed in
// each package's `files` field, which is what overrides .gitignore under
// pnpm >= 11. Check any packaging change with `pnpm pack && tar -tzf <tgz>`.
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.cwd();

for (const file of ["README.md", "LICENSE"]) {
  copyFileSync(join(repoRoot, file), join(packageDir, file));
}

console.log(`copy-package-docs: README.md + LICENSE -> ${packageDir}`);
