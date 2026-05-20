# Atlas Message Passing Implementation

## Overview
Clean implementation of message passing between inject script, content script, background script, and sidepanel following Chrome Extension messaging best practices.

## Architecture

```
Agent UI (SSE Stream)
    ↓ (intercept fetch)
inject.ts (main world)
    ↓ (window.postMessage)
content.js (isolated world)
    ↓ (chrome.runtime.sendMessage)
background.ts (service worker)
    ↓ (chrome.runtime.sendMessage)
sidepanel App.svelte
    ↓ (render)
StepByStepView.svelte
```

## Implementation Details

### 1. inject.ts - Tool Call Detection
**Location**: `entrypoints/inject.ts`

**Purpose**: Intercept SSE stream from Agent UI and extract tool call JSON

**Key Features**:
- Runs in MAIN world (can access window.fetch)
- Intercepts `/api/v1/agent` and `/stream` endpoints
- Detects SSE streams (text/event-stream)
- Extracts JSON between `===init-Atlas===` and `===end-Atlas===` markers
- Posts Atlas_TOOL_CALL messages to window
- Passes stream through unchanged (transparent)

**Message Format**:
```typescript
window.postMessage({
  type: 'Atlas_TOOL_CALL',
  data: {
    components: [...], // Tool call data
    // ... other fields
  },
  timestamp: Date.now()
}, '*');
```

### 2. content.js - Message Relay
**Location**: `public/content.js`

**Purpose**: Bridge between main world and extension

**Key Features**:
- Listens for window messages from inject.ts
- Validates origin (same-origin only)
- Forwards to extension via chrome.runtime.sendMessage
- No DOM manipulation
- No UI changes

**Message Format**:
```javascript
chrome.runtime.sendMessage({
  type: 'Atlas_TOOL_CALL',
  data: event.data.data,
  timestamp: event.data.timestamp
});
```

### 3. background.ts - Message Router
**Location**: `entrypoints/background.ts`

**Purpose**: Route messages from content script to sidepanel

**Key Features**:
- Listens for Atlas_TOOL_CALL from content script
- Forwards as Atlas_DISPLAY to sidepanel
- Handles async message responses
- Simple pass-through logic

**Message Format**:
```typescript
chrome.runtime.sendMessage({
  type: 'Atlas_DISPLAY',
  data: message.data,
  timestamp: message.timestamp
});
```

### 4. sidepanel App.svelte - Data Consumer
**Location**: `entrypoints/sidepanel/App.svelte`

**Purpose**: Listen for tool calls and update UI

**Key Features**:
- Listens for Atlas_DISPLAY messages
- Parses tool call components into steps
- Updates $state reactive variables
- Switches to 'steps' page
- Renders StepByStepView component

**Implementation**:
```typescript
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'Atlas_DISPLAY') {
    const newSteps: Step[] = message.data.components.map((comp: any) => ({
      name: comp.name || 'Unknown Step',
      description: comp.description || '',
      status: 'Waiting' as const,
      needsPermit: false
    }));
    
    steps = newSteps;
    currentPage = 'steps';
  }
});
```

### 5. StepByStepView.svelte - UI Component
**Location**: `entrypoints/sidepanel/components/StepByStepView.svelte`

**Purpose**: Display steps in animated UI

**Key Features**:
- Uses Svelte 5 runes ($state, $derived, $effect, $props)
- Sorts steps by status (Completed → Running → Error → Waiting)
- Animates with Anime.js (entry stagger, status changes)
- TypeScript interface for Step type
- Action buttons for permit/cancel/debug

**Step Interface**:
```typescript
interface Step {
  name: string;
  description: string;
  status: 'Completed' | 'Running' | 'Waiting' | 'Error';
  needsPermit: boolean;
}
```

## Message Flow Example

1. **Agent sends SSE stream**:
   ```
   data: {"type":"text_token","content":"===init-Atlas==={\"components\":[...]}===end-Atlas==="}
   ```

2. **inject.ts extracts and posts**:
   ```javascript
   window.postMessage({
     type: 'Atlas_TOOL_CALL',
     data: { components: [...] },
     timestamp: 1234567890
   }, '*');
   ```

3. **content.js relays**:
   ```javascript
   chrome.runtime.sendMessage({
     type: 'Atlas_TOOL_CALL',
     data: { components: [...] },
     timestamp: 1234567890
   });
   ```

4. **background.ts forwards**:
   ```javascript
   chrome.runtime.sendMessage({
     type: 'Atlas_DISPLAY',
     data: { components: [...] },
     timestamp: 1234567890
   });
   ```

5. **sidepanel updates state**:
   ```typescript
   steps = [
     { name: 'Step 1', description: '...', status: 'Waiting', needsPermit: false },
     { name: 'Step 2', description: '...', status: 'Waiting', needsPermit: false }
   ];
   currentPage = 'steps';
   ```

6. **StepByStepView renders with animation**

## Testing

1. **Build extension**:
   ```powershell
   npm run build
   ```

2. **Load in Chrome**:
   - Go to `chrome://extensions/`
   - Enable Developer mode
   - Load unpacked: `.output/chrome-mv3/`

3. **Test flow**:
   - Open Agent UI (https://agent.digitalcoedevops.com/chat)
   - Open sidepanel
   - Ask Agent to execute a tool that returns Atlas markers
   - Verify:
     - Console logs in inject.ts show tool call detected
     - Console logs in content.js show message relayed
     - Console logs in background.ts show message forwarded
     - Console logs in sidepanel show steps updated
     - StepByStepView appears with animated steps

## Key Changes from Previous Implementation

### Removed:
- ❌ DOM manipulation in content.js
- ❌ Marker cleaning/replacement in UI
- ❌ Loading spinners in chat
- ❌ Success/failure status updates in chat
- ❌ MutationObserver watching prose elements
- ❌ Message injection to chat textarea
- ❌ Complex state tracking (receivedData Set, data keys)
- ❌ Conversation ID and message ID tracking

### Added:
- ✅ Clean message passing architecture
- ✅ Transparent stream interception
- ✅ Simple relay-only content script
- ✅ Focused tool call detection
- ✅ Svelte 5 runes in StepByStepView
- ✅ Type-safe interfaces

## Benefits

1. **Simplicity**: Each file has one clear responsibility
2. **Maintainability**: No complex DOM manipulation logic
3. **Reliability**: Uses official Chrome APIs
4. **Performance**: No DOM watching, minimal processing
5. **Transparency**: Stream passes through unchanged
6. **Type Safety**: TypeScript interfaces throughout
7. **Modern**: Svelte 5 runes, latest patterns

## Future Enhancements

- [ ] Add step status updates (Waiting → Running → Completed)
- [ ] Implement permit approval flow
- [ ] Add error handling and retry logic
- [ ] Store step history in chrome.storage
- [ ] Add notification when tools are called
- [ ] Support multiple concurrent tool calls
