# Status Comment Template

> Used by any pipeline agent to post a progress / state-change note on the **feature issue** via the `comment` action (`--prefix Status`). Draft this file as `.opencode/tmp/<issue>/status.md` (or any path you name), then run:
> `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action comment --prefix Status --body-file .opencode/tmp/<issue>/status.md`
> **`--body-file` is REQUIRED.** The implicit `status.md` default is retired: a `comment` with no explicit body file is REFUSED, so a draft another role left at the default path can never be republished by omission. Name the body you authored for THIS call.
> The state machine prefixes `## Status` automatically and posts it. `Status` is the ONLY agent-facing prefix, and it is for blockers, escalations and Product Owner amendments — never routine progress.

<!-- One topic per comment. Status comments are NOT actor-gated (any pipeline agent may post). -->

## <short topic>

- <what changed / what you verified>

### Verification

| Check | Result |
|-------|--------|
| <build / typecheck / test> | PASS/FAIL |
| <acceptance criterion> | met/not met |

### Scope notes

- <files changed, anything outside scope, dependencies>

*Authored by <Agent Name>*
