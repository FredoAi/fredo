/**
 * contract_633.test.ts — Unit tests for the GA-5 / GA-6 / GA-7 gen_ai.* contract
 * builders (OTel GenAI semantic conventions): exception event attributes
 * (gen-ai-exceptions.md) and the inference-operation-details event attributes
 * (gen-ai-events.md). The registry (source of truth) key names are asserted
 * verbatim — a rename in the builder is a test failure.
 */

import { describe, expect, test } from "bun:test";
import {
  ATTR_OP_NAME,
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_ERROR_TYPE,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  OP_NAME_CHAT,
  genAiExceptionAttrs,
  genAiExceptionEventAttrs,
  genAiInferenceDetailsAttrs,
  genAiPromptAttr,
  genAiResponseBodyAttr,
} from "./contract_633";

describe("genAiExceptionEventAttrs (GA-6, gen-ai-exceptions.md)", () => {
  test("emits exception.type, exception.message, and exception.stacktrace", () => {
    const attrs = genAiExceptionEventAttrs({
      type: "RateLimitError",
      message: "RateLimitError: 429 too many requests",
      stacktrace: "at handler (message.ts:1:1)",
    });
    expect(attrs[EXCEPTION_TYPE]).toBe("RateLimitError");
    expect(attrs[EXCEPTION_MESSAGE]).toBe("RateLimitError: 429 too many requests");
    expect(attrs[EXCEPTION_STACKTRACE]).toBe("at handler (message.ts:1:1)");
  });

  test("omits absent keys (at least one of type/message must be present per spec)", () => {
    expect(genAiExceptionEventAttrs({})).toEqual({});
    expect(genAiExceptionEventAttrs({ type: "Timeout" })).toEqual({
      [EXCEPTION_TYPE]: "Timeout",
    });
    expect(genAiExceptionEventAttrs({ message: "boom" })).toEqual({
      [EXCEPTION_MESSAGE]: "boom",
    });
  });
});

describe("genAiExceptionAttrs (GA-6, opencode error object)", () => {
  test("maps error.name to exception.type and errorSummary to exception.message", () => {
    const attrs = genAiExceptionAttrs({ name: "APIError" });
    expect(attrs[EXCEPTION_TYPE]).toBe("APIError");
    expect(attrs[EXCEPTION_MESSAGE]).toBe("APIError");
  });

  test("includes data.message in exception.message and data.stack as stacktrace", () => {
    const attrs = genAiExceptionAttrs({
      name: "APIError",
      data: { message: "provider unavailable", stack: "at api (client.ts:10)" },
    });
    expect(attrs[EXCEPTION_TYPE]).toBe("APIError");
    expect(attrs[EXCEPTION_MESSAGE]).toBe("APIError: provider unavailable");
    expect(attrs[EXCEPTION_STACKTRACE]).toBe("at api (client.ts:10)");
  });

  test("returns an empty object for an undefined error", () => {
    expect(genAiExceptionAttrs(undefined)).toEqual({});
  });

  test("omits stacktrace when data has no stack", () => {
    const attrs = genAiExceptionAttrs({ name: "APIError", data: { message: "x" } });
    expect(attrs[EXCEPTION_TYPE]).toBe("APIError");
    expect(attrs[EXCEPTION_MESSAGE]).toBe("APIError: x");
    expect(attrs[EXCEPTION_STACKTRACE]).toBeUndefined();
  });
});

