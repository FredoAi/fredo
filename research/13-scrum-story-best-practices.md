# Research Report: Scrum Story Best Practices

**Agent:** Research Analyst (Scrum/story practices)
**Date:** 2026-08-01
**Scope:** User story format, INVEST, acceptance criteria, 3 C's, story sizing, business value

---

## Executive Summary — Top 10 Findings

1. **The "As a <role>, I want <feature>, so that <benefit>" template is the Connextra template (London, ~2001), popularized by Mike Cohn's *User Stories Applied* (2004).** It is a *starting point and a conversation placeholder*, not a requirements document.
2. **The written card is deliberately minimal.** Ron Jeffries' "3 C's" — **Card, Conversation, Confirmation** — make the card a *token*, not the requirement; the detail lives in the conversation and the acceptance tests.
3. **The "so that" clause is the value carrier** — Cohn calls it "the most important part" even though he keeps it technically optional. It lets the team choose *how*.
4. **INVEST (Bill Wake, 2003) is the standard quality gate**: Independent, Negotiable, Valuable, Estimable, Small, Testable. A *self-check on the card*, meant to trigger a rewrite when any letter fails.
5. **"As a user" does not make it a user story.** Gojko Adzic: a fake story is a lie about who wants it and why, and it silently spawns feature creep. The story must capture a *real stakeholder and a real benefit*.
6. **Gherkin/Given-When-Then is a *test/specification* style (BDD), not a story-writing style.** Cohn explicitly warns it's weaker than the story template for talking to customers. **Recommendation: bullets by default, GWT only for genuinely multi-condition scenarios.**
7. **A good story is a vertical slice, not a layer.** Split by workflow path, business rule, interface, or data (SPIDR), not frontend/backend/database.
8. **Size guidance converges on "well under a sprint."** Any single item ≥ ~50% of the sprint is a warning sign.
9. **Definition of Done is a Scrum artifact commitment; Definition of Ready is a popular team practice, not a Scrum Guide concept.**
10. **Not every backlog item should be a user story.** Use technical stories, job stories, or free text for backend/architectural work — label tech work honestly.

---

## 1. The User Story Format

### Anatomy
The Connextra template (XP team, London 2001; Rachel Davies credited; standardized by Mike Cohn):

> **As a <type of user>, I want <some goal>, so that <some reason>.**

Cohn simplified to **Who / What / Why**. The Who must be *specific* — never default to "As a user". The What may be "I am required to..." (nobody *wants* a strong-password gate). The Why ("so that") is "the most important part of a story" because it drives the *how*; Cohn writes it ~97% of the time.

**Alternatives:**
- **Feature-injection (Chris Matts):** "In order to <benefit> as a <role>, I can <goal>" — value first.
- **5-W template:** "As <who> <when> <where>, I want <what> because <why>."
- **Job stories:** "When I..., I want to..., so I can..."
- **Abuse/evil stories** for security.

### When stories work vs don't
- **Work:** user/customer-facing functionality with a specific role and concrete benefit. Cohn's claimed advantage: the card is "a placeholder for a future conversation" — writing shifts focus from *writing* to *talking* about requirements.
- **Don't work:** scale-up, formal/legal agreements, non-functional requirements (NFRs), systems with few/no end users, technical/architectural requirements (use technical stories or UML).

---

## 2. The INVEST Checklist

| Letter | Meaning | Guidance |
|---|---|---|
| **I** | Independent | Self-contained; schedulable in any order |
| **N** | Negotiable | Captures what/why, leaves *how* to the conversation; ACs state observable outcomes, not implementation |
| **V** | Valuable | Valuable to the *customer*, not just developers; vertical slice |
| **E** | Estimable | Sizeable enough to rank/schedule. **Most-abused letter — even by its author** (Wake: "If I could re-pick, we'd have 'E = External'"); NoEstimates movement argues estimates are harmful |
| **S** | Small | A few person-days to a few person-weeks; no single item ≥ ~50% of an iteration |
| **T** | Testable | "I understand this well enough that I *could* write a test for it" |

---

## 3. Acceptance Criteria: Gherkin vs Bullets vs BDD

- **ACs = "conditions of satisfaction"** (Cohn): notes about what the story must do for the PO to accept it. Pichler: **3–5 ACs** per detailed story.
- **Bullet-list ACs:** Cohn's canonical examples are simple bullets. Default for a PO.
- **Given-When-Then / Gherkin / BDD:** invented by Dan North + Chris Matts as part of BDD. Fowler defines it as "a style of representing tests." Cucumber: **3–5 steps per example**; Then asserts **observable** output, not DB internals; avoid technology assumptions.
- **The core tension:**
  - Advocates (Cucumber/Fowler/Gojko): GWT is the executable-spec standard.
  - Critics/pragmatists (Cohn): GWT "is a great way for expressing tests... but it's not as good for communicating with customers... I don't know if I've ever started a sentence with *given*."
  - Gojko: GWT is "a very sharp tool and unless handled properly, it can hurt badly" — one `When` per scenario, past/passive Givens, observable Thens.
- **Recommendation for a PO:** bullets by default; GWT only for the 1–2 genuinely complex scenarios; NFRs as a separate explicit checklist.

---

## 4. The 3 C's — Why the Card Is Minimal

