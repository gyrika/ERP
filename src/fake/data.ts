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

/**
 * A messy customer list, as an owner's spreadsheet really looks (CRM import tests; the .xlsx and
 * .csv test files are written from it). Every number is in the 07X 000 00XX block: obviously fake.
 * Row 1 is the header; the comment on each row says what the import must make of it.
 */
export const FAKE_CUSTOMER_SHEET: (string | number | null)[][] = [
  ['Name', 'Mobile'],
  ['Kasun Perera', '0770000001'], //            2 add
  ['Nimali Fernando', '770000002'], //          3 add (the 0 dropped)
  ['Chamara Silva', '+94 77 000 0003'], //      4 already on the list, same name: unchanged
  ['Dilani Jayasinghe', '94-77-000-0004'], //   5 on the list with no name: name filled in
  ['Ruwan Wickramasinghe', '0094770000005'], // 6 on the list as "Ruwan W": kept unless renaming
  ['Tharindu Bandara', 770000006], //           7 add (an Excel number cell)
  ['Sanduni Rathnayake', '077-000-0007'], //    8 add
  ['Ishara Gunawardena', '(077) 000 0008'], //  9 add
  ['නිමල් පෙරේරා', '0710000009'], //             10 add (Sinhala)
  ['කසුන් ප්‍රනාන්දු', '0720000010'], //          11 add (Sinhala, with a joiner inside the word)
  ['சுரேஷ் குமார்', '0750000011'], //            12 add (Tamil)
  ['பிரியா செல்வம்', '0760000012'], //            13 add (Tamil)
  ['Mohamed Rizwan', '0780000013'], //          14 add
  ['Fathima Nusra', '0740000014'], //           15 add
  ['', '0770000015'], //                        16 add, no name
  ['-', '0770000016'], //                       17 add, no name
  ['Kasun Perera', '+94770000001'], //          18 duplicate of row 2
  ['Nimali F.', '0770000002'], //               19 duplicate of row 3 (row 3's name stays)
  [null, null], //                              20 blank
  ['Amal Dias', '0112345678'], //               21 invalid: landline
  ['Saman Kumara', '0790000021'], //            22 invalid: no 079 mobiles
  ['Gayan Herath', '07700002'], //              23 invalid: too short
  ['Lahiru Mendis', '9.47712E+10'], //          24 invalid: Excel lost the digits
  ['Hiruni Peiris', 'call later'], //           25 invalid: not a number
  ['Pradeep Kumara', ''], //                    26 invalid: no number
  ['', ''], //                                  27 blank
  ['Dinesh Rajapaksha', '0770000027 / 0710000027'], // 28 add the first; the second noted
  ['  Malsha   de  Silva ', '0770000028'], //   29 add as "Malsha de Silva"
  ['Shehan Abeywardena', '0770000029'],
  ['Nadeesha Karunaratne', '0770000030'],
  ['Asanka Weerasinghe', '0770000031'],
  ['Chathurika Samarasinghe', '0770000032'],
  ['Roshan Ekanayake', '0770000033'],
  ['Thilini Dissanayake', '0770000034'],
  ['Janaka Senanayake', '0770000035'],
  ['Upeksha Wijesinghe', '0770000036'],
  ['Kavinda Liyanage', '0770000037'],
  ['Sachini Hettiarachchi', '0770000038'],
  ['Buddhika Amarasinghe', '0770000039'],
  ['Madushani Gamage', '0770000040'],
  ['Ranjith Pathirana', '0770000041'],
  ['Anusha Wijeratne', '0770000042'],
  ['Kumari Jayawardena', '0770000043'],
  ['කමල් සිල්වා', '0770000044'], //             45 add (Sinhala)
  ['லக்ஷ்மி ராஜா', '0770000045'], //            46 add (Tamil)
  ['Nuwan Pradeep', '0710000046'], //           47 add
];