describe("genAiInferenceDetailsAttrs (GA-5, gen-ai-events.md)", () => {
  const usage = {
    input: 100,
    output: 20,
    reasoning: 5,
    cacheRead: 10,
    cacheCreation: 3,
  };

  test("always carries gen_ai.operation.name=chat and omits unknown provider/model", () => {
    const attrs = genAiInferenceDetailsAttrs({
      providerID: "unknown",
      modelID: "unknown",
      sessionID: "sess-1",
      usage,
    });
    expect(attrs[ATTR_OP_NAME]).toBe(OP_NAME_CHAT);
    expect(attrs[GEN_AI_PROVIDER_NAME]).toBeUndefined();
    expect(attrs[GEN_AI_REQUEST_MODEL]).toBeUndefined();
    expect(attrs[GEN_AI_RESPONSE_MODEL]).toBeUndefined();
    expect(attrs[GEN_AI_CONVERSATION_ID]).toBe("sess-1");
  });

  test("carries provider/model under CURRENT registry names when known", () => {
    const attrs = genAiInferenceDetailsAttrs({
      providerID: "anthropic",
      modelID: "claude-3-7-sonnet",
      sessionID: "sess-1",
      usage,
      finish: "stop",
    });
    expect(attrs[GEN_AI_PROVIDER_NAME]).toBe("anthropic");
    expect(attrs[GEN_AI_REQUEST_MODEL]).toBe("claude-3-7-sonnet");
    expect(attrs[GEN_AI_RESPONSE_MODEL]).toBe("claude-3-7-sonnet");
    expect(attrs[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
  });

  test("emits the full usage family only for positive counts (zero never emitted)", () => {
    const attrs = genAiInferenceDetailsAttrs({
      providerID: "openai",
      sessionID: "sess-1",
      usage,
    });
    expect(attrs[GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(attrs[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);
    expect(attrs[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]).toBe(5);
    expect(attrs[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(10);
    expect(attrs[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(3);
  });

  test("omits zero usage counts (contract genAiUsageAttrs)", () => {
    const attrs = genAiInferenceDetailsAttrs({
      providerID: "openai",
      sessionID: "sess-1",
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0 },
    });
    expect(attrs[GEN_AI_USAGE_INPUT_TOKENS]).toBeUndefined();
    expect(attrs[GEN_AI_USAGE_OUTPUT_TOKENS]).toBeUndefined();
    expect(attrs[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]).toBeUndefined();
    expect(attrs[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]).toBeUndefined();
    expect(attrs[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]).toBeUndefined();
  });

  test("does NOT carry input/output content keys (they live on span attributes) plus error.type on failed operations", () => {
    const attrs = genAiInferenceDetailsAttrs({
      providerID: "openai",
      modelID: "gpt-4o",
      sessionID: "sess-1",
      inputText: "say hi",
      outputText: "hi",
      usage: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheCreation: 0 },
      errorType: "RateLimitError",
    });
    expect(attrs[GEN_AI_INPUT_MESSAGES]).toBeUndefined();
    expect(attrs[GEN_AI_OUTPUT_MESSAGES]).toBeUndefined();
    expect(attrs[GEN_AI_ERROR_TYPE]).toBe("RateLimitError");
  });
});

describe("genAiPromptAttr (REQ-3, gen-ai-spans.md note 25)", () => {
  test("emits gen_ai.input.messages as a JSON-string user message array", () => {
    const attrs = genAiPromptAttr("Write a haiku");
    const raw = attrs[GEN_AI_INPUT_MESSAGES];
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual([
      { role: "user", parts: [{ type: "text", content: "Write a haiku" }] },
    ]);
  });

  test("omits the attribute when the instruction text is empty", () => {
    expect(genAiPromptAttr(undefined)).toEqual({});
    expect(genAiPromptAttr("   ")).toEqual({});
  });
});

describe("genAiResponseBodyAttr (REQ-4, gen-ai-spans.md note 26)", () => {
  test("emits gen_ai.output.messages as a JSON-string assistant message array", () => {
    const attrs = genAiResponseBodyAttr("The weather is sunny.");
    const raw = attrs[GEN_AI_OUTPUT_MESSAGES];
    expect(typeof raw).toBe("string");
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "The weather is sunny." }] },
    ]);
  });

  test("includes finish_reason when the payload provides it", () => {
    const attrs = genAiResponseBodyAttr("Done.", "stop");
    const raw = attrs[GEN_AI_OUTPUT_MESSAGES];
    const parsed = JSON.parse(raw as string);
    expect(parsed[0].finish_reason).toBe("stop");
  });

  test("omits finish_reason when absent (never fabricated, EARS-11)", () => {
    const attrs = genAiResponseBodyAttr("Done.");
    const raw = attrs[GEN_AI_OUTPUT_MESSAGES];
    const parsed = JSON.parse(raw as string);
    expect(parsed[0]).not.toHaveProperty("finish_reason");
  });

  test("omits the attribute when the response text is empty", () => {
    expect(genAiResponseBodyAttr(undefined)).toEqual({});
    expect(genAiResponseBodyAttr("")).toEqual({});
  });
});
