# Fetch Interception Solution

**Last Updated:** November 11, 2025

## Overview

Fredo browser extension intercepts chat SSE responses and extracts architecture diagram data from the `Fredo` property in the stream.

## Architecture Flow

```
Chat Page (MAIN world)
  ↓ fetch('/api/v1/agent/stream')
  ↓ Intercepted by inject.js
  ↓ Reads SSE stream
  ↓ Extracts 'Fredo' property
  ↓ window.postMessage()
  ↓
Content Script (content.js)
  ↓ window.addEventListener('message')
  ↓ Validates message type
  ↓ chrome.runtime.sendMessage()
  ↓
Background Script (background.ts)
  ↓ Forwards to sidepanel
  ↓
Side Panel (App.svelte)
  ↓ browser.runtime.onMessage
  ↓ parseJSONData() validates structure
  ↓ Creates NodeElement and LinkElement instances
  ↓ Renders ArchitectureDiagram component
```

## Current Implementation Status

### ✅ Fully Implemented
**File:** `public/inject.js` (MAIN world)
- Intercepts `/api/v1/agent/stream` endpoint
- Reads SSE stream chunks with TextDecoder
- Parses `data:` lines as JSON
- Extracts `Fredo` property if present
- Posts message via `window.postMessage()`

**File:** `public/content.js` (Isolated world)
- Listens for messages from inject.js
- Validates extension context
- Handles "Extension context invalidated" gracefully
- Forwards to background script

**File:** `entrypoints/background.ts` (Service Worker)
- Receives `Fredo_CONTENT` messages
- Forwards as `Fredo_DISPLAY` to sidepanel
- Includes metadata (conversationId, messageId)

**File:** `entrypoints/sidepanel/App.svelte`
- Listens for `Fredo_DISPLAY` messages
- Validates JSON structure (components, links arrays)
- Creates diagram elements (NodeElement[], LinkElement[])
- Renders ArchitectureDiagram with topology-based layout
- Shows animated idle state when waiting for data

### ⚠️ Partially Implemented (Marker Detection)
The inject script currently only extracts from the `Fredo` property. It needs enhancement to also detect and extract JSON between markers.

**Required Enhancement:**
```typescript
// In inject.ts, after reading SSE data
if (parsed.Fredo) {
  // Existing: Extract from property
  window.postMessage({
    type: 'Fredo_FETCH_INTERCEPTED',
    content: parsed.Fredo,
    // ...
  }, '*');
}

// NEW: Also check for markers in text content
if (parsed.text || parsed.content) {
  const textContent = parsed.text || parsed.content;
  const markerRegex = /===init-Fredo===\s*(\{[\s\S]*?\})\s*===end-Fredo===/;
  const match = textContent.match(markerRegex);
  
  if (match && match[1]) {
    console.log('[Fredo-Injected] Found marker-based JSON');
    window.postMessage({
      type: 'Fredo_FETCH_INTERCEPTED',
      content: match[1],
      // ...
    }, '*');
  }
}
```

## Expected Data Format

### JSON Structure (Required)
```json
{
  "components": [
    {
      "id": "service-1",
      "type": "Service|Deployment|StatefulSet",
      "namespace": "web|api|data",
      "label": "Display Name",
      "health": "healthy|warning|error",
      "tooltipButtons": ["Action 1", "Action 2"]
    }
  ],
  "links": [
    {
      "source": "service-1",
      "target": "service-2",
      "relation": "calls|queries|routes"
    }
  ]
}
```

### SSE Stream Format
```typescript
// In SSE stream from /api/v1/agent/stream
data: {
  "Fredo": "{\"components\": [...], \"links\": [...]}",
  "conversationId": "...",
  "messageId": "..."
}
```

**Note:** The `Fredo` property should contain the stringified JSON. The extension will parse it automatically.

## Technical Details

### Why This Pattern Works
### Why This Pattern Works

