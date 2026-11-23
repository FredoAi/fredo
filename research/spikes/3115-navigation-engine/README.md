# Spike #3115 — Navigation Fluency Research

**Question.** Does a place-based navigation model — a declared place tree with object-first verbs,
a place rail (breadcrumb + 4–8 contextual verbs + `/ Ask` + `? Map`), a `?` navigation map,
selection-aware verbs, launcher-centred conversation and attributed auto-apply with visible undo —
actually improve felt flow, make conversation feel connected to the work, and build trust in
auto-apply? Or is it a slower vim-like layer nobody asked for?

The answer decides whether the program funds **one navigation model** (P2) instead of shipping
another flat hotkey layer. The deliverable is a numeric go/no-go gate, and **NO-GO is a valid
outcome** — it is a funded decision not to build.

## Stage model

| Stage | Who | What ships |
|---|---|---|
| **Stage 1** | Agents | The research report (`docs/UX_FLUENCY_RESEARCH.md`): principle set with sources, reproducible current-state teardown of the nine shipped surfaces, repo-anchored heuristic evaluation. Plus this spike's committed protocol and a throwaway clickable prototype. |
| **Gate H** | **Human only** | 5–8 real moderated sessions (~30–40 min each) run by the human owner or their facilitator. **No agent may run, simulate or fabricate a session, a note, a rating or a quote.** The raw notes live only in `.opencode/tmp/3115/sessions/` (gitignored, human-written). |
| **Stage 2** | Agents | Transcribe the human notes (anonymised `P1`–`P8`), build the metric tables, answer RQ1–RQ3, recompute the six gate lines, record the verdict and the AC7 receipt. Only then do the report's results sections replace the pending-gate marker with transcribed data. |

While Stage 1 is in flight every results section of the report carries an explicit pending-gate
marker. The marker's absence is the Stage-2 receipt (no results section may be filled from
inference).

## Contents of this directory

| Path | Role |
|---|---|
| `README.md` | This record — the question, the stage model, the throwaway boundary |
| `session-protocol.md` | The normative protocol (consent, tasks T1–T7, questions, metric definitions, gate arithmetic). P6 reuses it verbatim |
| `session-kit/gate-h-input-template.md` | The exact input contract the human fills in for Gate H |
| `prototype/` | **THROWAWAY** low-fidelity clickable prototype (static HTML/CSS/JS) |

> **THROWAWAY.** `prototype/` is a disposable stimulus, not product code. It is deliberately
> greybox and imports nothing from `apps/`, uses no Fredo theme tokens, adds no build/workspace
> wiring, and emits no telemetry. It is deleted whole by P8 (remove the directory). Nothing in it
> is meant to survive the spike; the report and the evidence are the durable artifacts.

## Reading order

1. `docs/UX_FLUENCY_RESEARCH.md` §1–§2 — what is being asked and the principles it is judged by.
2. §3–§4 — the current-state teardown and heuristic findings (the qualitative comparator).
3. §5–§10 — prototype, method, metrics, RQ answers, verdict (Stage 1: methods only).
4. §11.1 — the limitations, including the grammar gap and the **no controlled shipped-app
   baseline** caveat.
