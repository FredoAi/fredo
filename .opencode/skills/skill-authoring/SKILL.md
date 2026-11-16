---
name: skill-authoring
description: Authors and edits an opencode SKILL.md — the description-as-router, the fixed body sections, three-level progressive disclosure, and the <500-line ceiling — so an agent selects the skill from its description alone. Use when creating or editing a skill under .opencode/skills/, writing or fixing a skill's description, deciding whether content belongs in a skill vs AGENTS.md vs a playbook, splitting a bloated skill into one-level-deep references, or wrapping a script in the skill that documents it.
---

# Skill Authoring

## What this skill does

Teaches how to write a good `SKILL.md` per the pipeline's agent-skill-guide: the `name` + `description` frontmatter, the fixed body section order, three-level progressive disclosure, the `<500`-line ceiling, degrees of freedom, and least-privilege security. It is the companion to the tool- and script-authoring work the Toolsmith does — a script without a skill documenting it is unreachable (principle 9).

## When to use it

- Creating a new skill under `.opencode/skills/<name>/SKILL.md`.
- Editing an existing skill's `description`, body, or references.
- A skill "never loads" — the agent does not pick it up on a natural prompt (fix the description before adding content).
- A `SKILL.md` has grown past ~500 lines and needs splitting into one-level-deep references.
- Deciding whether content belongs in a skill, in `AGENTS.md`, or in an agent playbook.
- Wrapping a pipeline script so the skill documents its exact invocation (principle 9).

## Procedure / Steps

1. **Decide it is a skill, not a rule.** Skills are for **vertical, explicitly-triggered** workflows. If the fact must be true every turn, it belongs in `AGENTS.md`, not a skill — "a rule the model only meets after it decides to load a skill file is a rule it meets too late." If it is a per-role how-to, it belongs in that role's playbook.
2. **Write the `description` first — it is the entire product.** Only `name` + `description` sit in context at startup; the agent selects the skill from that text alone. Write it **third person**, action-verb-led, with trigger keywords and file types, key use case first (listings may truncate). Shape: *"Does X. Use when [trigger phrases, file types, verbs]."* No `I`/`you`; no vague "helps with documents".
3. **Match the name to the directory.** `name` must be kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) and **equal the folder name** — a mismatch is a silent load failure. The description must be 1–1024 chars.
4. **Fill the fixed body sections in order:** `## What this skill does` → `## When to use it` → `## Procedure / Steps` → `## Examples` → `## Resources`. Assume the agent already knows the domain; state what to do, not what it knows.
5. **Match instruction rigidity to task fragility (degrees of freedom).** Fragile operations (releases, migrations, exact script invocations) → exact steps + "run exactly this, do not add flags". Judgment tasks (review, summarization) → brief directional principles. Medium → templates with parameters. Prefer reason-based instructions ("Do X because Y causes Z") over rigid absolutes.
6. **Keep it under ~500 lines / ~5k tokens.** Loaded skill content persists in context every turn — every line is a recurring cost. Cut anything the model can infer; keep frequently-needed items in the main file.
7. **Push depth to one-level-deep resources.** `references/`, `scripts/`, `assets/` are loaded on demand. **Never nest** (`SKILL.md → a.md → b.md`) — agents partial-read (`head -100`) deep files and lose content. Reference files >100 lines get a table of contents. Use forward-slash paths only.
8. **Include a check the skill can run.** A validation script, expected output, or self-test; for fragile workflows a validate → fix → re-verify loop. Prefer scripts for deterministic steps — only the script's stdout enters context (concise success/failure, structured result, no traceback).
9. **Treat security as first-class.** Skills are privileged instructions and code. If the skill ships a script, scope it to the least privilege, parameterize it, and **never** add a write-and-execute-arbitrary-code seam (a skill that takes a code string and runs it is not a skill). Name the sanctioned invocation; one default, not a tool menu.
10. **Ship it with its consumer grant.** A skill no role can load is invisible — route the grant through the Orchestrator's `set-permission --role <agent> --tool skill --pattern <skill-name> --decision allow` in the same pass.
11. **Validate.** Run the should-trigger and should-not-trigger prompts against the description; if it does not load on a natural prompt, fix the description before adding content. Confirm the name matches the directory and the YAML parses.

## Examples

**Good description (third person, trigger-led, key use case first):**

```
description: Extracts text and tables from PDF files, fills forms, merges documents. Use when working with PDFs or when the user mentions PDFs, forms, or document extraction.
```

**Bad descriptions:**

```
description: Helps with documents            # vague — never triggers, or triggers wrong
description: I can help you read PDFs        # first person — breaks discovery
```

**Fragile step (exact invocation):**

```
Run exactly this, do not add flags:
powershell -File .opencode/scripts/wait-telemetry.ps1 -Query "SELECT ..." -Attempts 20
Exit 0 as soon as ≥1 row; on timeout the condition was never met — treat it as not converged.
```

**Judgment step (directional):**

```
Review the diff for scope creep; flag any change outside the plan's files. Judge from the
record — a claim of success without evidence is a failure.
```

**Resources section (one level deep, forward slashes):**

```
## Resources
- Canonical guide: see [agent-skill-guide.md](../../../docs/agentic-pipeline/agent-skill-guide.md)
- Worked example: [dev-environment/SKILL.md](../dev-environment/SKILL.md) — a script documented by its skill
- Validation: run `powershell -File .opencode/scripts/test-scripts.ps1` — only the script output enters context
```

## Resources

- Canonical guide: [docs/agentic-pipeline/agent-skill-guide.md](../../../docs/agentic-pipeline/agent-skill-guide.md) — the SKILL.md anatomy, progressive disclosure, degrees of freedom, anti-patterns.
- Script/interface rule: [docs/agentic-pipeline/principles.md](../../../docs/agentic-pipeline/principles.md) (rule 9 — Scripts Are Called Through Skills).
- Worked examples in-repo: [dev-environment/SKILL.md](../dev-environment/SKILL.md) and [telemetry-query/SKILL.md](../telemetry-query/SKILL.md) — each documents its script's exact invocation.
- Pipeline conventions: [docs/agentic-pipeline/common-rules.md](../../../docs/agentic-pipeline/common-rules.md) — document in the same pass; forward-slash paths.
