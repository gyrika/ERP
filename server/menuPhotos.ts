import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { MENU_PHOTO_ID } from '../src/domain/menuPhotos.ts';

/**
 * Menu photos on the shop PC (src/domain/menuPhotos.ts), one file per photo, named by its SHA-256:
 * the same picture is kept once, a photo is never changed in place, and an old one stays for Undo.
 * Menu photos are the shop's public face, not its records: they hold no tenant's data.
 * (Shelf photos, proof for a count, are another thing: server/photos.ts.)
 */
export interface MenuPhotoStore {
  /** Keeps a checked WebP; returns its id. */
  put(bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Buffer | null>;
}

export const menuPhotoId = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function fileMenuPhotos(dir: string): MenuPhotoStore {
  const path = (id: string) => `${dir}/${id}.webp`;
  return {
    async put(bytes) {
      const id = menuPhotoId(bytes);
      await mkdir(dir, { recursive: true });
      // Written whole, then renamed: a power cut never leaves half a photo under its id.
      const tmp = `${path(id)}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path(id));
      return id;
    },
    async get(id) {
      if (!MENU_PHOTO_ID.test(id)) return null;
      try { return await readFile(path(id)); } catch { return null; }
    },
  };
}

export function memoryMenuPhotos(): MenuPhotoStore {
  const kept = new Map<string, Buffer>();
  return {
    async put(bytes) { const id = menuPhotoId(bytes); kept.set(id, Buffer.from(bytes)); return id; },
    async get(id) { return kept.get(id) ?? null; },
  };
}
