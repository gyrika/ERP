/**
 * ALL FAKE DATA LIVES HERE. Nothing in this file is real: not the people, not
 * the PINs, not the orders. It exists for development and the /?demo screen,
 * and goes away when real logins (sprint 3) and real data arrive.
 */
import type { Actor } from '../domain/auth.ts';
import type { SeenBox, TableSpec, TableState } from '../domain/tables.ts';
import type { Order } from '../domain/types.ts';

export const FAKE_SHOP_ID = 'shop-demo-cheesybeez';

/** Fake staff and their PINs. PINs are not secrets; they only open the fake auth service. */
export const FAKE_STAFF: { pin: string; actor: Actor }[] = [
  { pin: '2580', actor: { id: 'fake-manager-1', name: 'Ravi', role: 'manager' } },
  { pin: '1111', actor: { id: 'fake-cashier-1', name: 'Nimal', role: 'cashier' } },
  { pin: '9999', actor: { id: 'fake-owner-1', name: 'Owner', role: 'owner' } },
];

/** Demo orders for /?demo: three tables eating, nothing paid yet. */
export const fakeOrders = (now: number): Order[] => {
  const min = 60_000;
  return [
    {
      number: 1041, sentAt: now - 18 * min, lines: [
        { id: 'demo-1041-a', itemId: 'devilled-chicken', qty: 1, size: 'L', adds: ['full-cheese'], outs: ['no-onion'], sent: true },
        { id: 'demo-1041-b', itemId: 'margherita', qty: 2, size: 'M', adds: [], outs: [], sent: true },
        { id: 'demo-1041-c', itemId: 'chicken-burger', qty: 1, adds: ['cheese-slice'], outs: [], sent: true },
      ],
    },
    {
      number: 1042, sentAt: now - 9 * min, lines: [
        { id: 'demo-1042-a', itemId: 'seafood', qty: 1, size: 'L', adds: [], outs: [], sent: true },
        { id: 'demo-1042-b', itemId: 'crispy-chicken-burger', qty: 2, adds: [], outs: ['no-lettuce'], sent: true },
      ],
    },
    {
      number: 1043, sentAt: now - 3 * min, lines: [
        { id: 'demo-1043-a', itemId: 'italian-pasta', qty: 1, size: 'M', adds: [], outs: [], sent: true },
        { id: 'demo-1043-b', itemId: 'bbq-chicken', qty: 1, size: 'M', adds: ['half-cheese'], outs: [], sent: true },
      ],
    },
  ];
};

/**
 * What the ordering page's /api/v1/shop answers in `npm run dev` (vite.config.ts), so the page shows a
 * real-looking open shop instead of "Couldn't check". The hours are an example, NOT the shop's: the live
 * page shows hours only once the owner gives them (the cloud's ORDER_HOURS).
 */
export const FAKE_ORDER_SHOP = {
  name: 'CheesyBeez Thalwila',
  open: true,
  hours: { opens: 11 * 60, closes: 21 * 60 },
  phone: null,
  address: null,
};

/**
 * Demo floor for /?demo (SCRUM-168): six tables until the owner draws his own (SCRUM-171), and
 * what staff marked on a few of them, minutes ago. No cameras: the floor works by hand.
 */
export const FAKE_TABLES: TableSpec[] = [
  { id: 'demo-t1', label: '1', seats: 2 }, { id: 'demo-t2', label: '2', seats: 4 }, { id: 'demo-t3', label: '3', seats: 4 },
  { id: 'demo-t4', label: '4', seats: 6 }, { id: 'demo-t5', label: '5', seats: 2 }, { id: 'demo-t6', label: '6', seats: 4 },
];
export const FAKE_TABLE_STATES: { tableId: string; to: TableState; minutesAgo: number }[] = [
  { tableId: 'demo-t2', to: 'occupied', minutesAgo: 24 },
  { tableId: 'demo-t3', to: 'occupied', minutesAgo: 9 },
  { tableId: 'demo-t4', to: 'needs_cleaning', minutesAgo: 3 },
  { tableId: 'demo-t6', to: 'reserved', minutesAgo: 12 },
];

/**
 * /?demo#vision, the Front camera open large (SCRUM-175): what detection sees, drawn over the test
 * picture. Two people at table 2, one at table 3, one walking past (feet outside every zone).
 */
export const FAKE_DETECTIONS: Record<string, SeenBox[]> = {
  'demo-cam-front': [
    { x1: 0.38, y1: 0.2, x2: 0.48, y2: 0.85, score: 0.91 },
    { x1: 0.52, y1: 0.25, x2: 0.62, y2: 0.88, score: 0.84 },
    { x1: 0.74, y1: 0.22, x2: 0.86, y2: 0.9, score: 0.78 },
    { x1: 0.14, y1: 0.02, x2: 0.2, y2: 0.3, score: 0.52 },
  ],
};

/** /?demo#vision (SCRUM-174): the CV pack is there already, so Shadow and Live switch at once. */
export const FAKE_CV_STATUS = { active: true, phase: 'ready', version: 'demo' } as const;
