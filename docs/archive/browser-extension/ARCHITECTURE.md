# Browser Extension - Architecture

## Overview

The Atlas Browser Extension is built using modern web technologies:
- **WXT 0.19.29**: Next-generation web extension framework with Vite integration
- **React 18.3.1**: UI framework with hooks and modern patterns
- **Chakra UI 3.2.2**: Component library and design system
- **ReactFlow 11.11.4**: Interactive diagram visualization
- **Framer Motion 11.18.2**: Animation library
- **TypeScript 5.9.3**: Type-safe development

## Technology Stack

### WXT Framework
WXT provides:
- File-based entrypoint system
- Hot module replacement (HMR)
- Multi-browser support (Chrome, Firefox, Edge)
- Automatic manifest generation
- Built-in TypeScript support

### React 18
Key features used:
- Hooks (useState, useEffect, useMemo, useCallback)
- Context API for global state management
- Strict mode for development
- Concurrent features for better UX
- Component composition patterns

### Chakra UI
Provides:
- Accessible, composable components
- Theme system with CSS variables
- Responsive design utilities
- Dark mode support
- Animation support via Framer Motion

### ReactFlow
Used for:
- Interactive node-based diagrams
- Kubernetes infrastructure visualization
- Auto-layout algorithms
- Zoom/pan/fit controls
- Custom node rendering

### Framer Motion
Used for:
- Entry animations
- Button interactions
- Page transitions
- Gesture-based interactions
- UI feedback

## Feature Class Architecture

### AtlasFeatureClass Pattern

All grid-based features extend the `AtlasFeatureClass` base class to ensure consistent behavior:

```typescript
abstract class AtlasFeatureClass<TProps = {}> {
  // Required implementations
  abstract readonly name: string;              // Display name
  abstract readonly icon: IconType;            // Icon component
  abstract readonly eventFilters: EventFilter[]; // Event subscriptions
  abstract processEvent(event: StreamEvent): void; // Event handler
  abstract render(props?: TProps): ReactElement;  // React component
  
  // Optional lifecycle hooks
  onMount?(): void | Promise<void>;    // Called when added to grid
  onUnmount?(): void | Promise<void>;  // Called when removed from grid
  
  // Default grid configuration
  readonly gridConfig: GridItemConfig = {
    closable: true,      // Can user close this?
    maximizable: true    // Can user maximize this?
  };
}
```

### Feature Categories

**Grid-Based Features** (extend AtlasFeatureClass):
- **DiagramFeature** - Infrastructure diagram (singleton pattern)
  - Visualizes Kubernetes cluster
  - Processes `infrastructure_stream` and `k8s_diagram` events
  - Single instance shared across application
- **QueryViewerFeature** - Query results (factory pattern)
  - Displays database query results (logs, metrics, traces)
  - Creates multiple instances (one per query)
  - Each instance is independent

**Fixed-Position Components** (standard React components):
- **SideStepper** - Timeline/stepper sidebar (always visible)
- **StreamStatus** - Connection status indicator (corner badge)
- **Dashboard** - Empty state with action cards
- **Settings** - Configuration panels and dialogs

### Grid Management System

**Home.tsx** orchestrates the grid using feature instances:

```typescript
// State management
const [gridItems, setGridItems] = useState<GridItem[]>([]);

// Add feature to grid
const addToGrid = useCallback((id: string, feature: AtlasFeatureClass) => {
  setGridItems(prev => {
    if (prev.some(item => item.id === id)) return prev; // Prevent duplicates
    return [...prev, { id, feature }];
  });
  feature.onMount?.(); // Call lifecycle hook
}, []);

// Remove feature from grid
const removeFromGrid = useCallback((id: string) => {
  setGridItems(prev => {
    const item = prev.find(i => i.id === id);
    item?.feature.onUnmount?.(); // Call lifecycle hook
    return prev.filter(i => i.id !== id);
  });
  if (maximizedItem === id) setMaximizedItem(null);
}, [maximizedItem]);

// Render grid items
const gridItemsUI = useMemo(() => {
  return gridItems.map(({ id, feature }) => ({
    id,
    name: feature.name,
    icon: feature.icon,
    content: feature.render(),
    closable: feature.gridConfig.closable,
    maximizable: feature.gridConfig.maximizable
  }));
}, [gridItems]);
```

### Event Processing Flow

```
1. StreamContext receives SSE events
2. Home.tsx filters events by QUERY_TOOL_NAMES
3. Groups Init + Response events by session
4. Creates QueryViewerFeature instances
5. Adds to grid via addToGrid()
6. Feature.render() called on each render cycle
```

## Project Structure

