import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { createServices } from './app/services.js';
import { CfdView } from './screens/CfdView.js';
import { applyTheme } from './ui/theme.js';

applyTheme();
const root = createRoot(document.getElementById('root')!);
const mode = new URLSearchParams(window.location.search).get('mode') === 'cfd' ? 'cfd' : 'register';

if (mode === 'cfd') {
  // The CFD window needs no database, keychain or session: it only mirrors what the register sends.
  root.render(
    <StrictMode>
      <CfdView />
    </StrictMode>,
  );
} else {
  void createServices().then((services) => {
    // Test hook: lets Playwright inject scanner events and inspect state in the dev build only.
    if (import.meta.env.DEV) (window as unknown as { __pos: unknown }).__pos = services;
    root.render(
      <StrictMode>
        <App services={services} />
      </StrictMode>,
    );
  });
}
