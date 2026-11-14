import { menuItems, menuState } from '../domain/menu.ts';
import { MENU_PHOTO_HEIGHT, MENU_PHOTO_WIDTH, photoChoice } from '../domain/menuPhotos.ts';
import { storageKey } from '../ui/storage.ts';
import { syncToken } from './pairing.ts';

/**
 * Menu photos in the browser (src/domain/menuPhotos.ts). With the shop server, a photo is sent to it
 * and shown from it; without one (the demo, development) it is kept in this browser.
 */

/** Photos kept here: the demo's own, and new ones until the server's copy is loaded. */
const local = new Map<string, string>();
const LOCAL_KEY = () => storageKey('menuPhotos.v1');
try {
  const saved = JSON.parse(localStorage.getItem(LOCAL_KEY()) ?? '{}') as Record<string, string>;
  for (const [id, url] of Object.entries(saved)) if (typeof url === 'string' && url.startsWith('data:image/')) local.set(id, url);
} catch { /* blocked or broken: start without */ }

const keepLocally = (id: string, dataUrl: string, save: boolean) => {
  local.set(id, dataUrl);
  if (!save) return;
  try { localStorage.setItem(LOCAL_KEY(), JSON.stringify(Object.fromEntries(local))); } catch { /* full: this session still has it */ }
};

/** Where a kept photo is shown from. */
export const photoSrc = (id: string): string => local.get(id) ?? `/api/v1/menu-photos/${id}.webp`;

/** The picture an item shows, or null for none. */
export const photoUrl = (itemId: string): string | null => {
  const choice = photoChoice(menuState(), itemId);
  return choice ? photoSrc(choice) : null;
};

/** Register tiles get a photo strip once the shop has any photo; until then the tiles stay as they were. */
export const shopHasPhotos = (): boolean => menuItems().some((m) => !m.hidden && photoUrl(m.id) !== null);

export class PhotoError extends Error {}

/** A picture made 480 × 360 (its middle, filling the frame) as a WebP, so it travels light. */
async function shrink(picture: Blob): Promise<Blob> {
  let img: ImageBitmap;
  try { img = await createImageBitmap(picture); } catch { throw new PhotoError('That is not a picture this computer can open. Try a JPG or PNG.'); }
  const scale = Math.max(MENU_PHOTO_WIDTH / img.width, MENU_PHOTO_HEIGHT / img.height);
  const w = MENU_PHOTO_WIDTH / scale, h = MENU_PHOTO_HEIGHT / scale;
  const canvas = document.createElement('canvas');
  canvas.width = MENU_PHOTO_WIDTH; canvas.height = MENU_PHOTO_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) { img.close(); throw new PhotoError('This browser cannot make photos small.'); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.width - w) / 2, (img.height - h) / 2, w, h, 0, 0, MENU_PHOTO_WIDTH, MENU_PHOTO_HEIGHT);
  img.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  if (!blob || blob.type !== 'image/webp') throw new PhotoError('This browser cannot make photos small.');
  return blob;
}

/** Swapped in tests (jsdom draws nothing). */
export const photoTools = { shrink };

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

const toDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new PhotoError('The picture could not be read.'));
  r.readAsDataURL(blob);
});

/**
 * Keeps a picture the owner chose or pasted, made small; returns its photo id for `menu.photo_set`.
 * Throws a PhotoError in words for the owner.
 */
export async function keepPhoto(picture: Blob): Promise<string> {
  const small = await photoTools.shrink(picture);
  const dataUrl = await toDataUrl(small);
  const token = syncToken();
  if (!token) {
    // No shop server: an id of our own (its SHA-256 where the browser can, like the server's).
    const bytes = new Uint8Array(await small.arrayBuffer());
    const id = crypto.subtle ? hex(await crypto.subtle.digest('SHA-256', bytes)) : hex(crypto.getRandomValues(new Uint8Array(32)));
    keepLocally(id, dataUrl, true);
    return id;
  }
  let r: Response;
  try {
    r = await fetch('/api/v1/menu-photos', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: dataUrl.slice(dataUrl.indexOf(',') + 1) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PhotoError('The shop PC is not answering, so the photo was not saved. Try again in a moment.');
  }
  if (!r.ok) throw new PhotoError('The shop PC did not take the photo. Try another picture.');
  const { id } = (await r.json()) as { id: string };
  keepLocally(id, dataUrl, false); // shows at once; the server's copy from then on
  return id;
}