```
apps/browser-extension/
├── entrypoints/              # Extension entrypoints
│   ├── background.ts         # Background service worker
│   ├── inject.ts            # Inject script for fetch interception
│   ├── welcome.html         # Welcome/onboarding page
│   ├── popup/               # Extension popup UI
│   │   ├── App.tsx
│   │   ├── index.html
│   │   └── main.tsx
│   └── sidepanel/           # Main side panel application
│       ├── index.html
│       ├── main.tsx         # React entry point
│       ├── App.tsx          # Root component
│       └── style.css
├── src/
│   ├── app/                 # Global app setup
│   │   ├── providers/       # React context providers
│   │   │   ├── ExtensionProvider.tsx  # Main state management
│   │   │   ├── ThemeProvider.tsx      # Theme context
│   │   │   └── ChakraProvider.tsx     # Chakra UI setup
│   │   ├── routes/          # Routing logic
│   │   └── types/           # TypeScript types
│   ├── features/            # Feature modules (10 total)
│   │   ├── alerts/          # 📌 Fixed component - Alert toasts
│   │   │   └── components/
│   │   │       └── AlertHandler.tsx
│   │   ├── azdo-create-workitem/ # 🔲 Grid feature - Work item creation
│   │   │   ├── AzdoCreateWorkItemFeature.tsx
│   │   │   ├── components/
│   │   │   │   ├── CreateWorkItemForm.tsx
│   │   │   │   └── WorkItemSuccess.tsx
│   │   │   └── hooks/
│   │   │       └── useCreateWorkItem.ts
│   │   ├── azdo-start-workitem/ # 🔲 Grid feature - Work item viewer
│   │   │   ├── AzdoWorkItemFeature.tsx
│   │   │   └── components/
│   │   │       └── WorkItemModal.tsx
│   │   ├── dashboard/       # 📌 Fixed component - Empty state
│   │   │   └── components/
│   │   │       └── Dashboard.tsx
│   │   ├── dev-mode/        # 📌 Fixed component - Dev tools panel
│   │   │   └── components/
│   │   │       └── DevMode.tsx
│   │   ├── diagram/         # 🔲 Grid feature - Architecture diagrams
│   │   │   ├── DiagramFeature.tsx
│   │   │   ├── components/
│   │   │   │   ├── ArchitectureDiagram.tsx
│   │   │   │   └── K8sNode.tsx
│   │   │   ├── hooks/
│   │   │   │   └── useDiagram.ts       # SSE connection
│   │   │   └── utils/
│   │   ├── home/            # 📌 Fixed component - Grid + Timeline
│   │   │   └── components/
│   │   │       ├── Home.tsx             # Grid manager
│   │   │       ├── GridItem.tsx
│   │   │       └── SideStepper.tsx      # Workflow timeline
│   │   ├── profile-settings/ # 📌 Fixed component - User profile
│   │   │   └── components/
│   │   │       └── ProfileSettingsComponent.tsx
│   │   ├── query-viewer/    # 🔲 Grid feature - Query results
│   │   │   ├── QueryViewerFeature.tsx
│   │   │   └── components/
│   │   │       ├── LogsViewer.tsx
│   │   │       ├── MetricsViewer.tsx
│   │   │       └── TracesViewer.tsx
│   │   └── settings/        # 📌 Fixed component - Theme/animation
│   │       └── components/
│   │           ├── AnimationSelector.tsx
│   │           └── ThemeSelector.tsx
│   └── shared/              # Shared utilities
│       ├── classes/
│       │   └── AtlasFeatureClass.ts   # Base feature class
│       ├── components/      # Reusable UI components
│       ├── contexts/        # React contexts
│       │   ├── StreamContext.tsx       # SSE streaming
│       │   └── SessionContext.tsx      # Session management
│       ├── hooks/           # Custom hooks
│       ├── types/           # TypeScript types
│       └── utils/           # Helper functions
└── public/                  # Static assets
    ├── content.js           # Content script
    └── prose-observer.js    # DOM observer
```

## Feature Modules (10 Total)

### Grid-Based Features (4)
Features that extend `AtlasFeatureClass` and render in the Home grid:

#### 1. diagram (DiagramFeature)
- **Pattern**: Singleton
- **Purpose**: Kubernetes infrastructure visualization
- **Events**: `infrastructure_stream`, `k8s_diagram`
- **Components**: ReactFlow with custom nodes, auto-layout
- **Lifecycle**: Single instance across application

#### 2. query-viewer (QueryViewerFeature)
- **Pattern**: Factory (multiple instances)
- **Purpose**: Display query results (logs, metrics, traces)
- **Events**: `logs_query`, `metrics_query`, `traces_query`
- **Components**: Data tables with pagination, filtering
- **Lifecycle**: New instance per query

