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
 * REQ-5: Build gen_ai.usage.* attributes for token counts.
 * Always paired with the existing `input_tokens`/`output_tokens` attributes.
 *
 * @param inputTokens - Input/prompt token count.
 * @param outputTokens - Output/completion token count.
 * @returns An Attributes object with gen_ai.usage fields.
 */
export function genAiUsageAttrs(
  inputTokens: number,
  outputTokens: number,
): Attributes {
  const attrs: Attributes = {};
  if (inputTokens > 0) attrs[GEN_AI_USAGE_INPUT_TOKENS] = inputTokens;
  if (outputTokens > 0) attrs[GEN_AI_USAGE_OUTPUT_TOKENS] = outputTokens;
  return attrs;
}

/**
 * Validate that a gen_ai.operation.name value is one of the supported values.
 */
export function validateGenAiOpName(value: string): boolean {
  return value === OP_NAME_SESSION || value === OP_NAME_CHAT || value === OP_NAME_TOOL;
}