**Chrome Manifest V3 Limitations:**
1. Content scripts run in **isolated context** and cannot directly intercept `window.fetch`
2. `webRequest.onBeforeRequest` requires `webRequestBlocking` permission (removed in MV3)
3. `declarativeNetRequest` API cannot inspect response bodies

**Solution: Script Injection + window.postMessage**

From Reddit (https://www.reddit.com/r/chrome_extensions/s/C1zTb7S3oG):
> "Chrome extension (isolated context) and the hostpage (Main context) run in different context... Solution: Monkey Patching via DOM Script Injection"

1. `inject.ts` executes in MAIN world (has access to real `window.fetch`)
2. Overrides `window.fetch` to intercept specific endpoints
3. Clones response to read without breaking original stream
4. Uses `window.postMessage()` to cross context boundary
5. Background script forwards to side panel

### Key Code Structure

**inject.ts** (MAIN world)
```typescript
export default defineUnlistedScript(() => {
  const originalFetch = window.fetch;
  
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0].url;
    
    if (url?.includes('/api/v1/agent/stream')) {
      const response = await originalFetch.apply(this, args);
      const clonedResponse = response.clone();
      const reader = clonedResponse.body?.getReader();
      
      // Read SSE stream
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const parsed = JSON.parse(line.slice(6));
            
            // Extract from Fredo property
            if (parsed.Fredo) {
              window.postMessage({
                type: 'Fredo_FETCH_INTERCEPTED',
                content: parsed.Fredo,
                conversationId: parsed.conversationId,
                messageId: parsed.messageId
              }, '*');
            }
          }
        }
      }
      
      return response;
    }
    
    return originalFetch.apply(this, args);
  };
});
```

**content.js** (Isolated World)
```javascript
// Listen for messages from inject.js
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  
  if (event.data?.type === 'Fredo_FETCH_INTERCEPTED') {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.warn('Extension context invalidated, please reload extension');
      return;
    }
    
    chrome.runtime.sendMessage({
      type: 'Fredo_CONTENT',
      content: event.data.content,
      conversationId: event.data.conversationId,
      messageId: event.data.messageId
    }).catch(err => {
      console.error('Failed to send message:', err);
    });
  }
});
```
```typescript
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'Fredo_CONTENT') {
      // Forward to side panel
      chrome.runtime.sendMessage({
        type: 'Fredo_DISPLAY',
        content: message.content,
        conversationId: message.conversationId,
        messageId: message.messageId
      });
    }
  });
});
```

**App.svelte** (Side Panel)
```typescript
onMount(() => {
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'Fredo_DISPLAY') {
      parseJSONData(message.content);
    }
  });
});

function parseJSONData(content: string) {
  const data = JSON.parse(content);
  
  // Validate structure
  if (!data.components || !data.links) {
    throw new Error('Invalid structure');
  }
  
  // Create elements
  nodes = data.components.map(c => new NodeElement(c));
  links = data.links.map(l => new LinkElement(l));
  
  showDiagram = true;
}
```

## Implementation Checklist

### ✅ Complete
- [x] Inject script into MAIN world (`inject.js`)
- [x] Override `window.fetch` to intercept stream endpoint
- [x] Read SSE stream chunks with TextDecoder
- [x] Parse `data:` lines as JSON
- [x] Extract `Fredo` property from parsed data
- [x] Post message from MAIN world via window.postMessage()
- [x] Content script listener with context validation
- [x] **Handle "Extension context invalidated" error gracefully**
- [x] Background script message forwarding
- [x] Side panel message listener
- [x] JSON validation (`components` and `links` arrays)
- [x] NodeElement creation from components
- [x] LinkElement creation with source/target resolution
- [x] ArchitectureDiagram rendering
- [x] Topology-based auto-layout
- [x] Click-based tooltips with overflow detection
- [x] Zoom/pan controls (wheel + buttons + drag)
- [x] **Animated idle state when waiting for data**

### 📋 Planned
- [ ] Diagram diff view (compare architecture changes)
- [ ] Export diagram as PNG/SVG
- [ ] Save/load diagram configurations
- [ ] Integration with CI/CD pipeline data

## Testing

### Test Data Location
- **With markers**: `test-data/architecture-test.json`
- **Clean JSON**: `test-data/architecture-test-clean.json`
- **Documentation**: `test-data/README.md`

### Testing SSE Property Extraction (✅ Working)
1. Load extension in `chrome://extensions/` → Load `.output/chrome-mv3`
2. Navigate to chat page
3. Send a message that triggers agent response with `Fredo` property
4. Check browser console for logs:
   - `[Fredo-Injected] Found Fredo property`
   - `[Fredo Content] Received Fredo data`
5. Verify side panel shows animated idle state, then renders diagram

**Console Logs to Look For:**
- Inject: `Agent stream request detected!`, `Found Fredo property`
- Content: `Received Fredo data, forwarding to background...`
- Sidepanel: `Received message`, `Valid JSON structure detected`

## Troubleshooting

### Extension Context Invalidated Error
- **Cause:** Extension reloaded while page still has old content script
- **Message:** `Extension context invalidated`
- **Fix:** Hard refresh the chat page (Ctrl+Shift+R)
- **Prevention:** Content script now checks `chrome.runtime?.id` before sending messages

### Diagram Not Rendering
- **Check:** Is JSON structure valid? (`components` and `links` arrays)
- **Check:** Side panel console for `parseJSONData` errors
- **Check:** Do all link source/target IDs match component IDs?
- **Fix:** Use test-data/architecture-test-clean.json as reference

### Tooltips Not Working
- **Check:** Are `tooltipButtons` defined in components?
- **Check:** Click cards (tooltips are click-based, not hover)
- **Fix:** Each component needs `tooltipButtons: [{label, action}]`

### Zoom/Pan Not Working
- **Check:** Is diagram rendered? (`showDiagram === true`)
- **Try:** Mouse wheel over diagram
- **Try:** Click and drag to pan
- **Fix:** Reload extension and refresh page

### Idle Animation Not Showing
- **Check:** Is `TEST_MODE = false` in App.svelte?
- **Check:** No Fredo data received yet?
- **Expected:** Pulsing circles with 3-step instructions

## File Structure

```
apps/browser-extension/
├── entrypoints/
│   ├── inject.ts              # MAIN world: Fetch interception (builds to public/)
│   ├── background.ts          # Service worker: Message routing
│   └── sidepanel/
│       ├── App.svelte         # Message listener, parseJSONData(), idle state
│       ├── components/
│       │   ├── ArchitectureDiagram.svelte  # Main diagram with zoom/pan
│       │   └── ArchitectureNode.svelte     # Individual cards with tooltips
│       └── lib/
│           └── elements/
│               ├── NodeElement.ts          # Component data model
│               └── LinkElement.ts          # Connection data model
├── public/
│   ├── content.js             # Isolated world: Message forwarding (plain JS)
│   └── inject.js              # Built from entrypoints/inject.ts
└── docs/
    └── browser-extension/
        └── FETCH_INTERCEPTION_SOLUTION.md  # This file
```

## References & Research

### Technical Resources
- **Chrome MV3 Content Scripts**: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- **window.postMessage API**: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- **Chrome webRequest (deprecated)**: https://developer.chrome.com/docs/extensions/reference/api/webRequest

### Community Solutions
- **Reddit - Proven Pattern**: https://www.reddit.com/r/chrome_extensions/s/C1zTb7S3oG
  - Key insight: Script injection to MAIN world for fetch interception
- **AnimePlanet Extension**: https://github.com/Sandelier/AnimePlanet-Additions/blob/main/firefox/contentScripts/helper/interceptFetch.js
  - Working implementation example

### Related Documentation
- `docs/ARCHITECTURE.md` - Overall extension architecture
- `docs/DATA_MODEL.md` - NodeElement and LinkElement structure
- `test-data/README.md` - Test data format and usage

---

**Maintained by:** Fredo Team  
**Last Updated:** November 11, 2025  
**Status:** ✅ Fully Functional - SSE Property Extraction with Idle State Animation