#### 3. azdo-start-workitem (AzdoWorkItemFeature)
- **Pattern**: Factory (multiple instances)
- **Purpose**: Azure DevOps work item viewer
- **Events**: `azdo_start_workitem`
- **Components**: Work item modal with details
- **Lifecycle**: New instance per work item

#### 4. azdo-create-workitem (AzdoCreateWorkItemFeature)
- **Pattern**: Factory (multiple instances)
- **Purpose**: Azure DevOps work item creation with AI-assisted form
- **Events**: `azdo_create_workitem`
- **Components**: Pre-filled form modal, work item creation hook
- **Lifecycle**: New instance per work item creation request

### Fixed-Position Components (6)
Standard React components that don't use the feature class pattern:

#### 5. home
- **Purpose**: Grid container managing all grid-based features + workflow timeline
- **Location**: Main content area
- **Key Files**: `Home.tsx`, `GridItem.tsx`, `SideStepper.tsx`
- **Responsibilities**: 
  - Grid state management (add/remove/maximize features)
  - Event filtering and routing to features
  - Timeline sidebar (**SideStepper**): Displays `Atlas_ui_stepper` workflow progress with step-by-step updates

#### 6. dashboard
- **Purpose**: Empty state with action cards
- **Location**: Shown when no features in grid
- **Components**: Animated backgrounds (Hyperspeed, Magnet Lines, Cubes)

#### 7. alerts
- **Purpose**: Toast notifications system
- **Location**: Top-right corner overlay
- **Events**: `Atlas_ui_alert`
- **Components**: Chakra UI toasts with auto-dismiss

#### 8. settings
- **Purpose**: Theme and animation configuration
- **Location**: Settings sidebar/modal
- **Components**: `ThemeSelector`, `AnimationSelector`

#### 9. profile-settings
- **Purpose**: User profile and preferences
- **Location**: Settings modal or dedicated page
- **Components**: Profile form, avatar upload

#### 10. dev-mode
- **Purpose**: Developer tools and debugging panel
- **Location**: Bottom drawer or side panel
- **Components**: Event log, connection status, feature inspector

### Entrypoint Scripts

#### Background Script
- **File**: `entrypoints/background.ts`
- **Purpose**: Service worker for background tasks
- **Features**:
  - Message routing between sidepanel and content scripts
  - Extension lifecycle management
  - SSE connection management

#### Inject Script
- **File**: `entrypoints/inject.ts`
- **Purpose**: Runs in MAIN world to intercept fetch()
- **Features**:
  - Overrides window.fetch() to read SSE streams
  - Extracts architecture JSON from chat responses
  - Forwards data to content script

#### Content Script
- **File**: `public/content.js`
- **Purpose**: Bridge between inject and background
- **Features**:
  - Receives messages from inject script
  - Forwards to background worker
  - Cleans UI markers from chat interface

#### Sidepanel
- **Files**: `entrypoints/sidepanel/`
- **Purpose**: Main React application UI
- **Features**:
  - Grid-based feature display
  - ReactFlow diagram visualization
  - Query result tables
  - Theme and animation controls

#### Popup
- **Files**: `entrypoints/popup/`
- **Purpose**: Extension icon click UI
- **Features**:
  - Quick actions (open sidepanel, go to settings)
  - Connection status display
  - Theme toggle

## Component Architecture
Feature Classes (Grid-Based)

Feature classes encapsulate all logic for grid-renderable features:

```typescript
// DiagramFeature.tsx
export class DiagramFeature extends AtlasFeatureClass {
  readonly name = 'Infrastructure Diagram';
  readonly icon = LuNetwork;
  readonly eventFilters = [
    { toolNames: ['infrastructure_stream', 'k8s_diagram'] }
  ];
  
  processEvent(event: StreamEvent): void {
    // Handled by ArchitectureDiagram component internally
  }
  
  render() {
    return <ArchitectureDiagram />;
  }
   (Component-Level)
React hooks for component state:
```typescript
const [nodes, setNodes] = useState<Node[]>([]);
const [isStreaming, setIsStreaming] = useState(false);
const memoizedValue = useMemo(() => computeValue(data), [data]);
const callback = useCallback(() => doSomething(), []);
```

### Global State (Context API)
- **ExtensionProvider**: Current page, target URL detection
- **ThemeProvider**: Theme selection and CSS variables
- **StreamContext**: SSE events, event filtering

### Persistent State
- `browser.storage.sync` - User settings (theme, animation)
- `browser.storage.local` - Cached data, session state

### Grid State (Home.tsx)
```typescript
const [gridItems, setGridItems] = useState<GridItem[]>([]);
consFramer Motion
Entry and interaction animations:
```tsx
import { motion } from 'framer-motion';

<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.6 }}
>
  Content
</motion.div>
```

