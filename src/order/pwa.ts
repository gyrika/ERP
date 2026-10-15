const CUSTOMER_HOST = 'cheesybeez.com';
const STATIC_PATHS = ['/assets/', '/icons/'];

export const isOrderAppHost = (): boolean =>
  window.location.hostname === CUSTOMER_HOST || /^\/order\/?$/.test(window.location.pathname);

export const setUpOrderApp = (): (() => void) => {
  if (!isOrderAppHost() || !('serviceWorker' in navigator)) return () => {};
  const scope = window.location.hostname === CUSTOMER_HOST ? '/' : '/order';

  const cacheLoadedAssets = () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return;
    const urls = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`${window.location.origin}/`))
      .map((name) => new URL(name))
      .filter((url) => STATIC_PATHS.some((path) => url.pathname.startsWith(path)))
      .map((url) => url.href);
    controller.postMessage({ type: 'CACHE_ASSETS', urls });
  };

  navigator.serviceWorker.addEventListener('controllerchange', cacheLoadedAssets);
  void navigator.serviceWorker.register('/order-sw.js', { scope }).then(
    cacheLoadedAssets,
    (error: unknown) => console.error('Could not enable the CheesyBeez ordering app offline shell.', error),
  );

  return () => {
    navigator.serviceWorker.removeEventListener('controllerchange', cacheLoadedAssets);
  };
};
