# Browser Extension - Usage Guide

## Overview

This guide covers common patterns and features for the Atlas Browser Extension.

## Extension Features

### Popup Interface

The popup appears when clicking the extension icon. It provides:
- Quick actions
- Status information
- Settings access
- Message testing

#### Popup Code Structure

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import anime from 'animejs';

  let count = $state(0);

  function handleAction() {
    // Your action logic
    count++;
  }

  onMount(() => {
    // Animate entrance
    anime({
      targets: '.popup-container',
      opacity: [0, 1],
      translateY: [20, 0],
      duration: 600
    });
  });
</script>

<div class="popup-container">
  <button onclick={handleAction}>
    Action Count: {count}
  </button>
</div>
```

### Options Page

Full-featured settings interface that opens in a new tab:

```svelte
<script lang="ts">
  let settings = $state({
    theme: 'light',
    notifications: true
  });

  async function saveSettings() {
    await browser.storage.sync.set({ settings });
  }

  async function loadSettings() {
    const stored = await browser.storage.sync.get('settings');
    if (stored.settings) {
      settings = stored.settings;
    }
  }
</script>
```

### Background Script

Service worker for background tasks:

```typescript
export default defineBackground(() => {
  // Listen for extension install
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      // First install
      browser.tabs.create({
        url: browser.runtime.getURL('/welcome.html')
      });
    }
  });

  // Handle messages
  browser.runtime.onMessage.addListener((message, sender) => {
    console.log('Message from:', sender.tab?.id, message);
  });

  // Periodic tasks
  browser.alarms.create('refresh', { periodInMinutes: 60 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'refresh') {
      // Refresh data
    }
  });
});
```

### Content Scripts

Inject functionality into web pages:

```typescript
export default defineContentScript({
  matches: ['*://*.example.com/*'],
  
  main() {
    // Add UI element to page
    const widget = createWidget();
    document.body.appendChild(widget);

    // Listen for messages
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'UPDATE_WIDGET') {
        updateWidget(message.data);
      }
    });

    // Observe page changes
    const observer = new MutationObserver((mutations) => {
      // Handle DOM changes
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
});

function createWidget(): HTMLElement {
  const widget = document.createElement('div');
  widget.id = 'my-widget';
  
  Object.assign(widget.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    padding: '12px',
    background: 'white',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
  });

  return widget;
}
```

## Common Patterns

### State Management

#### Component State
```svelte
<script lang="ts">
  // Reactive state
  let count = $state(0);
  
  // Derived values
  let doubled = $derived(count * 2);
  
  // Effects for side effects
  $effect(() => {
    console.log('Count changed:', count);
  });
</script>
```

#### Persistent State
```typescript
// Save to storage
async function saveData(key: string, value: any) {
  await browser.storage.sync.set({ [key]: value });
}

// Load from storage
async function loadData(key: string) {
  const result = await browser.storage.sync.get(key);
  return result[key];
}

// Watch for changes
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.myKey) {
    console.log('New value:', changes.myKey.newValue);
  }
});
```

### Animation Patterns

#### Entry Animation
```typescript
import anime from 'animejs';

onMount(() => {
  anime({
    targets: element,
    translateY: [30, 0],
    opacity: [0, 1],
    duration: 800,
    easing: 'easeOutExpo'
  });
});
```

#### Interaction Feedback
```typescript
function animateClick(target: HTMLElement) {
  anime({
    targets: target,
    scale: [1, 0.95, 1],
    duration: 300,
    easing: 'easeInOutQuad'
  });
}
```

#### Stagger Animation
```typescript
anime({
  targets: '.list-item',
  translateX: [-50, 0],
  opacity: [0, 1],
  delay: anime.stagger(100), // 100ms between each
  duration: 600
});
```

#### Timeline Animation
```typescript
const timeline = anime.timeline({
  easing: 'easeOutExpo',
  duration: 750
});

timeline
  .add({
    targets: '.first',
    translateX: [100, 0]
  })
  .add({
    targets: '.second',
    translateY: [100, 0]
  }, '-=400'); // Overlap by 400ms
```

### Communication Patterns

#### Popup ↔ Background
```typescript
// From popup
async function sendToBackground(data: any) {
  const response = await browser.runtime.sendMessage({
    type: 'ACTION',
    payload: data
  });
  return response;
}

// In background
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ACTION') {
    // Process action
    sendResponse({ success: true, data: {} });
  }
  return true;
});
```

#### Background → Content Script
```typescript
// From background
async function sendToContent(tabId: number, data: any) {
  const response = await browser.tabs.sendMessage(tabId, {
    type: 'UPDATE',
    payload: data
  });
  return response;
}

