# OpenCode Event Model — Reference for Fredo Mission Monitor

## Event Stream (SSE)

OpenCode emits events via Server-Sent Events at `GET /event`. Each event has:
```
{ type: string, properties: { ... } }
```

The global event wrapper is `{ directory: string, payload: Event }`.

## Complete Event Catalog

### Session Lifecycle
| Event | Properties | Notes |
|-------|-----------|-------|
| `session.created` | `info: Session` | Session created |
| `session.updated` | `info: Session` | Session metadata changed |
| `session.deleted` | `info: Session` | Session deleted |
| `session.status` | `sessionID, status: { type: "idle" | "busy" | "retry" }` | Status change |
| `session.idle` | `sessionID` | Session idle |
| `session.error` | `sessionID?, error?` | Error occurred |

### Messages
| Event | Properties | Notes |
|-------|-----------|-------|
| `message.updated` | `info: Message` | Message created or updated |
| `message.removed` | `sessionID, messageID` | Message removed |

### Message Parts (content delivery)
| Event | Properties | Notes |
|-------|-----------|-------|
| `message.part.updated` | `part: Part, delta?: string` | Part updated (streaming delta included) |
| `message.part.removed` | `sessionID, messageID, partID` | Part removed |

### Tools & Editing
| Event | Properties | Notes |
|-------|-----------|-------|
| `file.edited` | `file: string` | File was edited |
| `command.executed` | `name, sessionID, arguments, messageID` | Command executed |
| `todo.updated` | `sessionID, todos: Todo[]` | Todo list updated |

### Permissions
| Event | Properties | Notes |
|-------|-----------|-------|
| `permission.updated` | `Permission` | Permission state changed |
| `permission.replied` | `sessionID, permissionID, response` | Permission answered |

---

## Message Types

### UserMessage (role: "user")
```ts
{
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string, modelID: string }
  tools?: { [key: string]: boolean }
  system?: string
  summary?: { title?, body?, diffs: FileDiff[] }
}
```
**IMPORTANT**: UserMessage has NO `content` or `text` field. The text comes via `message.part.updated` events.

### AssistantMessage (role: "assistant")
```ts
{
  id: string, sessionID: string, role: "assistant"
  parentID: string
  modelID: string, providerID: string
  mode: string
  time: { created: number, completed?: number }
  error?: ...
  tokens: { input: number, output: number, reasoning: number, cache: { read, write } }
  cost: number
  finish?: string
}
```
Tokens live in `info.tokens.input/output/reasoning` — NOT in `gen_ai.usage.*`.

---

## Part Types (content inside messages)

Each part is delivered via `message.part.updated` with `properties.part: Part`.

### TextPart — user message text and assistant responses
```ts
{ type: "text", id, sessionID, messageID, text: string, synthetic?, ignored?, time?: { start, end? } }
```
**This is where the actual message content lives.** `part.text` contains the text.

### ReasoningPart — agent thinking
```ts
{ type: "reasoning", id, sessionID, messageID, text: string, time: { start, end? } }
```

### ToolPart — tool calls
```ts
{
  type: "tool", id, sessionID, messageID, callID, tool: string,
  state: { status: "pending"|"running"|"completed"|"error", input, output?, error?, ... }
}
```

### FilePart — attached files
```ts
{ type: "file", id, sessionID, messageID, mime, filename?, url, source? }
```

### StepStartPart / StepFinishPart — agent steps
```ts
StepStartPart: { type: "step-start", snapshot? }
StepFinishPart: { type: "step-finish", reason, cost, tokens }
```

### Other parts
- `AgentPart`: agent handoff (`name`)
- `PatchPart`: file patches (`hash, files[]`)
- `RetryPart`: retry info (`attempt, error`)
- `CompactionPart`: context compaction (`auto`)
- `SubtaskPart`: subtask definition (`prompt, description, agent`)

---

## How to Capture a Complete Conversation Turn

A single user→assistant turn produces these events:

1. **`message.updated`** with `info.role: "user"` — user message created (has model, agent. NO text)
2. **`message.part.updated`** with `part.type: "text"` for the user message — THIS has the user's text in `part.text`
3. **`message.part.updated`** with `part.type: "reasoning"` — agent thinking text, maybe multiple with deltas
4. **`message.part.updated`** with `part.type: "tool"` × N — each tool call (status: pending→running→completed)
5. **`message.part.updated`** with `part.type: "text"` for the assistant — final response text
6. **`message.part.updated`** with `part.type: "step-start"` / `"step-finish"` — step boundaries
7. **`message.updated`** with `info.role: "assistant"` — assistant message complete, has tokens/cost

### For Fredo Mission Monitor, minimal capture per turn:

| Event | What we get |
|-------|-------------|
| `message.updated` (user) | user msg ID, agent, model, sessionID |
| `message.part.updated` (text, user's messageID) | USER PROMPT TEXT |
| `message.part.updated` (reasoning) | THINKING TEXT |
| `message.part.updated` (text, assistant's messageID) | RESPONSE TEXT |
| `message.updated` (assistant) | TOKENS (input/output/reasoning/cache) |
| `message.part.updated` (tool) × N | TOOL CALLS (type, input, output) |
| `file.edited` × N | FILES EDITED |

### Counter mapping:
| Counter | Event |
|---------|-------|
| Tools | `message.part.updated` with `part.type: "tool"` (dedup by part.id) |
| Files | `file.edited` |
| Subagents | `message.part.updated` with `part.type: "agent"` or `part.type: "subtask"` |
| Tokens | `message.updated` (assistant) → `properties.info.tokens.input + .output` |

---

## Adapted from OpenCode SDK Types
Source: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
Fetched: 2026-06-15
