import type { Category, CustomSizeId } from './types.ts';

/**
 * Menu sections (SCRUM-241). The printed menu has three: Pizza, Burgers, Pasta. The owner adds his
 * own (kottu, rice, drinks...), each with one price or up to three sizes he names, and a cook time
 * for the kitchen's amber and red. He can rename and reorder every section, and hide his own.
 *
 * Each change is one `menu.section_set` event (whole setting for one section, before/after, so it
 * is audited and undone like an item change); the order is one `menu.sections_ordered` event.
 */

/** His own sections' ids, so they never meet a printed one. */
export const SECTION_ID = /^sec-[a-z0-9-]{1,40}$/;
export const isCustomSection = (id: string): id is `sec-${string}` => SECTION_ID.test(id);

/** The sizes one of his sections can have, in order. A section with none has one price. */
export const CUSTOM_SIZE_IDS = ['x1', 'x2', 'x3'] as const satisfies readonly CustomSizeId[];
export const isCustomSize = (id: string): id is CustomSizeId => (CUSTOM_SIZE_IDS as readonly string[]).includes(id);

/** Cook times from the owner (2026-10-12): pizza 10 min, burger 3 min, pasta 20 min. */
export const PRINTED_COOK_MINUTES = { pizza: 10, burger: 3, pasta: 20 } as const;
/** A new section's cook time until he says otherwise. */
export const NEW_SECTION_MINUTES = 10;

export const PRINTED_SECTIONS: readonly { id: 'pizza' | 'burger' | 'pasta'; label: string; one: string }[] = [
  { id: 'pizza', label: 'Pizza', one: 'Pizza' },
  { id: 'burger', label: 'Burgers', one: 'Burger' },
  { id: 'pasta', label: 'Pasta', one: 'Pasta' },
];

/**
 * One section's setting. For a printed section it is only what he changed (a name, a cook time);
 * for his own it is the whole section (a name is required). Sizes and hidden are his own sections'.
 */
export interface SectionSetting {
  name?: { en?: string; si?: string; ta?: string };
  cookMinutes?: number;
  /** His own sections: the sizes, in order (ids x1..x3). Absent = one price. */
  sizes?: { id: CustomSizeId; label: string }[];
  /** His own sections: off the counter and cheesybeez.com, items kept for old orders. */
  hidden?: boolean;
}

/** A section as every screen shows it. */
export interface Section {
  id: Category;
  name: { en: string; si?: string; ta?: string };
  /** The tab's word: "Burgers". */
  label: string;
  /** One of its dishes: "Burger" (his own sections: the name). */
  one: string;
  /** His own sections' sizes; null for a printed section (its dishes are shaped like the printed ones). */
  sizes: { id: CustomSizeId; label: string }[] | null;
  cookMinutes: number;
  printed: boolean;
  hidden: boolean;
}

export interface SectionsState {
  sections?: Record<string, SectionSetting>;
  sectionOrder?: string[];
}

const clean = (s: string | undefined) => s?.trim() || undefined;

/** The sections in the order he set (printed first, then his own as he made them, for any he did not place). */
export const sectionsOf = (state: SectionsState): Section[] => {
  const settings = state.sections ?? {};
  const all: Section[] = [
    ...PRINTED_SECTIONS.map((p): Section => {
      const s = settings[p.id];
      const en = clean(s?.name?.en);
      return {
        id: p.id,
        name: { en: en ?? p.label, ...(clean(s?.name?.si) ? { si: clean(s?.name?.si) } : {}), ...(clean(s?.name?.ta) ? { ta: clean(s?.name?.ta) } : {}) },
        label: en ?? p.label, one: en ?? p.one, sizes: null,
        cookMinutes: s?.cookMinutes ?? PRINTED_COOK_MINUTES[p.id], printed: true, hidden: false,
      };
    }),
    ...Object.entries(settings).filter(([id]) => isCustomSection(id)).map(([id, s]): Section => {
      const en = clean(s.name?.en) ?? id.slice(4);
      return {
        id: id as Category,
        name: { en, ...(clean(s.name?.si) ? { si: clean(s.name?.si) } : {}), ...(clean(s.name?.ta) ? { ta: clean(s.name?.ta) } : {}) },
        label: en, one: en, sizes: s.sizes?.length ? s.sizes : null,
        cookMinutes: s.cookMinutes ?? NEW_SECTION_MINUTES, printed: false, hidden: Boolean(s.hidden),
      };
    }),
  ];
  const place = new Map((state.sectionOrder ?? []).map((id, i) => [id, i]));
  return all
    .map((s, i) => ({ s, at: place.get(s.id) ?? place.size + i }))
    .sort((a, b) => a.at - b.at)
    .map(({ s }) => s);
};

