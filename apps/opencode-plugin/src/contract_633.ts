/**
 * contract_633.ts — Shared contract for Spec #633 (Span Hierarchy Rework).
 *
 * Capsule A (Plugin) implements against this contract.
 * Capsule B (Adapter) consumes the span attributes and links defined here.
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

/** User prompt / instruction text on LLM spans. */
export const GEN_AI_PROMPT = "gen_ai.prompt" as const;

/** Agent response text on completed LLM spans. */
export const GEN_AI_RESPONSE_BODY = "gen_ai.response.body" as const;

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
 * REQ-3: Build gen_ai.prompt attribute for instruction text.
 * Always paired with the existing `prompt` attribute for backward compatibility.
 *
 * @param text - The instruction/prompt text (non-empty).
 * @returns An Attributes object or empty object if text is empty.
 */
export function genAiPromptAttr(text: string | undefined): Attributes {
  if (!text || text.trim().length === 0) return {};
  return { [GEN_AI_PROMPT]: text };
}

/**
 * REQ-4: Build gen_ai.response.body attribute for agent response text.
 * Always paired with the existing `response_text` attribute for backward compatibility.
 *
 * @param text - The agent response text.
 * @returns An Attributes object or empty object if text is empty.
 */
export function genAiResponseBodyAttr(text: string | undefined): Attributes {
  if (!text || text.trim().length === 0) return {};
  return { [GEN_AI_RESPONSE_BODY]: text };
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
