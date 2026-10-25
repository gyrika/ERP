import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import './ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { httpTransport, pairFromUrl, startSync, syncToken } from './services/syncClient.ts';
import { startPhotoSync } from './services/photos.ts';
import { startManagerPhone } from './services/managerPhone.ts';
import { isManagerPhone, phoneToken } from './services/pairing.ts';
import { setUpOwnerApp } from './services/ownerApp.ts';
import { numbersLocally } from './services/auth.ts';
import { startLocalScheduler } from './services/inventoryStore.ts';
import { Root } from './ui/Root.tsx';
import { UpdateScreen } from './ui/UpdateScreen.tsx';
import { applyTheme } from './ui/theme.ts';

applyTheme(); // light, dark, or following the system: this screen's own choice

// Sync starts only on a paired device (docs/server-setup.md); otherwise the app works on its own, as before.
pairFromUrl();
setUpOwnerApp(); // after pairing: the owner's key goes into the phone app's description
const token = syncToken();
if (token) startSync(httpTransport(token));
// The phone apps (SCRUM-94/95): what they record, and the manager's shelf photos, go to the cloud.
if (phoneToken()) startManagerPhone(); // the owner's OK / Ask too (SCRUM-95)
if (isManagerPhone()) startPhotoSync();
// No shop server here (the demo): this device sends held batches to the kitchen itself.
if (numbersLocally()) startLocalScheduler();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
    <UpdateScreen />
  </StrictMode>,
);
