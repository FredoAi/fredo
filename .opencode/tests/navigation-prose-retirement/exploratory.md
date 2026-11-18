# navigation-prose-retirement — Exploratory

Unscripted probes for the prose-retirement slice, beyond the scripted `P-*` rows. A CONFIRMED
finding promotes to `functional.md` as a new row (keep the origin note). Nothing here is an AC; a
FAIL here is reported, not fatal, unless it exposes a guard defect that would let a deleted
vocabulary token ship.

Verification policy: **`static`** (see `functional.md`). Each probe drives the committed guard only.
**No `tauri_*` call belongs here** (NFR-5).

> **Probe discipline.** Each probe is a two-step drive: write a synthetic probe file, run the plain
> guard (or `-SelfTest`), read the result, and delete the probe in `try/finally`. **A leftover probe
> file is a FAIL even when the guard exits 0.** Nothing here may be promoted to a PASS without naming
> the printed line it was read from.

## Prompts

- **E-1 — word-boundary behaviour.** Does a prose word-boundary token (e.g. `NavigationHost` as a
  prefix of a longer word) behave as intended? Probe a synthetic `.md` under `docs/` with a longer
  word, run the plain guard, and confirm no substring false positive beyond the class's declared
  text mode. Class B is RAW with identifier boundaries (G-419) — record which mode actually fired and
  whether the boundary held.
- **E-2 — a token inside a fenced code block.** Does a token inside a fenced code block in a
  non-allowlisted `.md` **count**? It must (RAW mode, G-419). Probe it, then confirm the guard's
  declared text mode in the script header is **raw** — a comment-stripping guard would wrongly pass
  this probe.
- **E-3 — a newly added untracked file.** Is a `.md` file newly added under `docs/` (untracked,
  **non-ignored**) scanned on the next plain run? It must be — this is the product analogue of
  `-SelfTest` control 3. If it is not, control 3 and the real walk are using different universes:
  a guard defect.
- **E-4 — an ignored file.** A git-ignored `.md` under `.opencode/tmp/**`: confirm it is **excluded**
  and appears in the `Ignore filter:` count, not the scanned set. Probe with an already-ignored path
  (`.opencode/tmp/` is git-ignored — verified at `.gitignore:209`); **never** temporarily edit
  `.gitignore` to produce the condition.
- **E-5 — an interrupted run leaves nothing behind.** Re-run `-SelfTest` immediately after an
  interrupted run (Ctrl-C mid-control) and confirm **no** orphaned probe is left: `Test-Path` each of
  `docs/__nav_prose_absence_probe__.md`, `spikes/__nav_prose_probe_outside__.md` and
  `.opencode/tmp/__nav_prose_probe_ignored__.md` → all `False`.

## Do not run

- Never temporarily edit `.gitignore`, the token tables or the allowlist to make a probe pass — that
  is the guard's own plan-time defanging, and it converts a probe into a falsified record.
- Never edit `docs/`, `.opencode/tests/**` or any committed prose to test a probe — probe files only,
  removed in `try/finally`.
- Never boot the app: there is no runtime surface in this slice (NFR-5).
