# release-pipeline — Exploratory Tests

Unscripted edge/failure probes for the Fredo release line. Add on-the-fly findings here; a
confirmed probe **promotes** to `functional.md` as a new `F-` row (keep the origin note). This is
a config/CI domain; probes are static reads of the release contract, not live release runs.

> The admin-enforced/publish legs are intentionally NOT probed here as live-release runs (the
> sandbox principal is not a repo ADMIN) — probe only the declarative in-repo contract and the
> documented owner procedure for self-consistency.

## Prompts (seed probes)
- [ ] E-1: Does `docs/release-process.md` fully cover the owner-manual release cut (create + protect `release/stable`, apply the ruleset, place `@pktron` as required reviewer, cut a release, review + publish the draft)? EXPECT: the doc is internally consistent with the committed `release.yml` trigger (`push: branches: ['release/stable']`) and with `validate.yml`'s additive `release/stable` trigger; no step is missing or contradicts the in-repo contract.
- [ ] E-2: Is `release.yml` syntactically valid and self-consistent (matrix args match the OS, `projectPath` matches the Tauri project location, `permissions: contents: write` present, the `tauri-apps/tauri-action` step is BUILD-ONLY — carries no `tagName`/`releaseName`/`releaseBody`/`releaseDraft`/`releaseId` — and the workflow's ONLY publish step is `gh release create "app-v<version>" <installer> --draft` gated `if: success()` AFTER the payload gate; all `uses:` SHA-pinned)? Note any unresolved `<pin-full-sha>` placeholders that still need resolution at implementation time.
- [ ] E-3: Does any documented `allow_bypass`/required-approval configuration accidentally permit a non-owner (a bot/collaborator) to approve a `release/stable` PR (NFR-1 non-sweepable gate)? EXPECT: only the owner (`@pktron`) is designated and the bypass list is EMPTY.
- [ ] E-4: Edge — the draft is created by the workflow's own `gh release create "app-v<version>" … --draft` step (gated `if: success()` after the gate), NOT by a `tauri-action` release input: if the owner wants *publish-on-merge* instead of a draft, is dropping `--draft` from that one step the only change required, and does the doc note that tradeoff (artifacts become public under the tag immediately)? (PO decision point.)

_Confirmed probes promote to `functional.md`; UNVERIFIED/admin-gated probes carry a named blocker (G-053)._
