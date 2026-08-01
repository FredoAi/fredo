# Research Report: Practitioner Communities on PO Story Writing

**Agent:** Research Analyst (community survey)
**Date:** 2026-08-01
**Scope:** r/ProductManagement, r/agile, r/scrum, r/ExperiencedDevs, r/programming
**Evidence class:** practitioner anecdote (patterns across many threads = widely-corroborated; not statistical)

---

## Executive Summary — Top 10 Findings

1. **The format is a means, not the goal.** The most-upvoted lesson: a user story is "a placeholder for a future conversation" and "a promise to have a future conversation." Value is in the conversation it triggers, not the text. *(widely-corroborated)*
2. **"As a… I want… so that…" is widely used, respected but not sacred.** Defenders: forces persona/outcome thinking, readable common currency. Critics: "corporate haiku" and "a magical incantation that makes requirements more verbose." Consensus: use it by default for user-facing work, drop it when it adds nothing (backend), never force it. *(widely-corroborated)*
3. **Acceptance criteria are the field practitioners fight over most — and whose absence causes the most damage.** Missing AC → scope creep, stories rolling into the next sprint, "QA turns into a crime scene unit." Resolution: AC = short list (3–8) of observable conditions, written *with* the team at refinement, then locked. *(widely-corroborated)*
4. **Stories should state the problem, not the solution.** Both PMs and devs converge hard. Solution detail belongs in other fields (mockups, design links, technical notes). In practice most orgs still write solution-spec stories. *(widely-corroborated in principle; messier in practice)*
5. **Who writes the story is a battleground.** Pattern: PO owns problem framing (who/why/what), engineers own decomposition (how/tasks). "Nothing I hate more than writing 20 stories and spoonfeeding them to engineers" (+42). *(widely-corroborated; context-dependent)*
6. **Gherkin/Given-When-Then: the "business writes it" dream is mostly dead.** Dev communities are near-unanimous that (a) business stakeholders almost never write/read it ("the Cobol Fallacy"); (b) as a full Cucumber framework it's a maintenance burden; (c) as a *lightweight way to write acceptance criteria* for complex rules it's genuinely valuable. *(widely-corroborated)*
7. **Small is non-negotiable.** "If there are more than 3–5 acceptance criteria, the story is probably too large." One-sentence stories are fine when trust is high. INVEST is the standard rubric. *(widely-corroborated)*
8. **Most important fields:** problem/context + value (why + who), acceptance criteria (happy + unhappy path), reference artifacts, out-of-scope/non-goals + dependencies, "how do we know it's done." *(widely-corroborated)*
9. **Failure modes are consistent:** stories as tasks, no value statement, pre-baked solutions, too long, vague epics, missing AC, no context, mid-sprint AC edits, stories written after the code. *(widely-corroborated)*
10. **New 2025–26 theme: AI inverts the pipeline.** PMs routinely draft stories with LLMs (PO owns correctness). AI agents produce code faster than the backlog can be refined — straining story hygiene and DoD. *(emerging, widely reported)*

---

## Gherkin / Given-When-Then in practice

- **Who actually writes it?** Almost never the business. "I have never ever been, know, or even heard about a team that has successfully implemented BDD... It always comes to Dev and QA team writing the descriptions leaving out the business part" (+37, r/ExperiencedDevs). "QA aren't technical so sometimes struggle even writing gherkin" (r/ExperiencedDevs).
- **The Cobol Fallacy:** "Just because a syntax is easy to read to non-technical people doesn't mean non-technical people will be able to write a program with it" (+51).
- **When it genuinely adds value:** complex rules/stateful flows/edge-case domains (recurring billing); as acceptance criteria (not a test framework): "Gherkin is good for defining AC but bad for driving testing"; as comments/descriptions in ordinary tests rather than a Cucumber framework.
- **When it's overhead:** simple CRUD features; when nobody non-technical reads it; rapid-change SaaS (step-definition refactor cost); maintenance nightmare (383-pt thread).

**Bottom line for a PO:** Gherkin is a tool for the *refinement room*, not the boardroom. Write GWT AC for the 10–20% of stories with genuinely tricky rules; use plain bullet conditions everywhere else. **Never design the PO issue template around Gherkin — make it optional.**

---

## Most important work-item fields, per practitioners

