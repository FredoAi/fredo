/**
 * genai-conventions.ts — OTel GenAI semantic-convention helpers for the Fredo OpenCode plugin.
 *
 * gen_ai.operation.name values, the gen_ai.* registry attribute keys, and the
 * attribute builders that emit them. Capsule A (Plugin) implements against this
 * contract; Capsule B (Adapter) consumes the span attributes and links defined here.
 *
 * READ-ONLY: Only the Software Architect edits this file. Developers implement against it.
 */

import type { SpanContext, Link, Attributes } from "@opentelemetry/api";

// ── gen_ai.operation.name Values ────────────────────────────────────────────

/** gen_ai.operation.name value for session spans (fredo.session). */
export const OP_NAME_SESSION = "run_agent" as const;

/** gen_ai.operation.name value for LLM spans (fredo.llm). */
export const OP_NAME_CHAT = "chat" as const;

/** gen_ai.operation.name value for tool spans (fredo.tool.*). */
export const OP_NAME_TOOL = "execute_tool" as const;

/** OTel GenAI semantic convention attribute key. */
export const ATTR_OP_NAME = "gen_ai.operation.name" as const;

// ── gen_ai.* Attribute Keys (OTel GenAI Semantic Conventions) ────────────────

/** User instruction text on LLM spans, as a JSON-string message array (gen-ai-spans.md note 25). */
export const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages" as const;

/** Agent response text on completed LLM spans, as a JSON-string message array (gen-ai-spans.md note 26). */
export const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages" as const;

/** Input token count on completed LLM spans. */
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;

/** Output token count on completed LLM spans. */
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;

/** Reasoning output token count on completed LLM spans. */
export const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = "gen_ai.usage.reasoning.output_tokens" as const;

/** Cache-read input token count on completed LLM spans. */
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens" as const;

/** Cache-creation input token count on completed LLM spans. */
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = "gen_ai.usage.cache_creation.input_tokens" as const;

/** Provider discriminator on LLM spans (well-known values: anthropic, openai, deepseek, ...). */
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name" as const;

/** Requested model on LLM span creation. */
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;

/** Resolved model on completed LLM spans. */
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model" as const;

/** Finish reason list on completed LLM spans. */
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons" as const;

/** Conversation/session identifier on LLM, tool, and session spans. */
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id" as const;

/** Tool name on tool spans. */
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name" as const;

/** Tool call identifier on tool spans. */
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id" as const;

/** Tool call input, recorded as a JSON string on tool spans. */
export const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments" as const;

/** Tool call output, recorded as a JSON string on completed tool spans. */
export const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result" as const;

/** Agent name on tool and session spans (set when the agent is known). */
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name" as const;

/** Token type label for gen_ai.client.token.usage (well-known: input, output). */
export const GEN_AI_TOKEN_TYPE = "gen_ai.token.type" as const;

/** Error class identifier on operations that ended in an error (error.type). */
export const GEN_AI_ERROR_TYPE = "error.type" as const;

/** Registry event name for GenAI client operation exceptions (gen-ai-exceptions.md). */
export const GEN_AI_EVENT_EXCEPTION = "gen_ai.client.operation.exception" as const;

/** Registry event name for GenAI completion request details (gen-ai-events.md, Opt-In). */
export const GEN_AI_EVENT_INFERENCE_DETAILS = "gen_ai.client.inference.operation.details" as const;

/** Exception type attribute (gen-ai-exceptions.md, Conditionally Required). */
export const EXCEPTION_TYPE = "exception.type" as const;

/** Exception message attribute (gen-ai-exceptions.md, Conditionally Required). */
export const EXCEPTION_MESSAGE = "exception.message" as const;

/** Exception stacktrace attribute (gen-ai-exceptions.md, Recommended). */
export const EXCEPTION_STACKTRACE = "exception.stacktrace" as const;

// ── Span Link Attribute Keys ─────────────────────────────────────────────────

/** Parent session ID, set as an attribute on the span link from child → parent. */
export const LINK_ATTR_PARENT_SESSION_ID = "parent.session_id" as const;

/** Relationship type, set as an attribute on the span link from child → parent. */
export const LINK_ATTR_RELATIONSHIP_TYPE = "relationship.type" as const;

/** Relationship type value for parent-child relationships. */
export const RELATIONSHIP_TYPE_PARENT_CHILD = "parent-child" as const;

