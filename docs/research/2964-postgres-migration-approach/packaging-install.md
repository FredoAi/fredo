# ST-6 — Packaging / install position (acquisition + integrity)

- **Issue:** #2964 (spike: SQLite → embedded-PostgreSQL migration approach)
- **Scope area:** R-1(e) packaging/install + R-4b (acquisition-mode position or named blocker)
- **Status:** position taken; the **policy choice** between the two modes remains a named open input (offline-first hardness)
- **Prior evidence:** [`spikes/2948-embedded-postgres/`](../../../spikes/2948-embedded-postgres/) (QUESTIONS.md, `results/measurements.json`), [`docs/research/2948-embedded-postgres-spike.md`](../../2948-embedded-postgres-spike.md)
- **New evidence measured by this sub-task** (recorded verbatim in §5 and §7 below; no file under `apps/**` changed)

> This is the packaging/install section of the master design doc
> [`docs/research/2964-postgres-migration-approach.md`](../2964-postgres-migration-approach.md).
> It is self-contained: every number it relies on resolves to a committed in-repo artifact or to the
> verbatim command output reproduced in §7.

---

## 1. The two acquisition modes

`postgresql_embedded` 0.21 (the engine #2948 evaluated, declared at
`spikes/2948-embedded-postgres/Cargo.toml:37`) acquires the PostgreSQL distribution in one of two
ways. The choice is made at **build** time (a cargo feature), and it decides *where the ~164 MB
PostgreSQL payload comes from*.

| Mode | Cargo activation | First-run network? | Where the bytes live before first run |
|---|---|---|---|
| **`runtime-download`** (crate default) | `postgresql_embedded = "0.21"` with default features (`theseus`, `tls-native-tls`, `tokio`) | **Yes** — the archive is fetched on first run | Nowhere in the installer; downloaded into the installation dir |
| **`bundled`** (compile-time-embedded) | add `features = ["bundled"]` | **No** — no runtime net | Embedded (compressed) inside the application binary at build time |

`bundled` is a **build-time** acquisition: enabling it makes the crate's build script fetch the
PostgreSQL archive during the cargo build and embed it via `include_bytes!`, so the shipped binary is
self-sufficient at runtime (see §4). It does **not** merely flip a runtime flag — it changes the
build.

## 2. What #2948 actually exercised (runtime-download only)

#2948 exercised **only** `runtime-download`; `bundled` was never built or measured.

- **Acquisition:** default runtime-download of **PostgreSQL 18.6.0** from the theseus-rs archive
  (`spikes/2948-embedded-postgres/README.md:28-32`, `results/measurements.json`
  → `variants[embedded-postgres].mode = "runtime-download"`).
- **Installed distribution:** **164,026,008 B (156.4 MiB)** extracted into the spike's installation
  dir (`target/spike-pg-install/18.6.0/`) — `spikes/2948-embedded-postgres/QUESTIONS.md:17-29`,
  `results/measurements.json` → `distribution_bytes = 164026008`.
- **Network requirement:** network access on first run
  (`spikes/2948-embedded-postgres/QUESTIONS.md:21-24`).
- **`bundled` verdict in #2948:** `Unknown` — "was **not exercised**, so its size/build-time cost is
  `Unknown` (blocking factor: time-boxed spike exercised one of two acquisition modes)"
  (`spikes/2948-embedded-postgres/QUESTIONS.md:22-24`).

So the premise handed to this sub-task — *"whether `bundled` changes the picture is OPEN"* — was
true at the start of #2964. §4 closes it with a measurement.

## 3. Current bundle configuration (nothing is wired yet)

The Tauri bundle config declares **no sidecar and no resources** today:

```json
// apps/tauri/src-tauri/tauri.conf.json:53-54
"externalBin": [],
"resources": {}
```

Consequences for the migration:

- `runtime-download` needs **neither** `externalBin` nor `resources`: the payload is fetched into
  `<app_data_dir>` on first run, so the bundle config is unchanged.