/** "Kottu" → "sec-kottu", or "sec-kottu-2" if that was ever used. */
export const newSectionId = (en: string, taken: Iterable<string>): `sec-${string}` => {
  const slug = en.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34) || 'section';
  const used = new Set(taken);
  let id = `sec-${slug}`;
  for (let n = 2; used.has(id); n++) id = `sec-${slug}-${n}`;
  return id as `sec-${string}`;
};

const isText = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);

/** Is this a setting the shop can take for this section? `before` is what it was (null: new). */
export const checkSection = (id: string, s: SectionSetting, before: SectionSetting | null = null): string | null => {
  const printed = PRINTED_SECTIONS.some((p) => p.id === id);
  if (!printed && !isCustomSection(id)) return 'that is not a menu section';
  if (typeof s !== 'object' || s === null) return 'that is not a section';
  if (Object.keys(s).some((k) => !['name', 'cookMinutes', 'sizes', 'hidden'].includes(k))) return 'that is not a section';
  if (s.name !== undefined) {
    if (typeof s.name !== 'object' || s.name === null || Object.keys(s.name).some((k) => !['en', 'si', 'ta'].includes(k))) return 'that is not a name';
    if (!isText(s.name.en, 30) || !isText(s.name.si, 40) || !isText(s.name.ta, 40)) return 'a section name is too long';
  }
  if (!printed && !clean(s.name?.en)) return 'the section needs an English name';
  if (s.cookMinutes !== undefined && (!Number.isInteger(s.cookMinutes) || s.cookMinutes < 1 || s.cookMinutes > 120)) {
    return 'the cook time is whole minutes, 1 to 120';
  }
  if (printed && (s.sizes !== undefined || s.hidden !== undefined)) return 'Pizza, Burgers and Pasta keep their sizes and stay on the menu';
  if (s.hidden !== undefined && typeof s.hidden !== 'boolean') return 'that is not a section';
  if (s.sizes !== undefined) {
    if (!Array.isArray(s.sizes) || s.sizes.length < 2 || s.sizes.length > CUSTOM_SIZE_IDS.length) return 'a section has one price, or 2 or 3 sizes';
    if (s.sizes.some((z, i) => typeof z !== 'object' || z === null || z.id !== CUSTOM_SIZE_IDS[i] || Object.keys(z).some((k) => k !== 'id' && k !== 'label'))) return 'that is not a size';
    if (s.sizes.some((z) => typeof z.label !== 'string' || !z.label.trim() || z.label.length > 12)) return 'each size needs a short name (up to 12 letters)';
    if (new Set(s.sizes.map((z) => z.label.trim().toLowerCase())).size !== s.sizes.length) return 'two sizes have the same name';
  }
  // Its dishes are priced per size, so the sizes stay as they were made; only their names change.
  if (before && (before.sizes?.length ?? 0) !== (s.sizes?.length ?? 0)) return 'a section keeps the sizes it was made with';
  return null;
};

/** Is this an order of sections the shop can take? Every id once, each a section's. */
export const checkSectionOrder = (ids: unknown): string | null => {
  if (!Array.isArray(ids) || ids.length > 60) return 'that is not an order of sections';
  if (ids.some((id) => typeof id !== 'string' || !(PRINTED_SECTIONS.some((p) => p.id === id) || isCustomSection(id)))) return 'that is not a menu section';
  if (new Set(ids).size !== ids.length) return 'a section is in the order twice';
  return null;
};

/** The order after moving one section a step earlier (-1) or later (+1). */
export const moveSection = (order: readonly string[], id: string, step: -1 | 1): string[] => {
  const next = [...order];
  const i = next.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** A size as a price button shows it: "M" for the printed sizes, his own size's name ("Full"). */
export const sizeShort = (v: { id: string; label: string }): string => (isCustomSize(v.id) ? v.label : v.id);
