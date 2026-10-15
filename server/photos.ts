import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPhotoId } from '../src/domain/photos.ts';

/**
 * Shelf photos (SCRUM-94): proof for a big gap in a count, taken on the manager's
 * phone. Kept as plain JPEG files on the shop PC (C:\ProgramData\CheesyBeez\photos\<shop>\),
 * one per photo id, written once: the same id sent again changes nothing.
 */
export interface PhotoStore {
  save(tenantId: string, id: string, jpeg: Buffer): void;
  read(tenantId: string, id: string): Buffer | null;
}

/** Big enough for a phone photo shrunk to ~150 KB, with room to spare; small enough to refuse anything else. */
export const MAX_PHOTO_BYTES = 400_000;
/** Every JPEG starts with these bytes. */
export const isJpeg = (b: Buffer): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function photoFolder(dir: string): PhotoStore {
  const fileOf = (tenantId: string, id: string) => {
    // Both come from the server (device) and the checked id: never a path from outside.
    if (!/^[a-z0-9-]{1,64}$/.test(tenantId) || !isPhotoId(id)) throw new Error('bad photo path');
    return join(dir, tenantId, `${id}.jpg`);
  };
  return {
    save(tenantId, id, jpeg) {
      const file = fileOf(tenantId, id);
      if (existsSync(file)) return;
      mkdirSync(join(dir, tenantId), { recursive: true });
      writeFileSync(`${file}.part`, jpeg);
      renameSync(`${file}.part`, file); // never a half-written photo under its real name
    },
    read(tenantId, id) {
      try { return readFileSync(fileOf(tenantId, id)); } catch { return null; }
    },
  };
}