### Animated Backgrounds (ReactBits)
- **Hyperspeed**: 3D highway with car lights (Three.js)
- **MagnetLines**: Interactive magnetic line field
- **Cubes**: GSAP-animated tilting 3D cubes

### Interaction Feedback
```tsx
<motion.button
  whileHover={{ scale: 1.05 }}
  whileTap={{ scale: 0.95 }}
>
  Click me
</motion.button>
```
### React Components

Standard React functional components with hooks:

```typescript
export const ArchitectureDiagram: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { isStreaming, startStreaming } = useDiagram();
  
  useEffect(() => {
    // Component lifecycle
  }, []);
  
  return (
    <ReactFlow nodes={nodes} edges={edges} />
  );
};
```

### Context Providers

Global state management using React Context:

```typescript
// ExtensionProvider.tsx
export const ExtensionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [isOnTargetUrl, setIsOnTargetUrl] = useState(false);
  
  return (
    <ExtensionContext.Provider value={{ currentPage, setCurrentPage, isOnTargetUrl }}>
      {children}
    </ExtensionContext.Provider>
  );
};

// Usage in components
const Component = () => {
  const { currentPage, setCurrentPage } = useExtension();
  return <button onClick={() => setCurrentPage('diagram')}>Go to Diagram</button>;
};
```n
- **Browser API**: Cross-context messaging

## State Management

### Local State
- Component-level `$state` for UI state
- Derived values with `$derived`
- Effects with `$effect`

### Persistent State
- `browser.storage.sync` for user settings
- `browser.storage.local` for cached data

### Message Passing
```typescript
// From popup/content to background
browser.runtime.sendMessage({ type: 'ACTION', data: {} });

// From background to content scripts
browser.tabs.sendMessage(tabId, { type: 'ACTION', data: {} });
```

## Animation System

### Entry Animations
```typescript
anime({
  targets: element,
  translateY: [20, 0],
  opacity: [0, 1],
  duration: 800,
  easing: 'easeOutExpo'
});
```

### Interaction Feedback
```typescript
anime({
  targets: button,
  scale: [1, 0.95, 1],
  duration: 300,
  easing: 'easeInOutQuad'
});
```

## Build System

### Development
```bash
pnpm dev           # Chrome (default)
pnpm dev:chrome    # Chrome explicitly
pnpm dev:firefox   # Firefox
```

### Production Build
```bash
pnpm build         # All browsers
pnpm build:chrome  # Chrome only
pnpm build:firefox # Firefox only
```

### Distribution
```bash
pnpm zip           # Create distribution packages
```

## Manifest Generation

WXT automatically generates `manifest.json` from:
1. `wxt.config.ts` global settings
2. Entrypoint-specific configurations
3. Detected entrypoints

Example manifest configuration:
```typescript
export default defineConfig({
  manifest: {
    name: 'Extension Name',
    permissions: ['storage', 'tabs'],
    host_permissions: ['*://*/*']
  }
});
```

## Browser Compatibility

### Chrome/Edge (MV3)
- Service worker background
- Full API support
- Optimized build

### Firefox (MV2/MV3)
- Background page/worker
- Compatible APIs
- Firefox-specific features

WXT handles differences automatically.

## Security Considerations

1. **Content Security Policy**
   - No inline scripts in HTML
   - External resources via manifest

2. **Permissions**
   - Request minimal permissions
   - Explain permission usage

3. **Data Storage**
   - Encrypt sensitive data
   - Use sync storage for settings

4. **Message Validation**
   - Validate all incoming messages
   - Type-check message data

## Performance Optimization

1. **Code Splitting**
   - WXT automatically splits entrypoints
   - Lazy load heavy libraries

2. **Animation Performance**
   - Use transform/opacity for animations
   - Avoid layout thrashing

3. **Bundle Size**
   - Tree-shaking enabled
   - Minimal dependencies

## Development Workflow

1. **Setup**: `pnpm install`
2. **Develop**: `pnpm dev`
3. **Test**: Load extension in browser
4. **Build**: `pnpm build`
5. **Package**: `pnpm zip`

## Testing Strategy

### Manual Testing
1. Load unpacked extension from `.output/chrome-mv3`
2. Test all entrypoints
3. Verify permissions
4. Check console for errors

### Browser Testing
- Chrome DevTools for debugging
- Firefox Add-on Debugger
- Network tab for API calls

## Deployment

1. **Build Production**: `pnpm build:chrome`
2. **Create Package**: `pnpm zip:chrome`
3. **Upload**: Chrome Web Store Developer Dashboard
4. **Submit**: Complete store listing

## Future Enhancements

- [ ] E2E testing with Playwright
- [ ] Unit tests for components
- [ ] CI/CD pipeline
- [ ] Browser-specific features
- [ ] Advanced animations
- [ ] State persistence library