// ── Contract Functions ───────────────────────────────────────────────────────

/**
 * REQ-1: Create a span link from a child span to its parent session span.
 *
 * @param parentSpanContext - The OTel SpanContext of the parent session/run span.
 * @param parentSessionId - The parent's session ID to embed in the link attributes.
 * @returns An OTel Link object suitable for passing to `tracer.startSpan(_, { links: [...] })`.
 */
export function createParentSpanLink(
  parentSpanContext: SpanContext,
  parentSessionId: string,
): Link {
  return {
    context: parentSpanContext,
    attributes: {
      [LINK_ATTR_PARENT_SESSION_ID]: parentSessionId,
      [LINK_ATTR_RELATIONSHIP_TYPE]: RELATIONSHIP_TYPE_PARENT_CHILD,
    },
  };
}

/**
 * REQ-2: Build the gen_ai.operation.name attribute for a span.
 *
 * @param opName - One of OP_NAME_SESSION, OP_NAME_CHAT, or OP_NAME_TOOL.
 * @returns An Attributes object with the `gen_ai.operation.name` key.
 */
export function genAiOpNameAttr(opName: string): Attributes {
  return { [ATTR_OP_NAME]: opName };
}

/**
 * REQ-3: Build gen_ai.input.messages attribute for instruction text.
 * The value is a JSON-string message array (gen-ai-spans.md note 25: the OTel JS
 * SDK cannot represent arrays of objects, so arrays are emitted as JSON strings
 * on spans) matching the registry message-array schema.
 * Always paired with the existing `prompt` attribute for backward compatibility.
 *
 * @param text - The instruction/prompt text (non-empty).
 * @returns An Attributes object or empty object if text is empty.
 */
export function genAiPromptAttr(text: string | undefined): Attributes {
  if (!text || text.trim().length === 0) return {};
  return {
    [GEN_AI_INPUT_MESSAGES]: JSON.stringify([
      { role: "user", parts: [{ type: "text", content: text }] },
    ]),
  };
}

/**
 * REQ-4: Build gen_ai.output.messages attribute for agent response text.
 * The value is a JSON-string message array (gen-ai-spans.md note 26) matching
 * the registry message-array schema. `finish_reason` is included only when the
 * payload provides it — never fabricated (EARS-11).
 * Always paired with the existing `response_text` attribute for backward compatibility.
 *
 * @param text - The agent response text.
 * @param finish - The finish reason (optional; omitted when absent).
 * @returns An Attributes object or empty object if text is empty.
 */
export function genAiResponseBodyAttr(text: string | undefined, finish?: string): Attributes {
  if (!text || text.trim().length === 0) return {};
  const message: { role: string; parts: { type: string; content: string }[]; finish_reason?: string } = {
    role: "assistant",
    parts: [{ type: "text", content: text }],
  };
  if (finish) message.finish_reason = finish;
  return { [GEN_AI_OUTPUT_MESSAGES]: JSON.stringify([message]) };
}

/**
 * Token breakdown accepted by genAiUsageAttrs.
 * Fields are optional — counts that are absent or `<= 0` are never emitted.
 */
export interface GenAiUsageTokenCounts {
  input: number | undefined;
  output: number | undefined;
  reasoning: number | undefined;
  cacheRead: number | undefined;
  cacheCreation: number | undefined;
}

/**
 * REQ-5/GA-2: Build the full gen_ai.usage.* attribute family for token counts.
 * Always paired with the existing `input_tokens`/`output_tokens` attributes.
 * Follows the existing convention: attributes are skipped when the count is
 * absent or `<= 0` — a zero count is never emitted.
 *
 * @param counts - The input/output/reasoning/cache token breakdown.
 * @returns An Attributes object with the gen_ai.usage.* fields present.
 */
