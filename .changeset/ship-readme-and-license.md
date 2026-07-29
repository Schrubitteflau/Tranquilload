---
"@tranquilload/core": patch
"@tranquilload/adapters": patch
---

Ship `README.md` and `LICENSE` in the published tarballs.

Neither file had ever reached npm: both live at the repo root, and npm only
force-includes them when they exist in the package directory itself — so the
registry showed an empty description for both packages, and the MIT-licensed
code shipped without its license text. A `prepack` hook now copies them from
the root into each package at pack time, keeping a single source of truth.

No runtime change: `dist/` is byte-for-byte identical.
