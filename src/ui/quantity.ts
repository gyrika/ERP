export { formatQuantity } from '../domain/quantity.ts';

/** "1.5 packs", "1 pack": rounded to one decimal for reading. */
export const formatPacks = (packs: number): string => {
  const n = Math.round(packs * 10) / 10;
  return `${n} ${n === 1 ? 'pack' : 'packs'}`;
};

/** "Lasts about 4 days", from the last week's sales; null when there is nothing to say. */
export const formatLasts = (days: number | null): string | null => {
  if (days === null) return null;
  if (days < 1) return 'Lasts less than a day';
  const n = Math.round(days);
  return `Lasts about ${n} ${n === 1 ? 'day' : 'days'}`;
};
