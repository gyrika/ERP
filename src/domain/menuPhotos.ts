import type { MenuState } from './menuEdits.ts';

/**
 * Menu photos (not shelf photos: those are photos.ts). The owner gives an item a photo from a file
 * or a pasted picture; the browser makes it small (MENU_PHOTO_WIDTH × MENU_PHOTO_HEIGHT WebP), the
 * shop server keeps it by its SHA-256 (its id), and a `menu.photo_set` event names it, so the change
 * is audited, has an Undo and reaches every screen. The picture itself never travels in the event
 * log: a menu's worth of photos would fill a browser's storage.
 */
export const MENU_PHOTO_WIDTH = 480;
export const MENU_PHOTO_HEIGHT = 360;
/** A 480 × 360 WebP is 20-40 KB; anything near this is not one of ours. */
export const MAX_MENU_PHOTO_BYTES = 300_000;
/** A menu photo's id: the SHA-256 of its bytes, in hex. */
export const MENU_PHOTO_ID = /^[a-f0-9]{64}$/;

/** What a `menu.photo_set` may carry: a photo id, null (no photo), or '' (back to never chosen). */
export const validPhotoChoice = (v: unknown): v is string | null => v === null || v === '' || (typeof v === 'string' && MENU_PHOTO_ID.test(v));

/** The shop's choice for an item: a photo id, null (none), or undefined (never chosen). */
export const photoChoice = (state: MenuState, itemId: string): string | null | undefined => {
  const photos = state.photos ?? {};
  return itemId in photos ? photos[itemId] : undefined;
};

/** What to send so Undo puts back `was`: '' when the item had never been given one. */
export const undoChoice = (was: string | null | undefined): string | null => (was === undefined ? '' : was);

/** A WebP file: "RIFF", its size, "WEBP". The server keeps nothing else. */
export const isWebp = (b: Uint8Array): boolean =>
  b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