// Get active tab
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
await sendToContent(tabs[0].id, myData);
```

#### Content Script → Background
```typescript
// From content script
async function notifyBackground(event: string, data: any) {
  const response = await browser.runtime.sendMessage({
    type: 'EVENT',
    event,
    data
  });
  return response;
}
```

### Component Patterns

#### Reusable Button Component
```svelte
<!-- components/AnimatedButton.svelte -->
<script lang="ts">
  import anime from 'animejs';

  interface Props {
    text: string;
    onclick?: () => void;
    variant?: 'primary' | 'secondary';
  }

  let { text, onclick, variant = 'primary' }: Props = $props();
  let buttonRef: HTMLButtonElement;

  function handleClick() {
    anime({
      targets: buttonRef,
      scale: [1, 0.95, 1],
      duration: 200
    });
    onclick?.();
  }
</script>

<button 
  bind:this={buttonRef}
  onclick={handleClick}
  class="btn btn-{variant}"
>
  {text}
</button>

<style>
  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
  }

  .btn-primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .btn-secondary {
    background: #e5e7eb;
    color: #374151;
  }
</style>
```

#### Modal Component
```svelte
<!-- components/Modal.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import anime from 'animejs';

  interface Props {
    isOpen: boolean;
    onClose: () => void;
    children: any;
  }

  let { isOpen = $bindable(), onClose, children }: Props = $props();
  let modalRef: HTMLDivElement;
  let overlayRef: HTMLDivElement;

  $effect(() => {
    if (isOpen) {
      anime({
        targets: [overlayRef, modalRef],
        opacity: [0, 1],
        duration: 300
      });
    }
  });

  function handleClose() {
    anime({
      targets: [overlayRef, modalRef],
      opacity: 0,
      duration: 200,
      complete: onClose
    });
  }
</script>

{#if isOpen}
  <div bind:this={overlayRef} class="overlay" onclick={handleClose}></div>
  <div bind:this={modalRef} class="modal">
    <button class="close" onclick={handleClose}>×</button>
    {@render children()}
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
  }

  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border-radius: 12px;
    padding: 24px;
    max-width: 500px;
    z-index: 1001;
  }

  .close {
    position: absolute;
    top: 12px;
    right: 12px;
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
  }
</style>
```

## Advanced Features

### Context Menus

```typescript
// In background script
browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: 'my-action',
    title: 'Do Something',
    contexts: ['selection', 'page']
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'my-action') {
    // Handle click
    console.log('Selected text:', info.selectionText);
  }
});
```

### Browser Actions

```typescript
// Update badge
browser.action.setBadgeText({ text: '5' });
browser.action.setBadgeBackgroundColor({ color: '#ff0000' });

// Update icon
browser.action.setIcon({
  path: {
    16: '/icons/icon-16.png',
    32: '/icons/icon-32.png'
  }
});

// Update title
browser.action.setTitle({ title: 'New Title' });
```

### Alarms

```typescript
// Create alarm
browser.alarms.create('refresh-data', {
  delayInMinutes: 1,
  periodInMinutes: 60
});

// Listen for alarms
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh-data') {
    refreshData();
  }
});
```

### Notifications

```typescript
browser.notifications.create({
  type: 'basic',
  iconUrl: '/icons/icon-128.png',
  title: 'Notification Title',
  message: 'Notification message'
});
```

## Testing

### Manual Testing Checklist

- [ ] Popup opens and functions correctly
- [ ] Options page opens in new tab
- [ ] Content script injects on target pages
- [ ] Background script initializes
- [ ] Storage persists across sessions
- [ ] Messages are sent/received correctly
- [ ] Animations are smooth
- [ ] No console errors

### Debug Tips

1. **Inspect popup**: Right-click popup → Inspect
2. **Debug background**: Extensions page → Inspect service worker
3. **Debug content script**: Page DevTools → Sources tab
4. **View storage**: DevTools → Application → Storage
5. **Monitor messages**: Add console.log in all contexts

## Best Practices

1. **Performance**
   - Use transform/opacity for animations
   - Debounce frequent events
   - Lazy load heavy components

2. **Security**
   - Validate all input
   - Use CSP headers
   - Sanitize user data

3. **UX**
   - Provide loading states
   - Show error messages
   - Animate transitions smoothly

4. **Code Quality**
   - Use TypeScript types
   - Handle errors gracefully
   - Keep components small

## Resources

- [WXT Documentation](https://wxt.dev)
- [Svelte 5 Docs](https://svelte.dev)
- [Anime.js Documentation](https://animejs.com/documentation/)
- [Chrome Extension APIs](https://developer.chrome.com/docs/extensions/reference/)
- [Firefox Extension APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)
