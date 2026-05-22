/**
 * Type-contract tests for FredoEvent toolName field (REQ-3.8)
 *
 * REQ-3.8: The toolName field is preserved in FredoEvent for backward
 * compatibility with features that filter by tool name.
 *
 * These are COMPILE-TIME type assertions. If the types are correct,
 * the file will compile successfully. If not, TypeScript will error.
 */

import type {
  FredoEvent,
  EventType,
  EventProvider,
  Transport,
} from '../StreamContext';

// ─── FredoEvent.toolName field presence ───────────────────────────────────────

// Helper type to validate a field exists on FredoEvent
type AssertHasField<T, K extends keyof T> = K extends keyof T ? true : never;
type AssertToolNameField = AssertHasField<FredoEvent, 'toolName'>;

// If this compiles, toolName exists on FredoEvent
const _assertToolNameField: AssertToolNameField = true;

// ─── toolName is optional (backward compat, not required) ─────────────────────

type ToolNameIsOptional = undefined extends FredoEvent['toolName'] ? true : never;
const _assertToolNameOptional: ToolNameIsOptional = true;

// ─── toolName is string type ───────────────────────────────────────────────────
// toolName is optional, so check the non-undefined part is string
type ToolNameIsString = Exclude<FredoEvent['toolName'], undefined> extends string ? true : never;
const _assertToolNameIsString: ToolNameIsString = true;

// ─── Primary discriminators (eventType, provider, transport) ─────────────────

type AssertEventType = AssertHasField<FredoEvent, 'eventType'>;
const _assertEventTypeField: AssertEventType = true;

type AssertProvider = AssertHasField<FredoEvent, 'provider'>;
const _assertProviderField: AssertProvider = true;

type AssertTransport = AssertHasField<FredoEvent, 'transport'>;
const _assertTransportField: AssertTransport = true;

// ─── All required fields ──────────────────────────────────────────────────────

type AssertFredoEventHasAllRequiredFields =
  & AssertHasField<FredoEvent, 'id'>
  & AssertHasField<FredoEvent, 'eventType'>
  & AssertHasField<FredoEvent, 'state'>
  & AssertHasField<FredoEvent, 'provider'>
  & AssertHasField<FredoEvent, 'transport'>
  & AssertHasField<FredoEvent, 'sessionId'>
  & AssertHasField<FredoEvent, 'timestamp'>
  & AssertHasField<FredoEvent, 'payload'>;

const _assertAllRequiredFields: AssertFredoEventHasAllRequiredFields = true;

// ─── Type exports compile correctly ────────────────────────────────────────────
// These types should be re-exported from index.ts

export type { FredoEvent, EventType, EventProvider, Transport };

console.log('FredoEvent toolName field tests compiled successfully');
console.log('All required fields present: id, eventType, state, provider, transport, sessionId, timestamp, payload');
console.log('toolName is optional string type');
console.log('Type-contract validation complete');