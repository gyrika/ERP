import type { SyncEvent } from './sync.ts';

/**
 * Every number the stock rules use, in one place, so the owner can change them
 * (`stock.settings_set`, owner only). Rules read them from here, never as their own
 * constants: counts, usage, order suggestions, receiving.
 */
export interface StockSettings {
  /** A count gap needs a reason above this share of what the system expected (0.1 = 10%)… */
  countGapShare: number;
  /** …or above this value, in cents. */
  countGapCents: number;
  /** Daily use = what sales took over these last days ÷ these days. */
  usageDays: number;
  /** A supplier's delivery time with no history yet, in days. */
  defaultLeadDays: number;
  /** Delivery time = the average of a supplier's last this-many first deliveries. */
  leadSamples: number;
  /** Order when what is in hand and on order lasts no longer than delivery time + these days. */
  spareDays: number;
  /** An order covers delivery time + these days. */
  orderDays: number;
  /** A GRN can be undone for this many hours. */
  grnUndoHours: number;
}

export const STOCK_DEFAULTS: Readonly<StockSettings> = {
  countGapShare: 0.1,
  countGapCents: 200_000, // Rs 2,000
  usageDays: 14,
  defaultLeadDays: 3,
  leadSamples: 5,
  spareDays: 2,
  orderDays: 7,
  grnUndoHours: 24,
};

/** What each setting may be: whole days and hours at least 1, the share between 0 and 1. */
const LIMITS: Record<keyof StockSettings, { min: number; max: number; whole: boolean }> = {
  countGapShare: { min: 0, max: 1, whole: false },
  countGapCents: { min: 0, max: 100_000_000, whole: true },
  usageDays: { min: 1, max: 90, whole: true },
  defaultLeadDays: { min: 1, max: 60, whole: true },
  leadSamples: { min: 1, max: 20, whole: true },
  spareDays: { min: 0, max: 60, whole: true },
  orderDays: { min: 1, max: 90, whole: true },
  grnUndoHours: { min: 1, max: 24 * 14, whole: true },
};

export const isStockSetting = (key: unknown): key is keyof StockSettings =>
  typeof key === 'string' && Object.hasOwn(LIMITS, key);

/** null when the value is allowed for that setting, else what is wrong, in plain words. */
export const checkStockSetting = (key: unknown, value: unknown): string | null => {
  if (!isStockSetting(key)) return 'There is no such setting.';
  const l = LIMITS[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Type a number.';
  if (l.whole && !Number.isInteger(value)) return 'Type a whole number.';
  if (value < l.min || value > l.max) return `Type a number from ${l.min} to ${l.max}.`;
  return null;
};

/** The defaults, with the owner's changes on top (the last one wins; bad values are ignored). */
export const stockSettingsFromEvents = (events: readonly SyncEvent[]): StockSettings => {
  const s: StockSettings = { ...STOCK_DEFAULTS };
  for (const e of events) {
    if (e.type === 'stock.settings_set' && checkStockSetting(e.key, e.value) === null) s[e.key] = e.value;
  }
  return s;
};
