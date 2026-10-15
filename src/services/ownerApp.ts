import { useEffect, useState } from 'react';
import { isCloudSite, ownerToken } from './pairing.ts';

/**
 * The owner's phone app (cloud site only): its install description, carrying this
 * phone's key (an iPhone home-screen app has its own storage), and the offline copy
 * of the app itself (public/sw.js). The counter is a real Windows app instead.
 */
export const setUpOwnerApp = (): void => {
  if (!isCloudSite()) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  const key = ownerToken();
  link.href = key ? `/owner.webmanifest?k=${encodeURIComponent(key)}` : '/owner.webmanifest';
  document.head.appendChild(link);
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
};

interface InstallPrompt extends Event { prompt(): Promise<void> }

const standalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const isAppleInstallDevice = (userAgent: string, platform: string, maxTouchPoints: number): boolean =>
  /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);

/**
 * How to put the app on the home screen, if it is not there yet: a button where the browser
 * offers one (Android), the two taps to do where it does not (Apple mobile), nothing once installed.
 */
export function useInstall(): { kind: 'none' } | { kind: 'button'; install: () => void } | { kind: 'iphone' } {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [done, setDone] = useState(standalone);
  useEffect(() => {
    const offer = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPrompt); };
    const installed = () => { setDone(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', offer);
    window.addEventListener('appinstalled', installed);
    return () => { window.removeEventListener('beforeinstallprompt', offer); window.removeEventListener('appinstalled', installed); };
  }, []);
  if (done) return { kind: 'none' };
  if (prompt) return { kind: 'button', install: () => { void prompt.prompt(); setPrompt(null); } };
  return isAppleInstallDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) ? { kind: 'iphone' } : { kind: 'none' };
}
