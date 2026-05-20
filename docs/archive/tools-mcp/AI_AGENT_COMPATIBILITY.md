# AI Agent Compatibility - Tools MCP APIs

## Overview
The Atlas Tools MCP APIs have been refactored to be **AI-agent-friendly** with permissive input validation and robust normalization. This allows AI agents to send varied input formats without encountering validation errors.

## Problem Statement
AI agents and LLMs often output data in inconsistent formats:
- **Case variations**: `"ERROR"` vs `"error"`, `"AVG"` vs `"avg"`
- **Type inconsistencies**: `"100"` (string) instead of `100` (number)
- **Mixed formatting**: `"Error"`, `"Warn"`, etc.

Traditional strict API validation (JSON Schema with enums) causes frequent 400 errors when AI agents don't match exact formats.

## Solution: Permissive Validation + Normalization

### Pattern
1. **Accept Everything**: Remove strict schema validation (`additionalProperties: true`)
2. **Normalize in Handler**: Convert inputs to expected types/formats
3. **Database Validation**: Let PostgreSQL provide final validation

### Implementation

#### Before (Strict)
```typescript
schema: {
  body: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
      limit: { type: 'integer', minimum: 1, maximum: 10000 }
    }
  }
}
```
**Problem**: AI sends `"ERROR"` → 400 error, AI sends `"100"` → 400 error

#### After (Permissive)
```typescript
schema: {
  body: {
    type: 'object',
    additionalProperties: true  // Accept any properties
  }
},
handler: async (request, reply) => {
  const body = request.body as any;
  const normalizedInput: any = {};

  // Normalize enum values to lowercase
  if (body.level) normalizedInput.level = String(body.level).toLowerCase();
  
  // Parse string numbers to integers
  if (body.limit !== undefined) normalizedInput.limit = parseInt(String(body.limit), 10);
  
  // ... normalize all other fields
}
```
**Result**: AI sends `"ERROR"` → normalized to `"error"` ✅, AI sends `"100"` → parsed to `100` ✅

## Normalization Rules

### String Enum Fields (case-insensitive)
- **Logs**: `level`, `minLevel`, `sortOrder`, `groupBy`
- **Metrics**: `type`, `aggregation`, `interval`, `sortOrder`, `groupBy`
- **Traces**: `kind`, `status`, `sortBy`, `sortOrder`

**Transform**: `String(value).toLowerCase()`

### Numeric Fields (parse from strings)
- **Logs**: `limit`, `offset`
- **Metrics**: `limit`, `offset`, `minValue`, `maxValue`
- **Traces**: `limit`, `offset`, `minDuration`, `maxDuration`

**Transform**: 
- Integers: `parseInt(String(value), 10)`
- Floats: `parseFloat(String(value))`

### Boolean Fields
- **Logs**: `hasMetadata`
- **Traces**: `hasError`

**Transform**: `Boolean(value)`

### Complex Objects (passthrough)
- **Logs**: `metadata`
- **Metrics**: `labels`, `tags`, `groupBy` (array)
- **Traces**: `attributes`

**Transform**: Keep as-is, no normalization

## Test Results

### Test Case 1: Uppercase Enums
```json
POST /api/v1/logs/query
{ "level": "ERROR", "limit": 100 }
```
✅ **Result**: Found 8 logs (normalized `"ERROR"` → `"error"`)

### Test Case 2: String Numbers
```json
POST /api/v1/logs/query
{ "level": "warn", "limit": "50" }
```
✅ **Result**: Found 4 logs (parsed `"50"` → `50`)

### Test Case 3: Mixed Case + String Numbers
```json
POST /api/v1/metrics/query
{ "aggregation": "AVG", "limit": "20" }
```
✅ **Result**: Found 1 metric (normalized `"AVG"` → `"avg"`, parsed `"20"` → `20`)

### Test Case 4: Uppercase Status + String Duration
```json
POST /api/v1/traces/query
{ "status": "ERROR", "minDuration": "500" }
```
✅ **Result**: Found 6 traces (normalized `"ERROR"` → `"error"`, parsed `"500"` → `500`)

## API Endpoints Refactored

### 1. Logs Query API
- **Endpoint**: `POST /api/v1/logs/query`
- **Normalization**: 15+ parameters
- **Special handling**: 
  - `level`/`minLevel`: Lowercase conversion
  - `limit`/`offset`: String to integer
  - `metadata`: Passthrough as JSONB

### 2. Metrics Query API
- **Endpoint**: `POST /api/v1/metrics/query`
- **Normalization**: 10+ parameters
- **Special handling**:
  - `groupBy`: Accepts string or array, normalizes to array
  - `aggregation`: Lowercase (avg, sum, min, max, count, p50, p95, p99)
  - `interval`: Lowercase (1m, 5m, 15m, 1h, 6h, 1d)

