---
name: performance-optimization
description: Use ONLY when fredo-coder needs to optimize performance, reduce bundle size, fix memory issues, or improve app responsiveness. Covers React profiling, Rust optimization, Vite bundling, and Tauri performance tuning.
---

# Performance Optimization — fredo-coder

## When to Use

- App feels slow or unresponsive
- Bundle size is growing
- Memory leaks detected
- Build times are too long
- User reports performance issues
- Profiling reveals bottlenecks

## React Performance

### Profiling

```tsx
// Wrap component with React.memo if props don't change often
export const MyComponent = React.memo(({ data }) => {
  return <div>{data.map(item => <Item key={item.id} {...item} />)}</div>
});

// Use useMemo for expensive computations
const filtered = useMemo(() =>
  items.filter(item => item.status === 'active'),
  [items]
);

// Use useCallback for functions passed as props
const handleClick = useCallback((id: string) => {
  setSelectedId(id);
}, []);
```

### Virtualization

For long lists, use virtualization instead of rendering all items:

```tsx
// Use react-window or similar for lists > 100 items
import { FixedSizeList } from 'react-window';

<FixedSizeList
  height={400}
  itemCount={items.length}
  itemSize={35}
  width="100%"
>
  {({ index, style }) => (
    <div style={style}>{items[index].name}</div>
  )}
</FixedSizeList>
```

### Avoid Unnecessary Re-renders

```tsx
// ❌ Creates new object on every render
<Box style={{ margin: '8px' }} />

// ✅ Stable reference
const boxStyle = useMemo(() => ({ margin: '8px' }), []);
<Box style={boxStyle} />

// ❌ Inline arrow function in props
<Button onClick={() => handleClick(id)} />

// ✅ Stable callback
<Button onClick={useCallback(() => handleClick(id), [id])} />
```

### Stream Event Optimization

```tsx
// Filter events early to avoid processing unnecessary data
const { events } = useStream();
const mine = useMemo(() =>
  events.filter(e =>
    e.toolName === currentTool &&
    e.correlationId === currentId
  ),
  [events, currentTool, currentId]
);
```

## Vite Build Optimization

### Bundle Analysis

```bash
# Install bundle analyzer
pnpm add -D rollup-plugin-visualizer

# Add to vite.config.ts
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    visualizer({ open: true, filename: 'stats.html' })
  ]
});

# Build and analyze
pnpm build
```

### Code Splitting

```tsx
// Lazy load heavy components
const DiagramPanel = lazy(() =>
  import('./features/diagram/components/DiagramPanel')
);

// Route-based splitting
const RouteDiagram = lazy(() =>
  import('./features/diagram/DiagramFeature')
);
```

### Dependency Optimization

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          chakra: ['@chakra-ui/react', '@emotion/react'],
          three: ['three', '@react-three/fiber']
        }
      }
    }
  }
});
```

### Tree Shaking

```ts
// ✅ Named imports (tree-shakeable)
import { Box, Button, Flex } from '@chakra-ui/react';

// ❌ Default import (prevents tree shaking)
import Chakra from '@chakra-ui/react';
```

## Rust Performance

### Async Optimization

```rust
// ✅ Use Tauri's async runtime
tauri::async_runtime::spawn(async move {
    // Long-running work
});

// ✅ Use tokio::join! for parallel async operations
let (result1, result2) = tokio::join!(
    fetch_data_a(),
    fetch_data_b()
);

// ❌ Sequential async calls
let result1 = fetch_data_a().await;
let result2 = fetch_data_b().await; // Waits for first to complete
```

### Memory Management

```rust
// ✅ Use references to avoid cloning
fn process_data(data: &str) -> String {
    data.to_uppercase()
}

// ✅ Use Arc for shared ownership
use std::sync::Arc;
let shared_state = Arc::new(Mutex::new(State::new()));

