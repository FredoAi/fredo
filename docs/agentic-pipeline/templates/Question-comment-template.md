# Question Comment Template

> Used by any pipeline agent to raise an open question (e.g. to the Product Owner) on the **feature issue** via the `comment` action (`--prefix Question`). Draft this file as `.opencode/tmp/<issue>/question.md`, then run:
> `rust-script .opencode/scripts/pipeline-state.rs --issue <N> --agent <you> --action comment --prefix Question [--body-file .opencode/tmp/<issue>/question.md]`
> The state machine prefixes `## Question` automatically and posts it.

## <the question, one topic>

- <context / why it blocks>
- <what you need answered, options if relevant>

**Needs decision from:** <Product Owner / Self-Improver / <planner>>

*Authored by <Agent Name>*