export function genAiUsageAttrs(counts: GenAiUsageTokenCounts): Attributes {
  const attrs: Attributes = {};
  if ((counts.input ?? 0) > 0) attrs[GEN_AI_USAGE_INPUT_TOKENS] = counts.input;
  if ((counts.output ?? 0) > 0) attrs[GEN_AI_USAGE_OUTPUT_TOKENS] = counts.output;
  if ((counts.reasoning ?? 0) > 0) attrs[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] = counts.reasoning;
  if ((counts.cacheRead ?? 0) > 0) attrs[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = counts.cacheRead;
  if ((counts.cacheCreation ?? 0) > 0) attrs[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS] = counts.cacheCreation;
  return attrs;
}

/**
 * GA-1: Build gen_ai.provider.name and gen_ai.request.model on LLM span creation.
 * Attributes are omitted when the payload does not provide the value ("unknown"
 * is the plugin's sentinel for a missing modelID/providerID).
 *
 * @param modelID - The requested model ID (openCode `info.modelID`).
 * @param providerID - The provider ID (openCode `info.providerID`).
 * @returns An Attributes object with the gen_ai request fields present.
 */
export function genAiRequestAttrs(
  modelID: string | undefined,
  providerID: string | undefined,
): Attributes {
  const attrs: Attributes = {};
  if (providerID && providerID !== "unknown") attrs[GEN_AI_PROVIDER_NAME] = providerID;
  if (modelID && modelID !== "unknown") attrs[GEN_AI_REQUEST_MODEL] = modelID;
  return attrs;
}

/**
 * GA-1/GA-3/GA-4: Build the gen_ai.conversation.id attribute for a span.
 *
 * @param sessionID - The conversation/session identifier.
 * @returns An Attributes object or empty object if sessionID is absent.
 */
export function genAiConversationAttr(sessionID: string | undefined): Attributes {
  if (!sessionID) return {};
  return { [GEN_AI_CONVERSATION_ID]: sessionID };
}

/**
 * GA-2: Build gen_ai.response.model and gen_ai.response.finish_reasons on
 * completed LLM spans.
 *
 * @param modelID - The resolved model ID (omitted when the payload lacks it).
 * @param finish - The finish reason (omitted when the payload lacks it).
 * @returns An Attributes object with the gen_ai response fields present.
 */
export function genAiResponseAttrs(
  modelID: string | undefined,
  finish: string | undefined,
): Attributes {
  const attrs: Attributes = {};
  if (modelID && modelID !== "unknown") attrs[GEN_AI_RESPONSE_MODEL] = modelID;
  if (finish) attrs[GEN_AI_RESPONSE_FINISH_REASONS] = [finish];
  return attrs;
}

/**
 * GA-3: Build gen_ai.tool.name and gen_ai.tool.call.id on tool spans.
 *
 * @param tool - The tool name (openCode `part.tool`).
 * @param callID - The tool call identifier (openCode `part.callID`).
 * @returns An Attributes object with the gen_ai tool fields present.
 */
export function genAiToolAttrs(
  tool: string | undefined,
  callID: string | undefined,
): Attributes {
  const attrs: Attributes = {};
  if (tool) attrs[GEN_AI_TOOL_NAME] = tool;
  if (callID) attrs[GEN_AI_TOOL_CALL_ID] = callID;
  return attrs;
}

/**
 * GA-3: Build the gen_ai.tool.call.arguments attribute on tool spans.
 * Recorded as a JSON STRING — the OTel JS SDK AttributeValue has no object type
 * (the spec permits JSON-string form on spans).
 *
 * @param input - The tool call input object (openCode `part.state.input`).
 * @returns An Attributes object or empty object if the input is absent.
 */
export function genAiToolCallArgumentsAttr(
  input: Record<string, unknown> | undefined,
): Attributes {
  if (!input) return {};
  return { [GEN_AI_TOOL_CALL_ARGUMENTS]: JSON.stringify(input) };
}

/**
 * GA-3: Build the gen_ai.tool.call.result attribute on completed tool spans.
 *
 * @param output - The tool call output text (openCode `part.state.output`).
 * @returns An Attributes object or empty object if the output is empty.
 */
export function genAiToolCallResultAttr(output: string | undefined): Attributes {
  if (!output) return {};
  return { [GEN_AI_TOOL_CALL_RESULT]: output };
}

/**
 * GA-3/GA-4: Build the gen_ai.agent.name attribute when the agent name is known.
 * Omitted when the agent is unresolved ("unknown" is the plugin's sentinel).
 *
 * @param agentName - The resolved agent name.
 * @returns An Attributes object or empty object if the agent is unknown.
 */
export function genAiAgentNameAttr(agentName: string | undefined): Attributes {
  if (!agentName || agentName === "unknown") return {};
  return { [GEN_AI_AGENT_NAME]: agentName };
}

/**
 * Validate that a gen_ai.operation.name value is one of the supported values.
 */
export function validateGenAiOpName(value: string): boolean {
  return value === OP_NAME_SESSION || value === OP_NAME_CHAT || value === OP_NAME_TOOL;
}

/**
 * GA-6: Extract the exception message from an opencode error object.
 * Mirrors `util.errorSummary`: `${name}: ${data.message}` when `data` provides
 * a message, otherwise the bare error name. Always returns a string for a
 * non-undefined error so `exception.type` / `exception.message` (at least one
 * mandatory per gen-ai-exceptions.md) is always present.
 */
function exceptionMessage(err: { name: string; data?: unknown }): string | undefined {
  const data = err.data;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return `${err.name}: ${message}`;
    }
  }
  return err.name;
}

