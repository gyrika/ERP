/**
 * Delivery apps the shop sells through (SCRUM-195): today Uber Eats (owner, 2026-10-29). Their
 * orders arrive on the app's own tablet; the cashier keys them in with the app's order code, the
 * kitchen sees whose rider is coming, and the app (not the customer) pays the shop later, less its
 * commission. Add PickMe Food here when the shop joins it: its key, tender and labels follow.
 */
export type PlatformId = 'uber';

export interface Platform { id: PlatformId; name: string }
export const PLATFORMS: readonly Platform[] = [{ id: 'uber', name: 'Uber Eats' }];

/** The app's mark on an order, its kitchen ticket and its send event: whose order, and its code there. */
export interface PlatformMark { id: PlatformId; code: string }

export const isPlatformId = (v: unknown): v is PlatformId => PLATFORMS.some((p) => p.id === v);
export const platformName = (id: PlatformId): string => PLATFORMS.find((p) => p.id === id)?.name ?? id;

/** "Uber Eats · 4F2A9" */
export const platformLabel = (m: PlatformMark): string => `${platformName(m.id)} · ${m.code}`;

/**
 * The app's order code as the cashier typed it: trimmed, upper case, letters, digits and "-" only,
 * 2 to 20 long (Uber's are short, like "4F2A9"), or null.
 */
export const cleanCode = (raw: string): string | null => {
  const c = raw.trim().replace(/^#/, '').toUpperCase();
  return /^[A-Z0-9-]{2,20}$/.test(c) ? c : null;
};

/** A mark as it travels in events: checked by the shop server before it is kept. */
export const isPlatformMark = (v: unknown): v is PlatformMark => {
  const m = v as Record<string, unknown> | null;
  return typeof m === 'object' && m !== null && isPlatformId(m.id) && typeof m.code === 'string' && cleanCode(m.code) === m.code;
};
