/**
 * Device storage keys. /?demo uses its own namespace, so the demo's fake
 * orders never mix with the real counter's orders, kitchen or event log.
 */
export const isDemo = (): boolean =>
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');

export const storageKey = (name: string): string => `${isDemo() ? 'cb.demo.' : 'cb.'}${name}`;
