# postgres-packaging — Exploratory

Unscripted edge/failure probes for the embedded-PostgreSQL packaging & install domain (issue #2978
and its following slice). A confirmed finding **promotes** to `functional.md` as a new `F-` row (keep
the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running/measured artifact under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); the named failure mode
> is the #2948 ~11 h `pg.stop()` hang. Never an unbounded run. Kill-never-wait on expiry.

> **Induction levers (G-275) — BINDING names (G-255), owned by S2:** `FREDO_PG_DATA_DIR` (SHIPPED) →
> `.opencode/tmp/2978/pgdata/`; added by this slice: `FREDO_PG_INSTALL_DIR`, `FREDO_PG_ARCHIVE_URL`,
> `FREDO_PG_ARCHIVE_SHA256`, plus a truncated archive under `.opencode/tmp/2978/acq-corrupt/`. A
> missing seam is a tooling gap to `block` on, not a reason to fail a live leg.

## Prompt lines

- [ ] **E-1:** What happens if the process is killed MID-acquisition (partway through the
  164,026,008 B transfer)? Is the partial archive preserved for a `Range` resume, or is it deleted?
  Does the next launch resume from the on-disk offset with a digest seeded from the prefix, or restart
  from zero? Is the extraction ever attempted on a partial archive?
- [ ] **E-2:** On a resumed acquisition, does the server honour `Range` (206)? What if it ignores it
  (200), returns 416, or the on-disk file is LONGER than expected — does the engine restart from zero
  without duplicating the prefix?
- [ ] **E-3:** Does a mid-stream body error (a slow/idle stream that resets) retry from the persisted
  offset within a bounded budget, or hang / surface a false success? Does the final digest cover the
  whole file after the retry?
- [ ] **E-4:** Is the acquisition integrity check truly fail-closed — does a digest mismatch ALWAYS
  delete the artifact and error, even when it happens after a resumed prefix? Does any code path
  extract before verification?
- [ ] **E-5:** With `bundled`, is there ANY runtime network access for the archive? Try to boot with
  the network disabled and confirm no fetch is attempted. Is the build-time fetch documented as
  outside Fredo's integrity surface, or replaced by a SHA-pinned resource?
- [ ] **E-6:** Does the extracted footprint differ between modes? Confirm the on-disk distribution is
  ~164,026,008 B in BOTH — a `bundled` build must not claim a smaller on-disk footprint.
- [ ] **E-7:** Does the console flash reappear on a COLD first run (acquisition + initdb) even if a
  warm run is clean? Does the crate-spawned postmaster show a window at any point? Is there a seam to
  observe the spawn creation flags?
- [ ] **E-8:** Is the server log tail present and growing across a live run? Is it under the
  overridable install/data dir, and is it readable with standard tooling?
- [ ] **E-9:** What happens if the acquisition completes but the extraction fails partway (disk full /
  interrupted)? Is the partial extract cleaned up, and does the next launch retry cleanly without a
  half-extracted distribution?
- [ ] **E-10:** What happens on a first-run network failure that occurs AFTER a partial download — does
  the error stay retryable and does the retry resume rather than restart? Is any half-extracted tree
  left behind?
- [ ] **E-11:** Does the installer-size delta match the declared mode on a clean build? Does flipping
  the feature leave a stale artifact that inflates or deflates the measured delta?
- [ ] **E-12 (console):** `tauri_read_logs(source="console")` after every probe — any `Error:` /
  `Uncaught` / `Maximum update depth exceeded` is a defect that invalidates that leg's evidence.
- [ ] **E-13:** After `dev-env.ps1 -Action Down`, is any `postgres.exe` this run started left alive
  (the #2948 teardown-orphan class)? Record PIDs + ports.
- [ ] **E-14:** Does the acquisition + first boot complete within the finite bound on a slow/idle
  connection (the real 164,026,008 B class), or does it exceed the budget with no progress?

## #3076 prompts — Fredo-owned extraction of the verified archive (STATIC probes)

> **Policy: static** — these probes read code/test behaviour; they do not need a live boot. A probe
> that reveals a gap **promotes** to `functional.md` as a new `F-` row.

- [ ] **E-15:** What if the archive's entries disagree about the top-level component — does a
  divergent LAST entry abort the whole extraction with `[pg:extract]` and leave the earlier,
  already-unpacked entries behind? Confirm nothing is written at all (hash pass first, unpack
  second), not merely that the error is returned.
- [ ] **E-16:** What if the marker is current but the binaries are later removed (manual cleanup,
  antivirus quarantine, a partial user copy)? Does the next boot re-extract, or does it proceed to
  `initdb` and fail there with an unhelpful error? `trusted_install_is_current` should say
  `false` — check the predicate, not just the boot message.
- [ ] **E-17:** What if the process is killed mid-extraction? Is the marker absent (temp-file +
  rename), is a stale temp marker left behind, and does the next boot re-extract cleanly over the
  partial tree rather than trusting it?
- [ ] **E-18:** With a pre-fix tree at `<install_dir>/18.6.0/**` still on disk, which tree actually
  runs? Confirm the stale tree is neither deleted nor trusted, and that `<install_dir>/bin` is what
  `binary_dir()` resolves to.
- [ ] **E-19:** What if the disk fills during extraction? Does the error carry `[pg:extract]` with an
  actionable message, is the partial tree untrusted afterwards, and does the next boot retry
  cleanly?
- [ ] **E-20:** What about archives containing symlinks or hard links — are they unpacked as links
  that can point outside the install dir, or refused? Check `tar`'s link handling is not a
  zip-slip window.
- [ ] **E-21:** With `FREDO_PG_INSTALL_DIR` set, do acquisition AND extraction use the SAME resolved
  dir (and does `settings.installation_dir`/`binary_dir()` agree), or can they diverge and extract
  where `initdb` is not looked for?
- [ ] **E-22:** If `FREDO_PG_ARCHIVE_SHA256` changes between boots, does the marker comparison flip
  to "not current" and force a re-extract of the newly-pinned bytes — or does the old extraction
  survive under a stale marker?
- [ ] **E-23:** On a Windows install dir containing spaces and non-ASCII characters, does the
  extraction + marker round-trip cleanly (no mojibake in the marker, no truncated path)?
- [ ] **E-24:** During the extraction, is the async runtime still responsive? A heartbeat task
  alongside `ensure_verified_install` should keep ticking — if it stalls, the extract is blocking
  the reactor rather than being `spawn_blocking`'d.