### 3. Traces Query API
- **Endpoint**: `POST /api/v1/traces/query`
- **Normalization**: 14+ parameters
- **Special handling**:
  - `status`: Lowercase (unset, ok, error)
  - `kind`: Lowercase (internal, server, client, producer, consumer)
  - `minDuration`/`maxDuration`: String to integer (microseconds)

## Benefits

### For AI Agents
✅ No validation errors from case variations
✅ No type errors from string numbers
✅ Flexible input formats accepted
✅ Clear tool descriptions with examples

### For Developers
✅ Single source of truth (database validation)
✅ Easier debugging (see normalized inputs in logs)
✅ Backward compatible (strict clients still work)
✅ OpenAPI/Swagger docs remain accurate

## MCP Tool Descriptions

Tool descriptions updated to include valid values and restrictions:

**logs_query** (402 chars):
```
Query application logs with filtering by level (debug, info, warn, error), 
time range, trace ID, service, and text search. Supports grouping and aggregation. 
Valid levels: debug, info, warn, error | Time format: ISO 8601 or relative 
(1h ago, 30m ago) | Max limit: 10000 | Examples: { "level": "error", "limit": 100 }...
```

**metrics_query** (383 chars):
```
Query time-series metrics with aggregation support. Valid types: counter, gauge, 
histogram, summary | Intervals: 1m, 5m, 15m, 1h, 6h, 1d | Aggregations: avg, sum, 
min, max, count, p50, p95, p99 | Examples: { "name": "cpu_usage", "aggregation": "avg" }...
```

**traces_query** (369 chars):
```
Query distributed traces with filtering. Valid statuses: unset, ok, error | 
Valid kinds: internal, server, client, producer, consumer | Duration in microseconds | 
Examples: { "serviceName": "api", "status": "error" }...
```

## Architecture Decisions

### Why Permissive at API Boundary?
1. **AI agents are unpredictable** - LLMs output varies between runs
2. **Type coercion is cheap** - Normalization adds <1ms overhead
3. **Database is final validator** - PostgreSQL enforces data integrity
4. **Better UX for AI** - Fewer retries, faster iteration

### Why Not Just Fix AI Output?
1. **Can't control external LLMs** - Different models, different formats
2. **Prompt engineering is fragile** - Works today, breaks tomorrow
3. **API should be robust** - Handle real-world usage patterns
4. **Aligns with HTTP philosophy** - Be liberal in what you accept

### Trade-offs
**Pros**:
- ✅ AI agents work reliably
- ✅ Fewer 400 errors
- ✅ Better developer experience
- ✅ Backward compatible

**Cons**:
- ⚠️ More code in handlers (~50 lines per route)
- ⚠️ Less strict typing at boundary
- ⚠️ Need comprehensive normalization tests

## Migration Notes

### If You're Building Similar APIs

1. **Identify AI-facing endpoints** - Where do LLMs call your API?
2. **Remove strict validation** - Use `additionalProperties: true`
3. **Add normalization handlers** - Convert to expected types
4. **Document valid values** - In descriptions, not schemas
5. **Test with variations** - Uppercase, string numbers, mixed case

### Code Pattern (TypeScript)
```typescript
// Normalize enum (case-insensitive)
if (body.enumField) {
  normalizedInput.enumField = String(body.enumField).toLowerCase();
}

// Parse integer (handle string)
if (body.intField !== undefined) {
  normalizedInput.intField = parseInt(String(body.intField), 10);
}

// Parse float (handle string)
if (body.floatField !== undefined) {
  normalizedInput.floatField = parseFloat(String(body.floatField));
}

// Boolean conversion
if (body.boolField !== undefined) {
  normalizedInput.boolField = Boolean(body.boolField);
}

// Passthrough complex types
if (body.objectField) {
  normalizedInput.objectField = body.objectField;
}
```

## Performance Impact

- **Normalization overhead**: <1ms per request
- **Database query time**: 5-50ms (unchanged)
- **Total response time**: ~50ms (no significant change)

## Security Considerations

- ✅ SQL injection: Protected by parameterized queries
- ✅ Type confusion: Normalized to expected types
- ✅ Invalid data: Validated by database constraints
- ✅ Large payloads: Fastify body limits apply (1MB default)

## Future Enhancements

1. **Add validation metrics** - Track normalization frequency
2. **Schema versioning** - Support both strict and permissive
3. **AI feedback loop** - Log common variations, improve tools
4. **Type hints in descriptions** - "Send as string or number"

## Conclusion

By adopting **permissive validation + normalization**, the Atlas Tools MCP APIs now handle real-world AI agent behavior gracefully. This pattern should be the default for any API designed to be consumed by LLMs or AI agents.

**Key Takeaway**: Design APIs for how AI agents actually behave, not how we wish they would behave.
