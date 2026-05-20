# AI Interaction Feature

## Overview
The Atlas Browser Extension can now automatically send messages to the AI agent on the target webpage, allowing users to request visualizations with a single click.

## Implementation

### Message Injection Function
**File**: `entrypoints/sidepanel/App.svelte`

```typescript
async function sendMessageToAI(message: string) {
  // Get the active tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  
  // Execute script in the page context
  await browser.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: (msg: string) => {
      // Find textarea by placeholder
      const textarea = document.querySelector('textarea[placeholder*="Message"]');
      
      // Set value and trigger events
      textarea.value = msg;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Find and click submit button
      const submitButton = textarea.closest('form')?.querySelector('button[type="submit"]');
      submitButton?.click();
    },
    args: [message]
  });
}
```

### How It Works

1. **User clicks suggestion button** in the idle state
2. **Extension queries active tab** using `browser.tabs.query()`
3. **Script injection** via `browser.scripting.executeScript()`
4. **DOM manipulation** in page context:
   - Finds textarea: `document.querySelector('textarea[placeholder*="Message"]')`
   - Sets value: `textarea.value = msg`
   - Triggers React/Vue change detection: `dispatchEvent('input')` and `dispatchEvent('change')`
   - Finds submit button: `textarea.closest('form')?.querySelector('button[type="submit"]')`
   - Clicks submit: `submitButton.click()`

### UI Components

#### Suggestion Buttons
Three pre-configured prompts in the idle state:
- 🏗️ "Ask for infrastructure diagram"
- 🔍 "Generate cluster diagram"  
- 🎯 "Visualize microservices"

Each button sends a specific message:
```typescript
<button onclick={() => sendMessageToAI('Show me the Kubernetes infrastructure diagram')}>
  🏗️ Ask for infrastructure diagram
</button>
```

#### Visual Design
- **Background**: Semi-transparent white with backdrop blur
- **Hover effect**: Brightens background, lifts button (-2px translateY)
- **Active effect**: Pushes button back down
- **Icon prefixes**: Emoji icons for visual appeal
- **Full-width layout**: Buttons span container width

## Permissions Required

### manifest.json
```json
{
  "permissions": [
    "scripting",  // Required for executeScript
    "activeTab",  // Required for accessing current tab
    "tabs",       // Required for tab queries
    "storage",    // For extension state
    "sidePanel"   // For side panel UI
  ],
  "host_permissions": [
    "*://agent.digitalcoedevops.com/*",
    "*://agent.agent.digitalcoedevops.com/*"
  ]
}
```

## Target Page Requirements

The AI chat page must have:
1. **Textarea** with `placeholder` attribute containing "Message"
2. **Form** wrapper around the textarea
3. **Submit button** with `type="submit"` inside the form

### Example HTML Structure
```html
<form>
  <textarea placeholder="Message with SuperEng context..." rows="1"></textarea>
  <button type="submit">
    <svg><!-- send icon --></svg>
  </button>
</form>
```

## Event Handling

### React/Vue Compatibility
The function dispatches both `input` and `change` events with `bubbles: true` to ensure framework reactivity:

```javascript
textarea.dispatchEvent(new Event('input', { bubbles: true }));
textarea.dispatchEvent(new Event('change', { bubbles: true }));
```

This ensures:
- React's `onChange` handler fires
- Vue's `v-model` updates
- Angular's `ngModel` syncs
- Vanilla JS event listeners trigger

### Timing
A 100ms delay between setting the value and clicking submit ensures:
- DOM updates propagate
- Framework reactivity completes
- Submit button becomes enabled (if conditional)

```javascript
setTimeout(() => {
  submitButton.click();
}, 100);
```

## Error Handling

### Graceful Degradation
If injection fails:
- Console logs error message
- User can still type manually in the chat
- Extension continues functioning normally

### Validation Checks
```javascript
// Check tab exists
if (!tabs[0]?.id) {
  console.error('[Atlas] No active tab found');
  return;
}

// Check textarea exists in page
if (!textarea) {
  console.error('[Atlas] Textarea not found');
  return;
}

// Check submit button exists
if (!submitButton) {
  console.error('[Atlas] Submit button not found');
  return;
}
```

