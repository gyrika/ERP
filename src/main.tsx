import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import './ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { httpTransport, pairFromUrl, startSync, syncToken } from './services/syncClient.ts';
import { Root } from './ui/Root.tsx';

// Sync starts only on a paired device (docs/server-setup.md); otherwise the app works on its own, as before.
pairFromUrl();
const token = syncToken();
if (token) startSync(httpTransport(token));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