- `bundled` (crate feature) also needs **no** `tauri.conf.json` change — the archive is embedded in
  the binary by the crate's build script — but it **does** require adding the `bundled` feature to
  `apps/tauri/src-tauri/Cargo.toml`, which is a production change owned by the follow-up
  implementation spec (out of scope here; R-3/no-production-change).
- A third, install-time variant (ship the compressed archive as a Tauri `resource` and extract it on
  first run — §6) is the only option that would populate `resources` at
  `apps/tauri/src-tauri/tauri.conf.json:54`.

## 4. MEASURED: what `bundled` costs (answers R-4b option (a))

The `bundled` feature **was built and measured** in this sub-task on Windows x86_64. Method: same
binary (`poc`), same profile (release), flip only the feature. Exact commands and verbatim output are
in §7.

### 4.1 Result

| Quantity | Value | Bytes | MiB |
|---|---|---:|---:|
| Release `poc` **without** `bundled` | baseline | 5,396,992 | 5.15 |
| Release `poc` **with** `bundled` | embedded | 59,445,760 | 56.70 |
| **Δ attributable to `bundled`** | **binary inflation** | **54,048,768** | **51.55** |
| Compressed archive the build script embedded | `OUT_DIR/postgresql.tar.gz` | 54,068,902 | 51.57 |
| Extracted distribution (unchanged payload, #2948 runtime-download) | PostgreSQL 18.6.0 | 164,026,008 | 156.43 |
| Archive version written by the build script | `out/postgresql.version` = `18.6.0` | — | — |

The +54,048,768 B binary delta equals the embedded archive (54,068,902 B) to within binary-alignment
overhead, and the version file confirms it is the **same PostgreSQL 18.6.0** release #2948 measured.
This is direct evidence that `bundled` is a **compile-time-embedded archive** — not a code-size
change (only `postgresql_embedded` and the spike recompiled on the feature flip; no new dependency
crate appeared in `Cargo.lock`).

### 4.2 Build-time cost

- Cold `--release` build of the feature-enabled binary: **1 m 23 s** (fresh target dir; the whole
  dependency graph plus the archive fetch/embed).
- Incremental rebuild after flipping only the feature: **7.35 s** (only `postgresql_embedded` +
  the spike recompile; the downloaded archive is cached in the build `OUT_DIR`).
- **The build does one network fetch.** The crate's build script printed
  `PostgreSQL archive written to: …\out\postgresql.tar.gz` and sourced it from
  `https://github.com/theseus-rs/postgresql-binaries` (§7). cargo's `--offline` flag does **not**
  govern this fetch (it is a plain HTTP request inside the crate's `build.rs`, not a registry
  operation), so a clean-machine `bundled` build requires network **at build time**.

### 4.3 How this changes the +164 MB picture

`bundled` **moves** the ~164 MB payload's acquisition point; it does not eliminate the payload:

- **runtime-download:** installer ≈ 0 MB extra + **164,026,008 B downloaded on first run**; no
  build-time network.
- **bundled:** **+54,048,768 B in the binary/installer** (compressed) + the same **164,026,008 B
  extracted to disk on first run**; **no runtime network**, but a one-time **build-time** network
  fetch.

So `bundled` trades *runtime* network for (a) a ~51.5 MiB larger installer and (b) a *build-time*
network dependency. It is the only mode that makes Fredo's **first run** offline. The extracted
on-disk footprint (~156 MiB) is the same either way; `bundled` was **not executed** here (ST-5 owns
runtime lifecycle), so the extracted size under `bundled` is inferred from the identical 18.6.0
payload, not independently re-measured.

## 5. Position (R-4b)

**Position: if offline-first is a hard product constraint, `bundled` is the correct acquisition mode;
otherwise `runtime-download` is cheaper and is the mode already de-risked by #2948.**

The cost side of the question is now measured (§4): the `bundled` penalty is **+54,048,768 B
(~51.5 MiB)** in the shipped binary/installer plus one **build-time** network fetch — not an unknown,
and materially smaller than the 156.4 MiB extracted payload because the archive is stored compressed.
The runtime side is clear: `bundled` needs no network on first run; `runtime-download` needs one
fetch of 164,026,008 B.

**Named open input that keeps the final choice open:** the **offline-first hardness** question — the
backlog carries "(a) is offline-first a hard constraint?" (inherited into #2964;
`docs/research/2948-embedded-postgres-spike.md:105-108` records it as an unconfirmed human
assumption). This sub-task cannot decide a product constraint; it can and does price both branches.

**Evidence that resolves the open input:** a PO/human answer to question (a).

- If **(a) = hard** ("no network ever, including first run") → adopt `bundled`. Required follow-up
  action: add the `bundled` feature to `apps/tauri/src-tauri/Cargo.toml` (production change, next
  spec) and accept a `bundled` build-time network fetch + ~51.5 MiB installer growth. No
  `tauri.conf.json` change needed.
- If **(a) = soft / not a constraint** → keep `runtime-download` (already exercised, no installer
  growth, no build-time fetch); the only cost is a documented first-run download of 164,026,008 B.

This satisfies R-4b with **both** a stated position (measured cost, mode recommendation per branch)
**and** the named open input + resolving evidence — it is not an unqualified "bundled is better".

## 6. Acquisition / integrity story per mode

The Companion **model acquisition** is Fredo's existing production precedent for a vetted
runtime-download, and it is the integrity bar a PostgreSQL acquisition should meet (or consciously
deviate from):

- Entry point: `download_model` (`apps/tauri/src-tauri/src/features/setup/commands.rs:1024-1041`)
  delegates to the streamed engine in `apps/tauri/src-tauri/src/features/setup/model_download.rs`.
- Engine guarantees (`apps/tauri/src-tauri/src/features/setup/model_download.rs:6-17`, `:281-388`):
  skip files that verify present; HTTP `Range` resume from the on-disk byte count with safe
  from-zero restart; **streaming SHA-256** seeded with the on-disk prefix before the GET; a digest
  mismatch **deletes the file and reports `error`** (`:376-385`); bounded retry with backoff; per-file
  error isolation; throttled progress.
- Digest pins: `ModelFileSpec.sha256` is a first-class field
  (`apps/tauri/src-tauri/src/infrastructure/companion/models.rs:59-74`) and the compiled default
  manifest pins a SHA-256 per file (`…/models.rs:122-162`).
- The `install_llama_cpp` precedent (`apps/tauri/src-tauri/src/features/setup/commands.rs:1256`) shows
  the same shape for a Windows-only acquisition routed through `spawn_blocking` (off the UI thread).

| Acquisition mode | Bytes in installer | First-run network | Integrity mechanism |
|---|---:|---|---|
| `runtime-download` **(#2948 / crate default)** | ~0 | **164,026,008 B** | The crate's own archive downloader (`postgresql_archive`; its verification path was **not inspected — the crate source is outside this repo**). `Cargo.lock` shows `postgresql_archive` depends on `sha2`. |
| `runtime-download` **via Fredo's own engine (Companion pattern)** | ~0 | 164,026,008 B | `model_download.rs` streaming SHA-256 + `Range` resume + a pinned digest (`models.rs:59-74`, `:122-162`) — the strongest, already-shipped guarantee. |
| `bundled` **(crate feature, measured in §4)** | **+54,048,768 B** (binary) | **none** | The crate's **build script** fetches the archive at build time into `OUT_DIR/postgresql.tar.gz` and embeds it. This is **not** Fredo's SHA-pinned engine; integrity is the crate's build-time fetch + the trust placed in `theseus-rs/postgresql-binaries` (supply-chain concern). |
| `bundled`-as-**resource** (design option, unmeasured) | +51,572,000 B ish as a Tauri `resource` | none | Would let Fredo reuse its own SHA-pinned streaming engine to fetch/vendor the archive into `resources` (populating `tauri.conf.json:54`, today `{}`) and extract it on first run — keeps the binary small and puts integrity under Fredo's control. |

**Recommendation for the follow-up implementation spec:** whichever mode is chosen, route the
archive through (or verify it against) the existing SHA-256-pinned engine rather than trusting an
unverified download. For `runtime-download`, this means driving `model_download.rs`'s engine to fetch
the PostgreSQL archive and pointing `postgresql_embedded` at the local installation. For `bundled`
(crate feature), the build-time fetch is outside Fredo's integrity surface and must be documented as
such (or replaced by the `bundled`-as-resource variant).

Also note for the follow-up spec (F-11 / security posture): the PostgreSQL License is permissive
(`spikes/2948-embedded-postgres/QUESTIONS.md:127-129`), but the evaluated crate's
maintenance/advisory posture is `Unknown` (`QUESTIONS.md:131-139`, Q9) — a version bump
(security/patch) therefore means a **rebuild** for `bundled` or a **first-run re-download** for
`runtime-download`, and crate health must be checked before taking the dependency.

## 7. Raw evidence (verbatim)

All commands run from the repo's spike dir on Windows x86_64, in the `spikes/2948-embedded-postgres`
standalone package (never a workspace member). The only source manipulation was a cargo feature flag;
no tracked file was modified (`git status --short` clean after the runs; `Cargo.lock` unchanged).

### 7.1 The `bundled` build script fetched + embedded the archive

`cargo build --release --offline --features postgresql_embedded/bundled --bin poc` →
`Finished \`release\` profile [optimized] target(s) in 1m 23s`.

`target\release\build\postgresql_embedded-93d77f60eac79fb7\output`:

```
cargo:rerun-if-env-changed=POSTGRESQL_VERSION
cargo:rerun-if-env-changed=POSTGRESQL_RELEASES_URL
PostgreSQL releases URL: https://github.com/theseus-rs/postgresql-binaries
PostgreSQL version: *
Target: x86_64-pc-windows-msvc
OUT_DIR: "…\target\release\build\postgresql_embedded-93d77f60eac79fb7\out"
PostgreSQL archive written to: "…\target\release\build\postgresql_embedded-93d77f60eac79fb7\out\postgresql.tar.gz"
```

`…\out\postgresql.tar.gz` = **54,068,902 B**; `…\out\postgresql.version` = `18.6.0`.

### 7.2 Same-binary size delta (isolates the feature)

```
release poc, no bundled : 5,396,992 B     (cargo build --release --offline --bin poc)
release poc, bundled    : 59,445,760 B    (cargo build --release --offline --features postgresql_embedded/bundled --bin poc)
delta                   : +54,048,768 B
incremental feature flip: Finished `release` profile … in 7.35s   (only postgresql_embedded + the spike recompiled)
```

### 7.3 Prior #2948 numbers used above (committed, immutable)

- `spikes/2948-embedded-postgres/results/measurements.json` →
  `variants[embedded-postgres].distribution_bytes = 164026008`, `.mode = "runtime-download"`.
- `spikes/2948-embedded-postgres/QUESTIONS.md:17-29` (Q1 packaging: runtime-download only;
  `bundled` `Unknown`).

## 8. Verification / scope

- **AC mapping:** R-1(e) packaging/install scope area (this doc); R-4b acquisition-mode position +
  named open input (§5) with measured `bundled` cost (§4).
- **Files changed:** this file only — `docs/research/2964-postgres-migration-approach/packaging-install.md`.
- **No production change:** no file under `apps/**` was edited; the `bundled` measurement ran only in
  the `spikes/2948-embedded-postgres/` standalone package with a cargo feature flag. The bundle config
  (`apps/tauri/src-tauri/tauri.conf.json:53-54`) is untouched.
- **Citations:** every `file:line` above resolves on `main`; prior-spike numbers resolve to
  `spikes/2948-embedded-postgres/results/measurements.json` / `QUESTIONS.md`.
