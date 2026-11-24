/**
 * config.test.ts — enablement (default-on / opt-out precedence) and endpoint
 * precedence for the V2 plugin config (Spec #3197 ST-1, EARS R-5 / R-5.1 / NFR-4).
 *
 * The resolver takes an injected environment record, so every case is
 * deterministic and nothing here mutates `process.env`.
 */

import { describe, expect, test } from "bun:test";
import { isTelemetryEnabled, loadConfig, parseEnvInt } from "./config";
import { DEFAULT_ENDPOINT, DEFAULT_PROTOCOL } from "./telemetry-constants";

describe("isTelemetryEnabled — DEFAULT-ON (R-5.1)", () => {
  test("capture is ON with no environment at all (the V1 opt-in gate is inverted)", () => {
    expect(isTelemetryEnabled({}, {})).toBe(true);
  });

  test("capture is ON with unrelated env vars present", () => {
    expect(isTelemetryEnabled({}, { HOME: "/home/x", OPENCODE_OTLP_ENDPOINT: "http://a:1" })).toBe(true);
  });

  test("a positive/garbage OPENCODE_ENABLE_TELEMETRY value does not disable capture", () => {
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "1" })).toBe(true);
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "yes" })).toBe(true);
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "" })).toBe(true);
  });

  test("a garbage FREDO_TELEMETRY value does not disable capture", () => {
    expect(isTelemetryEnabled({}, { FREDO_TELEMETRY: "1" })).toBe(true);
    expect(isTelemetryEnabled({}, { FREDO_TELEMETRY: "true" })).toBe(true);
    expect(isTelemetryEnabled({}, { FREDO_TELEMETRY: "yes" })).toBe(true);
  });
});

describe("isTelemetryEnabled — FREDO_TELEMETRY opt-out (R-5)", () => {
  test("0 | false | off disable capture, case-insensitively", () => {
    for (const value of ["0", "false", "off", "FALSE", "Off", "  false  "]) {
      expect(isTelemetryEnabled({}, { FREDO_TELEMETRY: value })).toBe(false);
    }
  });

  test("the opt-out wins over a set OPENCODE_ENABLE_TELEMETRY", () => {
    expect(
      isTelemetryEnabled({}, { FREDO_TELEMETRY: "0", OPENCODE_ENABLE_TELEMETRY: "1" }),
    ).toBe(false);
  });
});

describe("isTelemetryEnabled — OPENCODE_ENABLE_TELEMETRY retained (R-5)", () => {
  test("0 | false disable capture", () => {
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "0" })).toBe(false);
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "false" })).toBe(false);
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "FALSE" })).toBe(false);
  });

  test("its ABSENCE no longer disables capture (the inverted V1 gate)", () => {
    expect(isTelemetryEnabled({}, {})).toBe(true);
  });

  test("`off` is NOT an opt-out token for this variable (its documented set is 0|false)", () => {
    expect(isTelemetryEnabled({}, { OPENCODE_ENABLE_TELEMETRY: "off" })).toBe(true);
  });
});

describe("isTelemetryEnabled — plugin option is highest precedence", () => {
  test("enabled: false disables capture even with no environment opt-out", () => {
    expect(isTelemetryEnabled({ enabled: false }, {})).toBe(false);
  });

  test("enabled: false wins over a positive environment", () => {
    expect(
      isTelemetryEnabled(
        { enabled: false },
        { OPENCODE_ENABLE_TELEMETRY: "1", FREDO_TELEMETRY: "1" },
      ),
    ).toBe(false);
  });

  test("enabled: true is an explicit opt-in and wins over every environment opt-out", () => {
    expect(isTelemetryEnabled({ enabled: true }, { FREDO_TELEMETRY: "0" })).toBe(true);
    expect(isTelemetryEnabled({ enabled: true }, { OPENCODE_ENABLE_TELEMETRY: "0" })).toBe(true);
  });

  test("a non-boolean `enabled` is ignored and falls through to the environment", () => {
    expect(isTelemetryEnabled({ enabled: "false" as unknown as boolean }, {})).toBe(true);
    expect(
      isTelemetryEnabled({ enabled: "false" as unknown as boolean }, { FREDO_TELEMETRY: "0" }),
    ).toBe(false);
  });
});

describe("loadConfig — enablement is wired into the resolved config", () => {
  test("default-on resolves enabled: true", () => {
    expect(loadConfig({}, {}).enabled).toBe(true);
  });

  test("the opt-out resolves enabled: false", () => {
    expect(loadConfig({}, { FREDO_TELEMETRY: "0" }).enabled).toBe(false);
  });
});

describe("loadConfig — endpoint / protocol precedence (NFR-4)", () => {
  test("defaults when neither option nor env provide an endpoint", () => {
    const config = loadConfig({}, {});
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(config.endpoint).toBe("http://localhost:4317");
    expect(config.protocol).toBe(DEFAULT_PROTOCOL);
    expect(config.protocol).toBe("grpc");
  });

  test("OPENCODE_OTLP_ENDPOINT wins over the default", () => {
    expect(loadConfig({}, { OPENCODE_OTLP_ENDPOINT: "http://127.0.0.1:5101" }).endpoint).toBe(
      "http://127.0.0.1:5101",
    );
  });

  test("the plugin option wins over the environment", () => {
    expect(
      loadConfig(
        { endpoint: "http://option:1234" },
        { OPENCODE_OTLP_ENDPOINT: "http://env:4321" },
      ).endpoint,
    ).toBe("http://option:1234");
  });

  test("an empty-string option falls through to the environment", () => {
    expect(
      loadConfig({ endpoint: "" }, { OPENCODE_OTLP_ENDPOINT: "http://env:4321" }).endpoint,
    ).toBe("http://env:4321");
  });

  test("protocol follows option → env → default and rejects invalid values", () => {
    expect(loadConfig({}, { OPENCODE_OTLP_PROTOCOL: "http/protobuf" }).protocol).toBe(
      "http/protobuf",
    );
    expect(
      loadConfig({ protocol: "http/json" }, { OPENCODE_OTLP_PROTOCOL: "grpc" }).protocol,
    ).toBe("http/json");
    expect(loadConfig({}, { OPENCODE_OTLP_PROTOCOL: "not-a-protocol" }).protocol).toBe(DEFAULT_PROTOCOL);
  });

  test("metric prefix defaults to the fredo. prefix and honours the env", () => {
    expect(loadConfig({}, {}).metricPrefix).toBe("fredo.");
    expect(loadConfig({}, { OPENCODE_METRIC_PREFIX: "custom." }).metricPrefix).toBe("custom.");
  });

  test("traceparent / tracestate follow option → env", () => {
    const config = loadConfig(
      { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      { OPENCODE_TRACESTATE: "vendor=value" },
    );
    expect(config.traceparent).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
    expect(config.tracestate).toBe("vendor=value");
  });
});

describe("parseEnvInt", () => {
  test("returns the fallback for absent/invalid values and parses positive integers", () => {
    expect(parseEnvInt("MISSING", 42, {})).toBe(42);
    expect(parseEnvInt("X", 42, { X: "0" })).toBe(42);
    expect(parseEnvInt("X", 42, { X: "-5" })).toBe(42);
    expect(parseEnvInt("X", 42, { X: "abc" })).toBe(42);
    expect(parseEnvInt("X", 42, { X: "1500" })).toBe(1500);
  });
});
