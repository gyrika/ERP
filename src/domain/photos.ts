/**
 * Shelf photos (SCRUM-94). A count with a big gap carries the id of its photo; the
 * photo itself travels separately (it is far bigger than an event) to the shop PC.
 */
export const isPhotoId = (id: unknown): id is string => typeof id === 'string' && /^ph-[A-Za-z0-9_-]{8,40}$/.test(id);

/** What a phone photo is shrunk to before it leaves the phone. */
export const PHOTO_TARGET_BYTES = 150_000;
export const PHOTO_MAX_SIDE = 1280;