1. **Problem / context / value ("the why")** — most commonly missing. "The final product isn't as good when engineers don't understand why they're building something and who it serves."
2. **Acceptance criteria (happy + unhappy path)** — universally demanded. "AC are boundaries. They tell engineers where the cliffs are so they can explore without falling off."
3. **Reference artifacts** — design links, screenshots, data sources, related tickets.
4. **Out-of-scope / non-goals + dependencies** — the missing piece that causes scope creep.
5. **Definition of Ready / "who answers questions during build"** — a concrete DoR: user outcome, edge cases, dependencies, UI constraints, test examples, who answers questions.
6. **Explicit success/outcome statement.**

---

## Backlog item failure modes

- Written as tasks, not outcomes ("Tasks are for amateurs... If you give me user stories you're telling me how it will be used, not just what to build", +94)
- No value statement / no "so that"
- Pre-baked solutions ("Add a big red button")
- Too long / too verbose
- Too vague / big-ambiguous stories
- Missing acceptance criteria
- Mid-sprint AC edits ("stories should be locked post-planning")
- AC written after estimation
- Stories written after the code (AI agents)

---

## Recommended template patterns (practitioners actually posted)

1. **franz_v's recipe** (+61): User story statement (problem and achievement, no reference to solution), problem statement, supporting docs/screenshots, **done statement**, wireframes/mockups, acceptance criteria (happy + unhappy path). "The key is talking to your engineers and see what they need."
2. **ASHLEYakaASHLEY's team template**: Description / Problem Statement (the Why) / User Stories / Acceptance Criteria (bullet list of observable things) / Other Information (blocking, dependencies, Non-Goals/Out of Scope).
3. **Screamerjoe's five-field**: user story in 1 persona, business context, UX, additional files/references, acceptance criteria.
4. **DoR-as-gate**: item enters the sprint only if it has user outcome, edge cases, dependencies, UI constraints, test examples, a named person to answer questions.

---

## Concrete recommendations for a PO issue template

1. **Title:** short, imperative, outcome-flavored ("User can export expenses to CSV").
2. **Problem / Context (the "why")** — 1–3 sentences: who it's for, the pain, evidence link. #1 missing field.
3. **Value / expected outcome** — one line: what success looks like, ideally a metric.
4. **User story statement** — default-on for user-facing work; optional for backend; keep the "so that."
5. **Acceptance criteria** — 3–8 observable, testable bullet conditions; always happy + unhappy path + edge cases; GWT only for complex rules/stateful flows; no implementation direction.
6. **Out of scope / non-goals + dependencies** — the anti-scope-creep field.
7. **Reference artifacts** — design/mockup links, screenshots, data sources.
8. **Definition of Ready** — item enters a sprint only when: problem & value written, AC present, edge cases discussed, dependencies known, a named person answers questions.
9. **Lock it post-planning** — AC agreed at refinement, then frozen; mid-sprint changes = new ticket or blocker.
10. **Keep it small** — if AC exceed ~5 or the story spans multiple roles, split it.
11. **Write it with the team, not alone.**
12. **AI drafting is fine as a first pass** — but the PO owns correctness; never ship AI output unedited.

---

## Source list

- "Do user stories actually make your process better or just slower?" — r/ProductManagement 1jtup6j
- "Why do you need user stories?" — r/agile 1n42avp
- "Do you do Acceptance Criteria in Scrum?" — r/agile 1o17b4j
- "At my wits end with product handing over incomplete requirements" — r/agile 1udhh5n
- "How long do you spend writing user stories?" — r/ProductManagement 183f9nl
- "Do you buy into gherkin syntax?" — r/ExperiencedDevs u29m3h
- "Experienced devs, what are your thoughts/experiences with BDD?" — r/ExperiencedDevs 1qqenj6
- "Has anyone actually been able to truly implement BDD and TDD?" — r/ExperiencedDevs nj7vhn
- "What technology becomes a maintenance nightmare later on?" — r/ExperiencedDevs 18bs1n9
- "Are user stories supposed to be problem definition or solution specifications?" — r/ProductManagement 1igufx2
- "Writing user stories (PM who hates writing them)" — r/ProductManagement 1j6jiqk
- "Completely back end 'user' stories" — r/ProductManagement 1e5kfs2
- "AI is producing our increment faster than we can refine the backlog" — r/scrum 1udqffq

All findings are practitioner anecdote from Reddit; patterns across many independent commenters are the strongest signal (flagged widely-corroborated). The "story = conversation placeholder / 3Cs" framing independently appears in nearly every thread and traces to XP's founders.
