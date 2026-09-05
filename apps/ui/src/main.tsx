import React from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';
import './assets/fonts/fira-mono.css';
import '@maomaolabs/core/style.css';
import './features/home/fredo-desktop.css';
import { ReactFlowProvider } from 'reactflow';
import { Provider } from './shared/components/ui/provider';
import { Toaster } from './shared/components/ui/toaster';
import { StreamProvider } from './shared/contexts/StreamContext';
import { AppProvider } from './app/providers/AppProvider';
import { ThemeProvider } from './app/providers/ThemeProvider';
import { AnimationProvider } from './shared/contexts/AnimationContext';
import { CompanionProvider } from './shared/contexts/CompanionContext';
import { FredoCompanion } from './shared/components/companion';
import { Router } from './app/routes/Router';
import { DevAdapter } from './app/adapters/DevAdapter';
import { TauriAdapter } from './app/adapters/TauriAdapter';
import { adapterBridge } from './shared/utils/adapterBridge';

// Use TauriAdapter when running inside the Tauri webview, DevAdapter otherwise
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const adapter = isTauri ? new TauriAdapter() : new DevAdapter();

// Register synchronously BEFORE React renders so adapterBridge is always ready
adapterBridge.setInvoke(adapter.invoke.bind(adapter));
adapterBridge.setLlmChat(adapter.llmChat.bind(adapter));
adapterBridge.setLlmChatWithImage(adapter.llmChatWithImage.bind(adapter));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider>
      <ThemeProvider>
        <AnimationProvider>
          <StreamProvider>
            <AppProvider adapter={adapter}>
              <CompanionProvider>
                <ReactFlowProvider>
                  <Router />
                  <Toaster />
                </ReactFlowProvider>
                <FredoCompanion />
              </CompanionProvider>
            </AppProvider>
          </StreamProvider>
        </AnimationProvider>
      </ThemeProvider>
    </Provider>
  </React.StrictMode>,
);
