# postgres-client — Exploratory

Unscripted edge/failure probes for the built-in PostgreSQL client (issue #2950 and its
following slices). A confirmed finding **promotes** to `functional.md` as a new `F-` row
(keep the origin note). The Tester adds probes below beyond the script.

> **Verification policy: live** — probes observe a running client/app under a finite timeout.
> **G-263 SAFETY:** every probe is time-bounded and torn down (dev-env lever); managed psql
> only via `run-exitcode.ps1 -Command` (≤60 s). Never an unbounded run.

## Prompt lines

- [ ] **E-1:** What happens on a connection whose server accepts TCP but rejects auth, or
  accepts auth but the database is missing — structured error, or a retry to the bound?
- [ ] **E-2:** Does an SSL-required connection against a non-TLS server fail closed with an
  actionable error, and does an SSL-disabled connection to a TLS-only server behave sanely?
- [ ] **E-3:** How does the editor handle a query that returns a very wide result (hundreds of
  columns) or a cell containing megabytes of text — clipped, scrollable, or frozen?
- [ ] **E-4:** What happens when Load more is clicked while a query is still streaming, or
  twice rapidly — duplicates, gaps, or a disabled control?
- [ ] **E-5:** Does a saved connection with a password survive a credential-store lock/denial
  (OS keychain unavailable) — clear error, or a silent plaintext fallback?
- [ ] **E-6:** What does CSV export do with NULLs, embedded newlines/commas/quotes, and
  formula-injection leading characters (`=`, `+`, `-`, `@`)?
- [ ] **E-7:** Does history capture a failed/refused statement, and can a destructive history
  entry be re-run without a fresh confirmation?
- [ ] **E-8:** How does the schema tree behave for a schema with thousands of tables, or a
  table with hundreds of columns — lazy-expanded or eagerly loaded?
- [ ] **E-9:** Does a dropped server mid-Load-more leave the grid in a consistent state, and
  does reconnecting on a new ephemeral port recover cleanly?
- [ ] **E-10:** Can a multi-statement payload evade the single-statement guard via a
  dollar-quoted function body, a `;` inside a string literal, or a CTE?
- [ ] **E-11:** Does switching tabs preserve unsaved editor text, and does closing a tab with
  a running query cancel it cleanly?
- [ ] **E-12:** Are saved connections and history scoped per-app-user, and do they load
  deterministically when the store is large?
