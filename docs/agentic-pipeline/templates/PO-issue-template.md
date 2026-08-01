# Product Owner Backlog Template

> The card is a promise for a conversation (the 3 C's) — just enough to identify and remind. The richness lives in the context links and the acceptance criteria. The **why** is forced before the **how**; implementation is banned from the problem statement.

---

## Title

`As a <specific role/persona>, I can <outcome>, so that <value>`

- One line, Connextra format, **specific role** — never a lazy "As a user".
- If no real end-user role fits (backend, compliance, tooling), mark the item type honestly instead of faking a story.
- The "so that" is the value carrier — if it can't be written, the item isn't ready.

---

## Problem / Why now  [REQUIRED — the value carrier]

- **Who** is affected, **what** the problem is, **why** it matters *now*.
- **No solutions here.** NN/g rule: a problem statement must not contain a solution. If you're describing any part of the UI, you're missing the point.
- Quantify the impact when possible (metric, behavior change, effort saved).
- If this section can't be written, don't create the issue — investigate first.

---

## Intended users

- Who benefits? Personas or roles. "Unknown — to be refined" is acceptable; "As a user" is not.
- If you don't know who the users are and why they'd use it, don't write the story yet.

---

## Proposed behavior / Scope  [REQUIRED — "how" second]

- What we will build, in user terms, with the user journey.
- Free of implementation detail (no frameworks, no components, no endpoints).
- **Constraint of the slice:** state what's deliberately included (e.g., happy path only, one data source, one platform) so the split is intentional and reviewable.

---

## Success metrics  [REQUIRED]

- The business outcomes that prove this was worth building (usage, retention, effort saved).
- Distinct from acceptance criteria: metrics = did it matter? AC = does it work?
- If unmeasurable, say so explicitly.

---

## Acceptance criteria  [REQUIRED — 3–5 "conditions of satisfaction"]

- [ ] 1. <observable, independently verifiable behavior>
- [ ] 2. <...>
- [ ] 3. <at least one edge / negative case where relevant>

Rules (Cohn/Pichler):
- **3–5 bullets by default** — observable outcomes, not implementation internals.
- You would **reject the story** if any one of these is missing.
- Each must be verifiable and demo-able.

**Complex scenarios (only where needed):** for the 1–2 genuinely multi-condition cases (business rules, edge interactions), use Given-When-Then:
```
Scenario: <one behavior, one line>
  Given <system state, past/passive>
  When  <a single action>
  Then  <observable outcome>
```
- One `When` per scenario. Observables in `Then` — never database internals.
- Declarative, not imperative: "When the user logs in" not "When I click the login button".
- If the team won't automate it, plain bullets are enough — Gherkin without automation is ceremony.

---

## Out of scope / constraints

- **Non-goals:** what this ticket explicitly is *not* doing.
- Dependencies: what it blocks / is blocked by.
- NFRs that apply (performance, security, accessibility) — NFRs don't fit story syntax, keep them as a checklist.

---

## Priority & value

- **Priority:** P0–P3 (or Urgent / High / Medium / Low). No more granular — diminishing returns.
- Value signal at gut-check: **Reach** (how many), **Impact** (0.25–3), **Confidence** (50–100%).
- Category: Must / Should / Could / Won't.
- Strategic goal this serves (OKR / initiative / epic link).

---

## INVEST self-check  [gate before creating the issue]

| Letter | Question | Fail → |
|--------|----------|--------|
| **I** | Independent — schedulable in any order? | combine/split |
| **N** | Negotiable — no pre-baked solution? | remove the "how" |
| **V** | Valuable to the *customer*? | rewrite or kill |
| **E** | Roughly sizeable? | split |
| **S** | Small — fits within ~half a sprint? | split (SPIDR) |
| **T** | Testable — can you imagine the test? | add ACs |

**Ready statement:** Clear + feasible + testable + fits a sprint + the team understands it.

---

## Done statement

Reference the shared **Definition of Done** (tested, reviewed, demo-able, no regressions) — do not restate org-wide quality per item.

---

## Item type  [required]

- `user story` — end-user value
- `business story` — process/stakeholder value
- `technical story` / `task` — must still state the product "why now", but is not forced into story syntax
- `spike` — investigation, time-boxed
- `bug` — see bug variant
- `NFR` — non-functional

---

## Links & evidence

- Related issues, epic/initiative, story-map position, mockups, designs, competitive references.
- Put the *how* in the conversation, not the card — preserves negotiability.

---

## Bug variant

Replace Problem/Scope/AC with:
- **Expected behavior** — what should happen
- **Actual behavior** — what actually happens
- **Steps to reproduce** — numbered, mandatory
- **Environment** — version, OS, browser/provider
- **Frequency** — every time / often / sometimes / only once
- **Severity** — blocker / critical / major / minor
- **Logs / screenshots**
