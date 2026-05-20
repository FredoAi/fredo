# Feature Class Implementation Guide

## Table of Contents
- [Overview](#overview)
- [When to Use AtlasFeatureClass](#when-to-use-Atlasfeatureclass)
- [Creating a New Feature](#creating-a-new-feature)
- [Pattern Examples](#pattern-examples)
- [Event Filtering](#event-filtering)
- [Lifecycle Hooks](#lifecycle-hooks)
- [Grid Configuration](#grid-configuration)
- [Testing](#testing)

## Overview

`AtlasFeatureClass` is an abstract base class that standardizes how grid-based features work in the Atlas browser extension. It enforces a consistent pattern for:
- Event processing from stream sources
- Rendering React components
- Lifecycle management (mount/unmount)
- Grid behavior configuration

## When to Use AtlasFeatureClass

### ✅ MUST USE for:
- **Grid-rendered features**: Features that appear in the Home.tsx grid layout
- **Event-driven features**: Features that process SSE stream events
- **User-manageable features**: Features users can close, maximize, or minimize
- **Lifecycle-dependent features**: Features needing initialization/cleanup

### ❌ DO NOT USE for:
- **Fixed-position UI**: Components with absolute positioning (e.g., SideStepper, StreamStatus)
- **Modal/overlay components**: Dialogs, popovers, settings panels
- **Fallback states**: Empty states like Dashboard
- **Simple utility components**: Buttons, cards, form inputs

## Creating a New Feature

### Step 1: Create Feature Class File

Create `MyFeature.tsx` in your feature folder:

```typescript
import React from 'react';
import { AtlasFeatureClass, type EventFilter } from '../../shared/classes';
import type { StreamEvent } from '../../shared/contexts/StreamContext';
import { LuIcon } from 'react-icons/lu';  // Choose appropriate icon

export class MyFeature extends AtlasFeatureClass {
  // 1. Display name (shown when minimized)
  readonly name = 'My Feature';
  
  // 2. Icon (shown when minimized)
  readonly icon = LuIcon;
  
  // 3. Event filters - which events to process
  readonly eventFilters: EventFilter[] = [
    { toolNames: ['my_tool_name'] }
  ];
  
  // 4. Event processing logic
  processEvent(event: StreamEvent): void {
    console.log('[MyFeature] Processing event:', event);
    // Handle event - update state, trigger actions, etc.
  }
  
  // 5. Render the React component
  render() {
    return <MyComponent />;
  }
  
  // Optional: Called when feature added to grid
  onMount() {
    console.log('[MyFeature] Mounted');
    // Initialize API connections, subscriptions, etc.
  }
  
  // Optional: Called when feature removed from grid
  onUnmount() {
    console.log('[MyFeature] Unmounted');
    // Cleanup: close connections, clear timers, etc.
  }
}
```

### Step 2: Create React Component

Create `MyComponent.tsx`:

```typescript
import React from 'react';
import { Box, Text } from '@chakra-ui/react';

export const MyComponent: React.FC = () => {
  return (
    <Box p={4}>
      <Text>My Feature Content</Text>
    </Box>
  );
};
```

### Step 3: Export from index.ts

```typescript
export { MyFeature } from './MyFeature';
export { myFeature } from './MyFeature';  // If singleton
export { MyComponent } from './components/MyComponent';
```

### Step 4: Add to Grid

In `Home.tsx` or event handler:

```typescript
import { myFeature } from '../../features/my-feature';

// Add to grid
addToGrid('my-feature', myFeature);
```

## Pattern Examples

### Singleton Pattern

**Use when**: Feature has only one instance (e.g., DiagramFeature)

```typescript
export class DiagramFeature extends AtlasFeatureClass {
  readonly name = 'Infrastructure Diagram';
  readonly icon = LuNetwork;
  
  readonly eventFilters: EventFilter[] = [
    { toolNames: ['infrastructure_stream', 'k8s_diagram'] }
  ];
  
  processEvent(event: StreamEvent): void {
    // Diagram-specific event processing
  }
  
  render() {
    return <ArchitectureDiagram />;
  }
}

// Export singleton instance
export const diagramFeature = new DiagramFeature();

// Usage
addToGrid('diagram', diagramFeature);
```

### Factory Pattern

**Use when**: Multiple instances needed (e.g., QueryViewerFeature)

```typescript
export interface QueryResult {
  id: string;
  toolName: string;
  query: string;
  results: any[];
}

export class QueryViewerFeature extends AtlasFeatureClass {
  readonly name: string;
  readonly icon: IconType;
  readonly eventFilters: EventFilter[] = []; // No event processing
  
  private queryResult: QueryResult;
  
  constructor(queryResult: QueryResult) {
    super();
    this.queryResult = queryResult;
    this.name = queryResult.toolName;
    this.icon = this.getIconForToolName(queryResult.toolName);
  }
  
  processEvent(event: StreamEvent): void {
    // Not used - data comes from constructor
  }
  
  render() {
    return (
      <QueryViewer
        query={this.queryResult.query}
        results={this.queryResult.results}
      />
    );
  }
  
  private getIconForToolName(toolName: string): IconType {
    if (toolName.includes('LOGS')) return LuDatabase;
    if (toolName.includes('METRICS')) return LuActivity;
    return LuDatabase;
  }
}

// Export factory function
export function createQueryViewerFeature(result: QueryResult): QueryViewerFeature {
  return new QueryViewerFeature(result);
}

// Usage
const queryFeature = createQueryViewerFeature(queryResult);
addToGrid(`query-${queryResult.id}`, queryFeature);
```

## Event Filtering

### By Tool Names

Filter events by specific tool names:

```typescript
readonly eventFilters: EventFilter[] = [
  { toolNames: ['infrastructure_stream', 'k8s_diagram'] }
];
```

### By Event States

Filter by event lifecycle states:

```typescript
readonly eventFilters: EventFilter[] = [
  { states: ['init', 'response', 'error'] }
];
```

### Custom Filter Function

Use custom logic for complex filtering:

```typescript
readonly eventFilters: EventFilter[] = [
  {
    custom: (event) => {
      return event.toolName.includes('query') && 
             event.state === 'response' &&
             event.response?.rows?.length > 0;
    }
  }
];
```

### Multiple Filters (OR logic)

Any filter match will trigger event processing:

```typescript
readonly eventFilters: EventFilter[] = [
  { toolNames: ['logs_query'] },
  { toolNames: ['metrics_query'] },
  { custom: (event) => event.toolName.includes('trace') }
];
```

### No Event Processing

If feature doesn't need event processing:

```typescript
readonly eventFilters: EventFilter[] = [];
```

## Lifecycle Hooks

### onMount()

Called when feature is added to grid. Use for:
- Initializing API connections
- Starting timers or intervals
- Setting up subscriptions
- Loading initial data

```typescript
async onMount() {
  console.log('[MyFeature] Mounted');
  
  // Start SSE connection
  this.eventSource = new EventSource('/api/stream');
  
  // Set up timer
  this.timerId = setInterval(() => {
    this.refresh();
  }, 5000);
  
  // Load initial data
  await this.loadData();
}
```

### onUnmount()

Called when feature is removed from grid. Use for:
- Closing connections
- Clearing timers/intervals
- Unsubscribing from events
- Cleanup operations

```typescript
async onUnmount() {
  console.log('[MyFeature] Unmounted');
  
  // Close SSE connection
  this.eventSource?.close();
  
  // Clear timer
  if (this.timerId) {
    clearInterval(this.timerId);
  }
  
  // Cleanup subscriptions
  this.unsubscribe();
}
```

### Lifecycle Flow

```
1. User action → addToGrid('feature-id', feature)
2. Feature added to gridItems state
3. feature.onMount() called
4. feature.render() called on each React render
5. User clicks close → removeFromGrid('feature-id')
6. feature.onUnmount() called
7. Feature removed from gridItems state
```

## Grid Configuration

### Default Configuration

```typescript
readonly gridConfig: GridItemConfig = {
  closable: true,      // User can close this feature
  maximizable: true    // User can maximize this feature
};
```

### Custom Configuration

Override for specific behavior:

```typescript
readonly gridConfig: GridItemConfig = {
  closable: false,     // Cannot be closed
  maximizable: false   // Cannot be maximized
};
```

### Configuration Use Cases

**Non-closable feature** (e.g., critical monitoring):
```typescript
readonly gridConfig = { closable: false, maximizable: true };
```

**View-only feature** (e.g., read-only dashboard):
```typescript
readonly gridConfig = { closable: true, maximizable: false };
```

**Locked feature** (e.g., always-visible status):
```typescript
readonly gridConfig = { closable: false, maximizable: false };
```

## Testing

### Unit Testing Feature Class

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MyFeature } from './MyFeature';

describe('MyFeature', () => {
  it('should have correct name and icon', () => {
    const feature = new MyFeature();
    expect(feature.name).toBe('My Feature');
    expect(feature.icon).toBeDefined();
  });
  
  it('should process events correctly', () => {
    const feature = new MyFeature();
    const mockEvent = {
      toolName: 'my_tool',
      state: 'response',
      data: {}
    };
    
    feature.processEvent(mockEvent);
    // Assert expected behavior
  });
  
  it('should call lifecycle hooks', async () => {
    const feature = new MyFeature();
    const mountSpy = vi.spyOn(feature, 'onMount');
    const unmountSpy = vi.spyOn(feature, 'onUnmount');
    
    await feature.onMount?.();
    expect(mountSpy).toHaveBeenCalled();
    
    await feature.onUnmount?.();
    expect(unmountSpy).toHaveBeenCalled();
  });
  
  it('should render component', () => {
    const feature = new MyFeature();
    const element = feature.render();
    expect(element).toBeDefined();
    expect(element.type).toBe(MyComponent);
  });
});
```

### Integration Testing with Grid

```typescript
import { render, screen } from '@testing-library/react';
import { Home } from './Home';
import { myFeature } from '../my-feature';

describe('MyFeature integration', () => {
  it('should add feature to grid', () => {
    const { container } = render(<Home />);
    
    // Simulate adding feature
    const addButton = screen.getByText('Add Feature');
    fireEvent.click(addButton);
    
    // Assert feature is in grid
    expect(screen.getByText('My Feature')).toBeInTheDocument();
  });
  
  it('should remove feature from grid', () => {
    const { container } = render(<Home />);
    
    // Add feature
    addToGrid('my-feature', myFeature);
    
    // Remove feature
    const closeButton = screen.getByLabelText('Close');
    fireEvent.click(closeButton);
    
    // Assert feature is removed
    expect(screen.queryByText('My Feature')).not.toBeInTheDocument();
  });
});
```

## Best Practices

1. **Keep processEvent() lightweight**: Offload heavy processing to components
2. **Use onMount() for initialization**: Don't put setup logic in constructor
3. **Always cleanup in onUnmount()**: Prevent memory leaks
4. **Name features clearly**: Use descriptive names for the grid UI
5. **Choose appropriate icons**: Use icons from `react-icons/lu` for consistency
6. **Handle errors gracefully**: Wrap event processing in try-catch
7. **Log lifecycle events**: Helps debugging in development
8. **Document event filters**: Comment why specific filters are used

## Common Patterns

### Feature with API Calls

```typescript
export class DataFeature extends AtlasFeatureClass {
  private data: any[] = [];
  private abortController?: AbortController;
  
  async onMount() {
    this.abortController = new AbortController();
    await this.fetchData();
  }
  
  async onUnmount() {
    this.abortController?.abort();
  }
  
  private async fetchData() {
    const response = await fetch('/api/data', {
      signal: this.abortController?.signal
    });
    this.data = await response.json();
  }
  
  render() {
    return <DataTable data={this.data} />;
  }
}
```

### Feature with WebSocket

```typescript
export class RealtimeFeature extends AtlasFeatureClass {
  private ws?: WebSocket;
  
  onMount() {
    this.ws = new WebSocket('wss://api.example.com');
    this.ws.onmessage = (event) => {
      this.processEvent(JSON.parse(event.data));
    };
  }
  
  onUnmount() {
    this.ws?.close();
  }
  
  processEvent(event: StreamEvent): void {
    // Handle realtime updates
  }
  
  render() {
    return <RealtimeDisplay />;
  }
}
```

## Troubleshooting

### Feature not appearing in grid
- Check that `addToGrid()` is called correctly
- Verify feature ID is unique
- Check `render()` returns valid React element

### Events not being processed
- Verify `eventFilters` match incoming events
- Check event structure matches `StreamEvent` type
- Add console.log in `processEvent()` to debug

### Lifecycle hooks not called
- Ensure `onMount()` and `onUnmount()` are defined
- Check grid management calls these methods
- Verify feature instance is correct

### Memory leaks
- Always cleanup in `onUnmount()`
- Clear intervals, timers, subscriptions
- Close connections (WebSocket, EventSource)
- Abort pending fetch requests
