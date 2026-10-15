import { useEffect, useState, useSyncExternalStore } from 'react';
import { PHOTO_MAX_SIDE, PHOTO_TARGET_BYTES } from '../domain/photos.ts';
import { storageKey } from '../ui/storage.ts';
import { syncToken } from './pairing.ts';

/**
 * Shelf photos on this device (SCRUM-94). A photo is shrunk on the phone to about
 * 150 KB, kept here until the shop PC has it (the shop Wi-Fi comes and goes), then
 * sent on its own; the count only carries its id. Without a server (development,
 * the demo) photos simply stay on this device.
 */
const QUEUE = () => storageKey('photos.queue');
const RETRY_MS = 30_000;

type Queue = Record<string, string>; // id -> base64 JPEG
const readQueue = (): Queue => { try { return JSON.parse(localStorage.getItem(QUEUE()) ?? '{}') as Queue; } catch { return {}; } };
const writeQueue = (q: Queue): void => { try { localStorage.setItem(QUEUE(), JSON.stringify(q)); } catch { /* full or blocked: it stays in memory until sent */ } };

export const newPhotoId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `ph-${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
};

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** The camera's photo, upright and shrunk until it is about 150 KB (JPEG, base64). */
export const shrinkPhoto = async (file: Blob): Promise<string> => {
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let side = PHOTO_MAX_SIDE;
  for (;;) {
    const scale = Math.min(1, side / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.72, 0.6, 0.5, 0.4]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && (blob.size <= PHOTO_TARGET_BYTES || (quality === 0.4 && side <= 640))) return toBase64(blob);
    }
    side = Math.round(side * 0.75);
  }
};

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Sends what is waiting; whatever the shop PC has is taken off this device. */
export const flushPhotos = async (): Promise<void> => {
  const token = syncToken();
  if (!token) return;
  if (timer) { clearTimeout(timer); timer = null; }
  for (const [id, data] of Object.entries(readQueue())) {
    try {
      const r = await fetch(`${location.origin}/api/v1/photos`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id, data }),
      });
      // 400: the PC will never take it; keeping it would block nothing but fill the phone.
      if (r.ok || r.status === 400) { const q = readQueue(); delete q[id]; writeQueue(q); }
    } catch { /* offline: try again later */ }
  }
  if (Object.keys(readQueue()).length) timer = setTimeout(() => void flushPhotos(), RETRY_MS);
  listeners.forEach((l) => l());
};

/** Keeps a photo on this device and starts sending it. */
export const keepPhoto = (id: string, base64: string): void => {
  writeQueue({ ...readQueue(), [id]: base64 });
  listeners.forEach((l) => l());
  void flushPhotos();
};

export const waitingPhotos = (): number => Object.keys(readQueue()).length;
const subscribePhotos = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** How many photos wait on this device for the shop PC (shown, so nobody wonders where they went). */
export const useWaitingPhotos = (): number => useSyncExternalStore(subscribePhotos, waitingPhotos);

/** Sends photos left over from before, and again whenever the Wi-Fi comes back. */
export const startPhotoSync = (): void => {
  window.addEventListener('online', () => void flushPhotos());
  void flushPhotos();
};

/** A photo to show: from this device while it waits, else from the shop PC. null while loading or missing. */
export function usePhotoUrl(id: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!id) return;
    const local = readQueue()[id];
    if (local) { setUrl(`data:image/jpeg;base64,${local}`); return; }
    const token = syncToken();
    if (!token) return;
    let gone = false;
    let made: string | null = null;
    fetch(`${location.origin}/api/v1/photos/${id}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b && !gone) { made = URL.createObjectURL(b); setUrl(made); } })
      .catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return url;
}
