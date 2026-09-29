import '@d3cloud/ui/tokens.css';
import '@d3cloud/ui/base.css';
import './styles/mobile-targets.css';
import './styles/links.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastRegion } from '@d3cloud/ui';
import { App } from './App';

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    {/* PST-T-14.7: one polite region for toasts (the composer's Discard → Undo). Outside the
        ThemeProvider is fine: the theme is an attribute on <html>, which the region's tokens read. */}
    <ToastRegion label="Notifications">
      <App />
    </ToastRegion>
  </StrictMode>,
);
