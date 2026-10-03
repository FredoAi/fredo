# Spike #2968 — RESTful-DOOM Phase-0 acquisition + engine-contract

- **Issue:** #2968 (Doom Mode Slice 1 — ST-1 Phase-0 acquisition + engine-contract spike; ST-9 decision doc)
- **Date:** 2026-10-03
- **Status:** COMPLETE — engine acquisition = **NO trustworthy prebuilt asset** (fallback path taken); Freedoom IWAD pinned; engine HTTP contract captured.
- **Decision doc (reviewable, AC5):** [`docs/doom-mode-acquisition.md`](../../docs/doom-mode-acquisition.md)

This is a **record, not code**. It captures the raw upstream facts ST-1 was dispatched to obtain (or
definitively refute), so every downstream Doom capsule builds against real engine facts rather than
the planning-time guesses. No product code is produced by this spike.

## Question

1. Is there a **trustworthy prebuilt Windows x86_64 RESTful-DOOM archive** we can pin by URL + SHA-256
   for runtime-download? If not, record the definitive finding and take the pre-authorized fallback.
2. What is the **Freedoom IWAD** source URL + SHA-256?
3. What are the **exact** `GET /api/state`, `POST /api/step`, `GET /api/frame` shapes and the launch
   argv (including the port flag)?

## Method

Network was reachable from the implementation sandbox (the planning sandbox's no-network assessment
in the Triage Plan's "Feasibility / Tooling-gap assessment" was planning-time only). `webfetch` was
used against the upstream GitHub release indices, the upstream RAML 1.0 API spec, the fork's build
scripts, and the Freedoom release assets. **The sandbox cannot fetch or execute binary archives and
has no C/SDL/autotools toolchain**, so the engine finding rests on the upstream release indices
(authoritative: a repository either has a Release asset or it does not) plus the build scripts —
not on a local binary build. This limitation is recorded in the decision doc.

## Outcome (one line each)

| # | Question | Finding |
|---|----------|---------|
| 1 | Prebuilt engine? | **NO.** `mkschreder/restful-doom` and its upstream `jeff-1amstudios/restful-doom` have **no GitHub Releases and no Packages** — the fork is source-only. No URL + SHA-256 can be pinned. → fallback: user-supplied binary + documented Windows build recipe. |
| 2 | Freedoom IWAD | **Pinned.** `freedoom-0.13.0.zip`, SHA-256 `3f9b264f…8f59` (from the release's PGP-signed CHECKSUM asset). |
| 3 | Engine contract | **Captured** from the upstream RAML spec + README. The plan's guesses were **corrected**: the port flag is `-apiport` (not `-port`); `/api/frame` returns **indexed8 JSON** (not `image/png`); `POST /api/step` takes `{tics, actions}` (not `{action, tic}`). |

## File map

| File | Contents |
|------|----------|
| [`engine-acquisition.md`](engine-acquisition.md) | Raw engine-acquisition finding (no prebuilt asset) + evidence + the deferred runtime-download criteria |
| [`engine-contract.md`](engine-contract.md) | Exact HTTP shapes for `GET /api/state`, `POST /api/step`, `GET /api/frame`, plus `/api/episode` and the launch argv |
| [`freedoom-iwad.md`](freedoom-iwad.md) | Freedoom 0.13.0 source URL, SHA-256, contents, license |
| [`sources.md`](sources.md) | Every upstream URL consulted, with retrieval date (provenance) |

## Note on layout

`spikes/README.md` describes spikes as flat `<issue>-<slug>.md` files. This spike is a **directory**
because the plan (`### Sub-issue Decomposition`, ST-1) mandates `spikes/2968-doom-runtime/` to hold
the spike doc **and raw captures**. The decision doc lives at `docs/doom-mode-acquisition.md`.
