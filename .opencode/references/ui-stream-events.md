# Consuming Stream Events

## UseStream Hook

```typescript
import { useStream } from '../../../shared/contexts/StreamContext';

const { events } = useStream();
const mine = events.filter(e => e.toolName === 'my_tool' && e.correlationId === currentId);
```

## Key Rules

- Always filter by both `toolName` and `correlationId`
- Use `processEvent()` in your feature class for routing, not for side-effects
- Side-effects belong in hooks or `onMount()`, not in `processEvent()`