import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from 'reactflow';
import {
  AppProvider,
  Router,
  StreamProvider,
  ThemeProvider,
  Provider,
  Toaster,
  TauriAdapter,
  CompanionProvider,
  FredoCompanion,
  adapterBridge,
} from '@fredo/ui';

const adapter = new TauriAdapter();

// Register adapter with the bridge BEFORE React renders so FredoCompanion
// can call adapterBridge.llmChat() as soon as it mounts.
adapterBridge.setInvoke(adapter.invoke!.bind(adapter));
adapterBridge.setLlmChat(adapter.llmChat.bind(adapter));
adapterBridge.setLlmChatWithImage(adapter.llmChatWithImage.bind(adapter));
// #2893 ST-7 rework — the skill-aware path must be registered in the SERVED
// Tauri entry (this file), not only in the standalone UI dev entry. `adapter`
// is the concrete TauriAdapter, which implements the method.
adapterBridge.setLlmChatWithSkills(adapter.llmChatWithSkills.bind(adapter));

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('[Fredo] Root element #root not found');

createRoot(rootElement).render(
  <React.StrictMode>
    <Provider>
      <ThemeProvider>
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
      </ThemeProvider>
    </Provider>
  </React.StrictMode>,
);