// ❌ Unnecessary clones in hot paths
fn handle_request(data: String) { // Takes ownership, forces clone at call site
```

### Zero-Cost Abstractions

```rust
// ✅ Use iterators (zero-cost)
let sum: i32 = items.iter().filter(|&x| x > 0).map(|x| x * 2).sum();

// ✅ Use &str instead of String when possible
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
```

### Stream Event Efficiency

```rust
// ✅ Batch events when possible
let events = vec![
    StreamEvent::init("tool", corr_id.clone()),
    StreamEvent::response("tool", data, corr_id.clone()),
];
for event in events {
    emit_stream_event(&app, &event.tool_name, event.state, event.data, &event.corr_id)?;
}

// ✅ Use correlation IDs to track related events
let corr_id = uuid::Uuid::new_v4().to_string();
```

## Tauri Performance

### Webview Optimization

```tsx
// ✅ Use CSS transforms for animations (GPU accelerated)
<Box style={{ transform: 'translateY(0)', transition: 'transform 0.2s' }} />

// ❌ Avoid layout-triggering properties
<Box style={{ top: '0px', transition: 'top 0.2s' }} /> // Causes layout recalculation

// ✅ Use will-change sparingly for complex animations
<Box style={{ willChange: 'transform' }} />
```

### IPC Efficiency

```rust
// ✅ Keep IPC commands thin — do minimal work in the command handler
#[tauri::command]
pub async fn process_data(input: String, state: State<'_, MyState>) -> Result<String, String> {
    // Offload heavy work to spawned task
    let handle = tauri::async_runtime::spawn(async move {
        heavy_computation(input)
    });
    Ok(handle.await.map_err(|e| e.to_string())?)
}

// ❌ Block the main thread
#[tauri::command]
pub fn process_data(input: String) -> String {
    std::thread::sleep(Duration::from_secs(5)); // Blocks UI
    heavy_computation(input)
}
```

### Resource Loading

```tsx
// ✅ Lazy load images and heavy assets
<img loading="lazy" src={image} alt="" />

// ✅ Preload critical resources
<link rel="preload" href="/fonts/fira-mono.woff2" as="font" crossOrigin="" />

// ✅ Use WebP/AVIF for images
<picture>
  <source srcSet={imageWebp} type="image/webp" />
  <img src={imagePng} alt="" />
</picture>
```

## Chakra UI Performance

### Theme Optimization

```tsx
// ✅ Define theme once, reuse
const theme = createSystem({
  theme: { tokens: { /* ... */ } }
});

// ❌ Create theme in render (recreates on every render)
function App() {
  const theme = createSystem({ /* ... */ }); // Bad!
  return <ChakraProvider value={theme}>...</ChakraProvider>;
}
```

### Component Optimization

```tsx
// ✅ Use Chakra's built-in memoization
<Box>...</Box> // Chakra components are already optimized

// ✅ Extract static styles
const styles = {
  container: { display: 'flex', gap: '2' },
  card: { p: '4', borderRadius: 'md' }
};

// ❌ Inline style objects in render
<Box sx={{ display: 'flex', gap: '2' }}> // Creates new object each render
```

## Build Time Optimization

### Cargo Build

```bash
# Use release profile for benchmarks
cargo build --release

# Use sccache for faster rebuilds
cargo install sccache
export RUSTC_WRAPPER=sccache

# Parallel compilation
cargo build --jobs $(nproc)
```

### Vite Dev Server

```ts
// vite.config.ts
export default defineConfig({
  server: {
    // Use file system instead of polling
    watch: { usePolling: false }
  },
  optimizeDeps: {
    // Pre-bundle heavy dependencies
    include: ['react', 'react-dom', '@chakra-ui/react']
  }
});
```

## Memory Leak Detection

### React DevTools

```tsx
// Check for:
// 1. Unremoved event listeners
// 2. Unclosed subscriptions
// 3. Stale closures in useEffect

useEffect(() => {
  const unsub = subscribe(handler);
  return () => unsub(); // ✅ Cleanup
}, []);

// ❌ Missing cleanup
useEffect(() => {
  const interval = setInterval(() => {}, 1000);
  // No cleanup — leaks on unmount
}, []);
```

### Rust Memory

```rust
// Check for:
// 1. Unclosed file handles
// 2. Leaked Arc references
// 3. Growing collections without bounds

// ✅ Use bounded channels
use tokio::sync::mpsc;
let (tx, rx) = mpsc::channel(100); // Max 100 items in queue

// ❌ Unbounded channel can grow infinitely
let (tx, rx) = mpsc::unbounded_channel();
```

## Performance Checklist

Before shipping:

- [ ] Bundle size < 2MB (gzipped)
- [ ] Initial load < 3 seconds
- [ ] No memory leaks in React DevTools profiler
- [ ] No unoptimized images
- [ ] All heavy computations offloaded from main thread
- [ ] Stream events filtered by toolName and correlationId
- [ ] IPC commands validated and minimal
- [ ] No unnecessary re-renders (React Profiler clean)
- [ ] Build completes in < 60 seconds
