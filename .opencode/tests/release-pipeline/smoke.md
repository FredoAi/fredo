# release-pipeline — Smoke Tests

Config-only domain (`.github/workflows/` + `.github/CODEOWNERS` + docs; no product runtime). The
standard app-boots smoke boilerplate does NOT apply — the "system" under test is the release-pipeline
contract, so these are **static config sanity** checks (G-089). No `tauri_webview_*` / app boot is
required.

## S-1 — Release contract present and internally consistent
- [ ] S-1: `.github/workflows/release.yml` exists and is readable valid YAML; `docs/release-process.md` exists; `.github/CODEOWNERS` exists and carries `* @pktron`. EXPECT: all three present at the spec-branch tip.

## S-2 — No console/run error (config equivalent)
- [ ] S-2: `release.yml` and the `validate.yml` change parse as valid; a YAML lint/struct check (or the developer's `cargo`/`pnpm` CI-parity run) reports no syntax error. EXPECT: no YAML/syntax error; the workflow is structurally valid.

## S-3 — Feature surface reachable (config equivalent)
- [ ] S-3: The release contract is wired to the agreed trigger: `release.yml` fires only on `push` to `release/stable`; `validate.yml` added the ADDITIVE `release/stable` PR trigger; `docs/release-process.md` documents the owner cut. EXPECT: trigger wiring matches the plan (G-023 reconciled).

## S-4 — Docs gate contract intact
- [ ] S-4: `docs/CI_GATE_CONTRACT.md` still names `validate` as main's sole required check (no new main gating check). EXPECT: unchanged against the `main` tip.

## S-5 — Evidence capture
- [ ] S-5: The suite records which files it read and what was observed (a textual receipt is the evidence for this config domain — no screenshot is required, per the static verification policy).

_Full DOM + visual execution methodology lives in the `dev-environment` skill but is NOT applicable to this config-only domain._
