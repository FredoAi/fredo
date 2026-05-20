# Browser Extension

Modern Chrome/Firefox extension built with WXT and React.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development
pnpm dev

# Build for production
pnpm build

# Create distribution package
pnpm zip
```

## Documentation

- [Architecture](./ARCHITECTURE.md) - System design and technical details
- [Setup Guide](./SETUP.md) - Installation and configuration
- [Usage Guide](./USAGE.md) - Common patterns and examples
- [Fetch Interception](./FETCH_INTERCEPTION_SOLUTION.md) - How to intercept fetch requests
- [Project Summary](./SUMMARY.md) - High-level overview

## Features

- ⚛️ Modern UI with React 18 & Chakra UI
- 🎨 Animated backgrounds with ReactBits & Three.js
- ⚡ Fast development with WXT + Vite
- 🔥 Hot module replacement
- 📦 Multi-browser support
- 🎭 Smooth animations with Framer Motion & GSAP
- 💾 Persistent storage
- 🔐 Type-safe with TypeScript
- 📊 ReactFlow for architecture diagrams

## Project Structure

```
browser-extension/
├── entrypoints/              # Extension entrypoints
│   ├── background.ts
│   ├── inject.ts
│   ├── popup/               # Extension popup
│   │   ├── App.tsx
│   │   └── index.html
│   ├── sidepanel/           # Main application
│   │   ├── App.tsx
│   │   ├── components/      # Shared components
│   │   └── lib/            # Utilities
│   ├── sop/                # SOP execution view
│   └── welcome.html         # Welcome page
├── src/
│   ├── app/                # Core application
│   │   ├── providers/      # Context providers
│   │   └── types/          # TypeScript types
│   └── features/           # Feature modules
│       ├── dashboard/      # Landing dashboard
│       ├── diagram/        # Architecture diagrams
│       ├── settings/       # Settings components
│       └── stepper/        # Step-by-step workflow
├── public/                 # Static assets
└── wxt.config.ts          # WXT configuration
```

## Development

Load the extension in your browser:

### Chrome
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `.output/chrome-mv3` directory

### Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select any file in `.output/firefox-mv2` directory

## Commands

```bash
# Development
pnpm dev              # Chrome (default)
pnpm dev:chrome       # Chrome explicitly
pnpm dev:firefox      # Firefox

# Production
pnpm build            # All browsers
pnpm build:chrome     # Chrome only
pnpm build:firefox    # Firefox only

# Distribution
pnpm zip              # Create zip packages
```

## Tech Stack

- [WXT](https://wxt.dev) - Web extension framework
- [React 18](https://react.dev) - UI framework
- [Chakra UI](https://www.chakra-ui.com) - Component library
- [ReactBits](https://reactbits.dev) - Animated components
- [ReactFlow](https://reactflow.dev) - Diagram rendering
- [Three.js](https://threejs.org) - 3D graphics
- [Framer Motion](https://www.framer.com/motion/) - Animation library
- [GSAP](https://greensock.com/gsap/) - Advanced animations
- [TypeScript](https://www.typescriptlang.org) - Type safety
- [Vite](https://vitejs.dev) - Build tool