## User Flow

```
User sees idle state
       ↓
Clicks suggestion button (e.g., "Ask for infrastructure diagram")
       ↓
Extension executes sendMessageToAI()
       ↓
Script injected into page context
       ↓
Textarea value set to prompt
       ↓
Input/change events dispatched
       ↓
Submit button clicked programmatically
       ↓
AI receives message and processes
       ↓
Response contains JSON diagram data
       ↓
Content script intercepts response
       ↓
Message sent to sidepanel
       ↓
Diagram renders automatically
```

## Testing Checklist

- [x] Suggestion buttons render in idle state
- [x] Button hover effects work
- [x] Clicking button sends message to textarea
- [x] Textarea value appears in AI chat
- [x] Submit button clicks automatically
- [x] AI receives and processes message
- [x] Response triggers diagram rendering
- [x] Error logging works when elements not found
- [x] Permissions declared in manifest
- [x] Works on target domains only

## Future Enhancements

### Custom Prompts
Allow users to add their own suggestion prompts:
```typescript
let customPrompts = $state<string[]>([]);

// Load from storage
onMount(async () => {
  const result = await browser.storage.sync.get('customPrompts');
  customPrompts = result.customPrompts || [];
});

// Render custom prompts
{#each customPrompts as prompt}
  <button onclick={() => sendMessageToAI(prompt)}>
    {prompt}
  </button>
{/each}
```

### Prompt Templates
Pre-configured templates with variables:
```typescript
const templates = {
  k8s_cluster: 'Show me the {namespace} Kubernetes infrastructure',
  services: 'Generate a diagram of {service_name} dependencies',
  resources: 'Visualize {resource_type} resources in {namespace}'
};

// Fill template with user input
function fillTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/{(\w+)}/g, (_, key) => vars[key] || '');
}
```

### Recent Prompts
Track and suggest recently used prompts:
```typescript
let recentPrompts = $state<string[]>([]);

// Save to storage after sending
async function sendMessageToAI(message: string) {
  // ... send logic ...
  
  // Track recent
  recentPrompts = [message, ...recentPrompts.slice(0, 4)];
  await browser.storage.local.set({ recentPrompts });
}
```

### Smart Suggestions
Context-aware suggestions based on current page:
```typescript
// Detect current context
if (currentUrl.includes('deployment')) {
  suggestions.push('Show deployment status');
} else if (currentUrl.includes('services')) {
  suggestions.push('Visualize service mesh');
}
```

## Security Considerations

### Content Security Policy
- Scripts execute in isolated context
- No eval() or inline scripts
- DOM manipulation is safe (querySelector, value setting)

### User Consent
- User explicitly clicks suggestion button
- No automatic message sending on page load
- User can see what message will be sent

### XSS Prevention
- Message text is static (no user input)
- If adding custom prompts, sanitize input:
```typescript
function sanitizePrompt(prompt: string): string {
  return prompt.replace(/[<>'"]/g, '');
}
```

## Browser Compatibility

| Feature | Chrome | Firefox | Edge | Safari |
|---------|--------|---------|------|--------|
| scripting API | ✅ v90+ | ✅ v102+ | ✅ v90+ | ❌ N/A |
| activeTab | ✅ | ✅ | ✅ | ✅ |
| dispatchEvent | ✅ | ✅ | ✅ | ✅ |

**Note**: Safari does not support Manifest V3 scripting API. Alternative approach needed for Safari extension.

## Troubleshooting

### Message doesn't send
- Check permissions in manifest
- Verify target URL matches host_permissions
- Inspect console for error messages
- Check if textarea selector is correct

### Submit button doesn't click
- Verify form structure on target page
- Check if button is disabled initially
- Increase setTimeout delay if needed
- Inspect element in DevTools

### Events don't trigger
- Try different event types (keyup, keydown)
- Check if framework uses custom events
- Verify bubbles: true is set
- Add event listener in page to debug
