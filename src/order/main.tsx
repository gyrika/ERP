import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import './order.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSite } from './OrderSite.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OrderSite />
  </StrictMode>,
);
