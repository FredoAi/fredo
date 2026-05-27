# Browser Extension - Setup Guide

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Chrome or Firefox browser

## Installation

### 1. Install Dependencies

From the monorepo root:
```bash
pnpm install
```

Or from the browser-extension directory:
```bash
cd apps/browser-extension
pnpm install
```

### 2. Development Setup

Start the development server:
```bash
# From monorepo root
pnpm --filter @Fredo/browser-extension dev

# Or from browser-extension directory
cd apps/browser-extension
pnpm dev
```

This will:
- Start Vite dev server with HMR
- Watch for file changes
- Output to `.output/chrome-mv3`

### 3. Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `.output/chrome-mv3` directory from your project

### 4. Load Extension in Firefox

For Firefox, use the Firefox-specific build:
```bash
pnpm dev:firefox
```

Then:
1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select any file in the `.output/firefox-mv2` directory

## Project Configuration

### WXT Configuration

Edit `wxt.config.ts`:

```typescript
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  
  manifest: {
    name: 'Your Extension Name',
    description: 'Your description',
    permissions: ['storage', 'tabs'],
  },
  
  vite: () => ({
    // Custom Vite config
  }),
});
```

### TypeScript Configuration

The project uses TypeScript with strict mode enabled. Configuration is in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "strict": true,
    "types": ["wxt/client-types"]
  }
}
```

### Svelte Configuration

Svelte 5 is pre-configured through the WXT Svelte module. The module handles:
- Svelte compiler options
- Vite plugin integration
- HMR for Svelte components

## Adding Features

### Creating a New Entrypoint

#### Popup Example
```
entrypoints/
  popup/
    index.html
    main.ts
    App.svelte
    style.css
```

`index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Popup</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`main.ts`:
```typescript
import './style.css';
import App from './App.svelte';

const app = new App({
  target: document.getElementById('app')!,
});

export default app;
```

`App.svelte`:
```svelte
<script lang="ts">
  let count = $state(0);
</script>

<button onclick={() => count++}>
  Count: {count}
</button>
```

### Creating Components

Add reusable components to `components/`:

```svelte
<!-- components/MyComponent.svelte -->
<script lang="ts">
  import anime from 'animejs';
  import { onMount } from 'svelte';

  interface Props {
    title: string;
  }

  let { title }: Props = $props();
  let elementRef: HTMLDivElement;

  onMount(() => {
    anime({
      targets: elementRef,
      opacity: [0, 1],
      duration: 600
    });
  });
</script>

<div bind:this={elementRef}>
  <h2>{title}</h2>
</div>
```

### Using Anime.js

Import and use Anime.js for animations:

```typescript
import anime from 'animejs';

// Basic animation
anime({
  targets: '.element',
  translateX: 250,
  duration: 2000
});

// With easing
anime({
  targets: element,
  scale: [1, 1.2, 1],
  duration: 600,
  easing: 'easeInOutQuad'
});
```

### Storage API

#### Save Data
```typescript
await browser.storage.sync.set({ key: 'value' });
```

#### Retrieve Data
```typescript
const data = await browser.storage.sync.get('key');
console.log(data.key);
```

#### Listen for Changes
```typescript
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.key) {
    console.log('Key changed:', changes.key.newValue);
  }
});
```

### Message Passing

#### Send from Popup to Background
```typescript
const response = await browser.runtime.sendMessage({
  type: 'ACTION',
  data: { /* ... */ }
});
```

#### Send from Background to Content Script
```typescript
const tabs = await browser.tabs.query({ active: true });
const response = await browser.tabs.sendMessage(tabs[0].id, {
  type: 'ACTION',
  data: { /* ... */ }
});
```

#### Listen for Messages
```typescript
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ACTION') {
    // Handle message
    sendResponse({ success: true });
  }
  return true; // Keep channel open for async response
});
```

## Development Tips

### Hot Module Replacement

Changes to entrypoints and components will hot reload automatically. For background scripts, the service worker will reload.

### Debugging

#### Popup/Options
- Right-click on popup → "Inspect"
- Open DevTools normally for options page

#### Background Script
- Chrome: `chrome://extensions/` → "Inspect views: background page"
- Firefox: `about:debugging` → Inspect

#### Content Script
- Open DevTools on the webpage
- Content script logs appear in page console

### Console Logging

```typescript
// These appear in different consoles
console.log('From popup');      // Popup DevTools
console.log('From background'); // Background DevTools
console.log('From content');    // Page DevTools
```

## Building for Production

### Build Commands

```bash
# Build all browsers
pnpm build

# Build specific browser
pnpm build:chrome
pnpm build:firefox

# Create distribution zip
pnpm zip
pnpm zip:chrome
pnpm zip:firefox
```

### Output

Production builds are output to:
- `.output/chrome-mv3/` - Chrome build
- `.output/firefox-mv2/` - Firefox build
- `.output/chrome-mv3.zip` - Distribution package

## Troubleshooting

### Extension Not Loading

1. Check console for errors in build output
2. Verify `.output` directory exists
3. Check manifest is generated correctly
4. Ensure all permissions are declared

### HMR Not Working

1. Restart dev server
2. Reload extension in browser
3. Check WebSocket connection in DevTools

### TypeScript Errors

1. Run `pnpm install` to ensure types are installed
2. Check `tsconfig.json` includes WXT types
3. Restart TypeScript server in editor

### Svelte Component Errors

1. Ensure using Svelte 5 syntax (runes)
2. Check component imports use `.svelte` extension
3. Verify WXT Svelte module is in config

## IDE Setup

### VS Code

Recommended extensions:
- Svelte for VS Code (`svelte.svelte-vscode`)
- ESLint (`dbaeumer.vscode-eslint`)
- TypeScript Vue Plugin (`Vue.vscode-typescript-vue-plugin`)

Settings (`.vscode/settings.json`):
```json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "svelte.plugin.svelte.defaultScriptLanguage": "ts"
}
```

## Next Steps

- Review [Architecture](./ARCHITECTURE.md) for system design
- See [Usage Guide](./USAGE.md) for feature implementation
- Check WXT docs: https://wxt.dev
- Review Svelte 5 docs: https://svelte.dev
- Explore Anime.js: https://animejs.com
