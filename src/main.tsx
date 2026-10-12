import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import './ui/styles.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import { InventoryView } from './ui/InventoryView.tsx';
import { Kitchen } from './ui/Kitchen.tsx';
import { SupplierView } from './ui/SupplierView.tsx';

/** One app, one view per device: kitchen / inventory tablets bookmark their hash. */
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (hash === '#kitchen') return <Kitchen />;
  if (hash === '#inventory') return <InventoryView />;
  if (hash === '#suppliers') return <SupplierView />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
