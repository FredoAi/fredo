# db-client-builtin — Exploratory

Unscripted probes for the built-in-connection slice. A confirmed finding **promotes** to
`functional.md` as a new `F-` row (keep the origin note). Prompt lines below — the Tester probes
beyond the script.

> **Verification policy: LIVE** — probes run against the running app + embedded cluster.

## Prompt lines

- Probe: race the mount-time seed against a fast click on connect (is the row present before the
  user can click; does a connect before the row is listed misbehave?).
- Probe: connect the built-in, then `dev-env -Action Restart`; does the UI show a connection-lost
  state, and does a re-connect resolve the new port with no manual edit?
- Probe: with the built-in connected, edit it (⇒ `builtin=false`) while connected — what happens to
  the live session and to a subsequent connect?
- Probe: delete the built-in while connected — is the session torn down cleanly, no orphaned pool?
- Probe: set `FREDO_DBCLIENT_STATE_DIR` to a path that exists but holds a corrupt/partial
  `Fredo_dbclient_connections.json` — does the app fall back to an empty list (tolerant read) and
  NOT re-seed a duplicate?
- Probe: run two app instances (or a headless + GUI) against the same data dir — does the built-in
  row duplicate, or does the second instance report `Failed`/`Attached` as before?
- Probe: connect the built-in with `FREDO_PG_KEYCHAIN_DISABLED=1` and no `FREDO_PG_PASSWORD_FILE` —
  is the failure typed and prompt-free?