/**
 * GA-6: Extract a stacktrace string from an opencode error object when the
 * payload carries one (`data.stack`). Recommended, omitted when unavailable.
 */
function exceptionStacktrace(err: { name: string; data?: unknown }): string | undefined {
  const data = err.data;
  if (data && typeof data === "object" && "stack" in data) {
    const stack = (data as { stack?: unknown }).stack;
    if (typeof stack === "string" && stack.length > 0) return stack;
  }
  return undefined;
}

/**
 * GA-6: Build the exception event attributes (gen-ai-exceptions.md) from an
 * explicit type/message/stacktrace triple. Keys are omitted when absent.
 *
 * @param input - The exception type, message, and optional stacktrace.
 * @returns An Attributes object with the exception.* fields present.
 */
export function genAiExceptionEventAttrs(input: {
  type?: string;
  message?: string;
  stacktrace?: string;
}): Attributes {
  const attrs: Attributes = {};
  if (input.type) attrs[EXCEPTION_TYPE] = input.type;
  if (input.message) attrs[EXCEPTION_MESSAGE] = input.message;
  if (input.stacktrace) attrs[EXCEPTION_STACKTRACE] = input.stacktrace;
  return attrs;
}

/**
 * GA-6: Build the exception event attributes (gen-ai-exceptions.md) from an
 * opencode error object. `exception.type` = error name, `exception.message` =
 * error summary, `exception.stacktrace` = data.stack when present.
 *
 * @param err - The opencode error object (may be undefined).
 * @returns An Attributes object with the exception.* fields present.
 */
export function genAiExceptionAttrs(
  err: { name: string; data?: unknown } | undefined,
): Attributes {
  if (!err) return {};
  return genAiExceptionEventAttrs({
    type: err.name,
    message: exceptionMessage(err),
    stacktrace: exceptionStacktrace(err),
  });
}

/**
 * GA-5: Build the attributes for the `gen_ai.client.inference.operation.details`
 * event (gen-ai-events.md, Opt-In) on a completed chat operation. Carries the
 * Required `gen_ai.operation.name` / `gen_ai.provider.name` discriminators plus
 * the conditional/recommended request/response/usage details. Input/output text
 * is NOT carried here — it lives on the span attributes as
 * `gen_ai.input.messages` / `gen_ai.output.messages` (events require the
 * structured form the JS SDK cannot produce; see gen-ai-events.md notes 25/26).
 *
 * @param input - The chat operation details from the message payload.
 * @returns An Attributes object with the gen_ai.* event fields present.
 */
export function genAiInferenceDetailsAttrs(input: {
  providerID?: string;
  modelID?: string;
  sessionID?: string;
  inputText?: string;
  outputText?: string;
  usage: GenAiUsageTokenCounts;
  finish?: string;
  errorType?: string;
}): Attributes {
  const attrs: Attributes = { ...genAiOpNameAttr(OP_NAME_CHAT) };
  if (input.providerID && input.providerID !== "unknown") {
    attrs[GEN_AI_PROVIDER_NAME] = input.providerID;
  }
  if (input.modelID && input.modelID !== "unknown") {
    attrs[GEN_AI_REQUEST_MODEL] = input.modelID;
    attrs[GEN_AI_RESPONSE_MODEL] = input.modelID;
  }
  if (input.sessionID) attrs[GEN_AI_CONVERSATION_ID] = input.sessionID;
  if (input.finish) attrs[GEN_AI_RESPONSE_FINISH_REASONS] = [input.finish];
  Object.assign(attrs, genAiUsageAttrs(input.usage));
  if (input.errorType) attrs[GEN_AI_ERROR_TYPE] = input.errorType;
  return attrs;
}
