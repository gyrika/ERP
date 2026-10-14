/**
 * Photos for cheesybeez.com, by menu item id: src/order/photos/<item id>.webp (240 × 240, cards show
 * them at 96px). Imported, not in public/, so only the ordering site ships them, not the counter PC.
 *
 * For now these are stock photos from Unsplash (free licence, no attribution needed), chosen to
 * match each item's toppings; replace a file with the owner's own photo of the same name when it
 * arrives. Sources (https://unsplash.com/photos/<id>, ids as images.unsplash.com/photo-<id>):
 * margherita 1574071318508-1cdbab80d002 · cheese-onion 1620894599483-aefd71cb525f ·
 * veggie 1625401514458-6c8a5e7d55da · sausages 1609159085820-d9a6ff0f469e ·
 * devilled-chicken 1655673654158-9f7285b7d1ea · bbq-chicken 1655471264183-068c91041ba5 ·
 * bbq-sausages 1670757781705-9b6cb1ad0ca6 · bbq-mix 1705286324371-d6a6d9519dc2 ·
 * tonno-cipolla 1721001311219-5d2543d03aed · seafood 1670148815909-e79a18e16ddd ·
 * bacon-onion 1599588967784-e5449357dda3 · bbq-pork 1717883235373-ef10b2a745a3 ·
 * chicken-burger 1615297928064-24977384d0da · fish-burger 1627587780063-1655815c958b ·
 * egg-burger 1601894087104-0c18bc34dbd6 · crispy-chicken-burger 1637710847214-f91d99669e18 ·
 * bacon-egg-burger 1700835880369-467ebff9d324 · italian-pasta 1662197480393-2a82030b7b83 ·
 * hero (wood-fired oven) 1622880833523-7cf1c0bd4296: hero.webp 2400 × 800 for the banner, hero-sm.webp 800 × 600 for phones.
 * A new menu item without a file here shows the neutral placeholder.
 *
 * The two mood strips: photos/strips/<id>.webp (1920 × 720) and <id>-sm.webp (800 × 600), each under
 * 150 KB, cut from originals at least 1920px wide (never upscaled): pizza 1672856398893-2fb52d807874
 * (4176px) · end 1579751626657-72bc17010498 (2768px).
 */
const files = import.meta.glob<string>('./photos/*.webp', { eager: true, query: '?url', import: 'default' });
const byName = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.slice('./photos/'.length, -'.webp'.length), url]));

export const HERO = { large: byName.hero, small: byName['hero-sm'] };
export const PHOTOS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(byName).filter(([name]) => !name.startsWith('hero')),
);

const stripFiles = import.meta.glob<string>('./photos/strips/*.webp', { eager: true, query: '?url', import: 'default' });
const strip = (name: string) => stripFiles[`./photos/strips/${name}.webp`];
export type StripId = 'pizza' | 'end';
export const STRIPS = Object.fromEntries((['pizza', 'end'] as const).map((id) => [id, { large: strip(id), small: strip(`${id}-sm`) }])) as Record<StripId, { large: string; small: string }>;
