# FredoFeatureClass Template

```typescript
import React from 'react';
import { FredoFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { LuIcon } from 'react-icons/lu';

export class MyFeature extends FredoFeatureClass {
  readonly name = 'My Feature Name';
  readonly icon = LuIcon;

  readonly eventFilters: EventFilter[] = [
    { toolNames: ['tool_name'] }
  ];

  processEvent(event: StreamEvent): void {
    // Route event to component state — no side-effects
  }

  render() {
    return <MyComponent />;
  }

  onMount() {}
  onUnmount() {}
}

export const myFeature = new MyFeature();
```

## Registration

In `features/my-feature/index.ts`:

```typescript
import './MyFeature'; // side-effect import registers the feature
```

In `features/allFeatures.ts`:

```typescript
import './my-feature';
```