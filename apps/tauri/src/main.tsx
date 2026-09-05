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
