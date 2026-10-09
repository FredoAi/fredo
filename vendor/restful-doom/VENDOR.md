# RESTful-DOOM vendored source

This directory contains the **unmodified upstream working tree** of RESTful-DOOM,
vendored so a fresh clone of Fredo contains the engine source (Spec #3012, AC1).

```text
upstream:   https://github.com/mkschreder/restful-doom.git
commit:     eded41b5597b7738ec1fa06d24f62b53db982c2c
license:    GNU GPL version 2 (fork of Chocolate Doom)
provenance: vendored source (working tree present); no submodule.
patches:    scripts/doom/patches/*.patch applied at build time (never to the tracked tree).
```

## Provenance

- Cloned from the upstream URL above with `git clone`, checked out at the pinned
  commit `eded41b5597b7738ec1fa06d24f62b53db982c2c`, then the `.git` directory was
  removed before the tree was committed. There is **no gitlink / `.gitmodules`**
  entry: these are ordinary tracked source files, present in a fresh clone with no
  submodule init.
- The tree is the **GNU GPL v2 corresponding source** for the engine Fredo builds
  on first use. No compiled engine binary and no WAD is committed here or bundled
  (see `.gitattributes` / `docs/doom-mode-acquisition.md`).
- The in-repo MinGW portability patches under `scripts/doom/patches/` are applied
  at build time to a **scratch copy** (`build-restful-doom.ps1 -SourceDir`), so this
  tracked tree stays byte-identical to the upstream commit. Line endings are
  normalized to LF via `.gitattributes` (`vendor/restful-doom/** text eol=lf`), which
  is required for `git apply` to succeed and is also marked `linguist-vendored`.
- Build recipe and toolchain: [`../../scripts/doom/README.md`](../../scripts/doom/README.md).