Ron Jeffries (2001): Card, Conversation, Confirmation.
- **Card** — "just enough text to identify the requirement, and to remind everyone what the story is. The card is a token representing the requirement."
- **Conversation** — the requirement is communicated through *exchange*; best supplements are examples, best examples are executable.
- **Confirmation** — the acceptance tests; "when the conversation about a card gets down to the details of the acceptance test, the customer and programmer settle the final details."

Cockburn: "A user story is a promise for a conversation." → **The issue body is the Card: just enough to identify and remind. The richness lives in context links + confirmation/ACs.**

---

## 5. Story Size and Splitting

- **How small:** a few person-days to a few person-weeks; **no single item > 50% of an iteration** (≤5 days in a 10-day sprint); the 90%-done syndrome argues for smaller.
- **Right slice:** vertical, not by layer. "Build the payment backend" is "a task masquerading as a story"; "A customer can pay by credit card using the happy path" is a good split.
- **SPIDR (Cohn):** Spike (time-boxed investigation), Paths (happy path first), Interfaces (UI/platform/channel), Data (type/amount/source), Rules (business rules — relax in first iteration).
- **When to split:** look ~2 sprints ahead, not everything up front; splitting is a whole-team activity, not PO alone.

---

## 6. Business Value: Outcomes vs Outputs

- **The "so that" clause is the outcome.** Cohn's spellchecker example: the *why* changes the solution from post-hoc to real-time correction.
- **Value must belong to a real stakeholder** (Gojko).
- **Outcomes vs outputs:** describe a *capability that changes what someone can do*, not a list of delivered artifacts.
- **Business story vs technical task:** technical work is a legitimate backlog item but should say "Investigation of new tools..." plainly, not be dressed as a user story.

---

## 7. Anti-Patterns Checklist

1. Stories written as tasks / split by technical boundary
2. Fake stories with no real value ("As a user, I want to register")
3. Epics masquerading as stories (can't fit a sprint)
4. Pre-baked solutions in the story (kills Negotiability)
5. "As a user" everywhere (lazy role)
6. Slavish template compliance (free-text items are fine)
7. No testability / no ACs
8. All business rules enforced from day one
9. A spike on every story
10. PO splits alone

---

## 8. Concrete Recommendations for a PO Issue Template

1. **Title = the card sentence.** One line, Connextra format, specific role; feature-injection or technical-story marker if no role fits.
2. **Statement / Why now (value carrier).** 1–2 sentences: outcome for whom, why now, measurable signal. If this can't be written, don't create the issue.
3. **Acceptance Criteria — 3–5 bullets by default** (Pichler/Cohn), each independently verifiable, observable, demo-able; at least one edge/negative case; never implementation internals.
4. **Complex scenarios as GWT (only where needed).** Reserve for genuinely multi-condition scenarios; one `When`, observable `Then`s.
5. **Constraints / what's deliberately excluded.** State the slice's constraint (happy path only, one data source, etc.).
6. **Invest + Ready self-check block.** One-line INVEST audit + Ready statement (clear, feasible, testable, fits a sprint).
7. **Done statement.** Reference the shared Definition of Done rather than restating org-wide quality.
8. **NFR / constraints checklist** (performance, security, usability, accessibility).
9. **Context links, not embedded solutions.** Attach epic/theme, story map position, mockups; put *how* in the conversation.
10. **Item type honesty.** Classify: user story / business story / technical story / task / spike / bug / NFR.
11. **Size discipline.** If > half a sprint, attach SPIDR split plan, create the first child slice now.
12. **Falsifiable value.** Phrase "so that" so it can be validated.

---

## Source List

- Wikipedia — User story: https://en.wikipedia.org/wiki/User_story
- Mike Cohn / Mountain Goat — User Stories: https://www.mountaingoatsoftware.com/agile/user-stories
- Mike Cohn — User Story Template: https://www.mountaingoatsoftware.com/blog/why-the-three-part-user-story-template-works-so-well
- Gojko Adzic — "As a User" doesn't make it a story: https://gojko.net/2013/09/30/writing-as-a-user-does-not-make-it-a-user-story/
- Roman Pichler — 10 Tips: https://www.romanpichler.com/blog/10-tips-writing-good-user-stories/
- Ron Jeffries — Card, Conversation, Confirmation: https://ronjeffries.com/xprog/articles/expcardconversationconfirmation/
- Bill Wake — INVEST: https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/
- Agile Alliance — INVEST: https://agilealliance.org/glossary/invest
- Martin Fowler — Given When Then: https://martinfowler.com/bliki/GivenWhenThen.html
- Cucumber — Gherkin Reference: https://cucumber.io/docs/gherkin/reference/
- Gojko — GWT: https://gojko.net/2015/02/25/how-to-get-the-most-out-of-given-when-then/
- Mountain Goat — Story Splitting (SPIDR): https://www.mountaingoatsoftware.com/agile/user-stories/story-splitting-how-to-split-user-stories-so-teams-can-finish
- Scrum Guide 2020 — DoD: https://scrumguides.org/scrum-guide.html
- Agile Alliance — DoR: https://agilealliance.org/glossary/definition-of-ready/
- Jeff Patton — The New User Story Backlog is a Map: https://jpattonassociates.com/the-new-backlog/
