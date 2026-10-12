import { useEffect, useState } from 'react';
import { loadSeed } from '../domain/inventory.ts';
import type { InventoryItem, Supplier } from '../domain/inventoryData.ts';
import { SEED_INVENTORY, SEED_SUPPLIERS } from '../domain/inventoryData.ts';
import { storageKey } from '../ui/storage.ts';

/**
 * Inventory master data shared across tabs on one device. Items and suppliers
 * live in localStorage; BroadcastChannel tells other tabs to re-read. First
 * launch seeds from domain constants and never overwrites non-empty storage.
 */
const KEY_ITEMS = () => storageKey('inventory.v0');
const KEY_SUPPLIERS = () => storageKey('inventory.suppliers.v0');
const CHANNEL = storageKey('inventory');

const listeners = new Set<() => void>();
let outbound: BroadcastChannel | null = null;
const hasChannel = typeof BroadcastChannel !== 'undefined';

const readStored = <T>(key: string, isRow: (v: unknown) => v is T): T[] => {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRow);
  } catch {
    return [];
  }
};

/** Persisted row: seed fields plus on-hand stock in purchasing packs. */
export type InventoryRow = InventoryItem & { onHandPacks: number };

export const LOW_STOCK_PACKS = 1;

export const isLowStock = (row: InventoryRow): boolean => row.onHandPacks <= LOW_STOCK_PACKS;

const isItem = (v: unknown): v is InventoryItem =>
  typeof v === 'object' && v !== null && typeof (v as InventoryItem).id === 'string';

const normalizeRow = (raw: InventoryItem): InventoryRow => {
  const onHand = (raw as InventoryRow).onHandPacks;
  return {
    ...raw,
    onHandPacks: typeof onHand === 'number' && Number.isFinite(onHand) && onHand >= 0
      ? Math.floor(onHand)
      : 0,
  };
};

const isSupplier = (v: unknown): v is Supplier =>
  typeof v === 'object' && v !== null && typeof (v as Supplier).id === 'string';

const bootstrap = <T>(key: string, seed: T[], isRow: (v: unknown) => v is T): T[] => {
  const read = () => readStored(key, isRow);
  const next = loadSeed(key, seed, read);
  if (read().length === 0 && next.length > 0) {
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage full/blocked */ }
  }
  return next;
};

export const readItems = (): InventoryRow[] =>
  bootstrap(KEY_ITEMS(), SEED_INVENTORY, isItem).map(normalizeRow);

export const readSuppliers = (): Supplier[] => bootstrap(KEY_SUPPLIERS(), SEED_SUPPLIERS, isSupplier);

export const writeItems = (items: InventoryRow[]): void => {
  try { localStorage.setItem(KEY_ITEMS(), JSON.stringify(items)); } catch { /* storage full/blocked */ }
  listeners.forEach((l) => l());
  if (hasChannel) {
    outbound ??= new BroadcastChannel(CHANNEL);
    outbound.postMessage('changed');
  }
};

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  const channel = hasChannel ? new BroadcastChannel(CHANNEL) : null;
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY_ITEMS() || e.key === KEY_SUPPLIERS()) onChange();
  };
  if (channel) channel.onmessage = onChange;
  else window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    channel?.close();
    window.removeEventListener('storage', onStorage);
  };
};

export function useInventory(): { items: InventoryRow[]; suppliers: Supplier[] } {
  const [items, setItems] = useState(readItems);
  const [suppliers, setSuppliers] = useState(readSuppliers);
  useEffect(() => subscribe(() => {
    setItems(readItems());
    setSuppliers(readSuppliers());
  }), []);
  return { items, suppliers };
}
