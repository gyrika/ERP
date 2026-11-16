import { useLayoutEffect, useRef } from 'react';

/**
 * The bill flies to the list (SCRUM-246): when an order leaves the right panel (Send, New order,
 * Next order, or another order opened) and stays on the left list, a copy of its black number
 * badge flies from the panel to its row there, and the row glows once as it lands. The cashier's
 * eye follows the order to where it now waits, so nothing seems to vanish. Only the first time a
 * bill leaves the panel (SCRUM-250): only a new bill flies, never one opened from the list (already
 * on it when it came to the panel, even if it never flew), so going from row to row is still.
 *
 * Marks: the panel's badge carries `data-fly-badge`, each list row `data-rail-order="<number>"`.
 * The copy is plain DOM over everything, never clickable, gone in under half a second; with
 * reduced motion only the row's glow shows.
 */

export const FLY_MS = 420;
const LAND_MS = 600;

interface Seen { number: number; rect: DOMRect; node: HTMLElement }

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const land = (row: HTMLElement) => {
  row.classList.remove('rail__row--landed');
  void row.offsetWidth; // restart the glow if it is still going
  row.classList.add('rail__row--landed');
  setTimeout(() => row.classList.remove('rail__row--landed'), LAND_MS);
};

const fly = (from: Seen, row: HTMLElement) => {
  const target = (row.querySelector<HTMLElement>('.history__no') ?? row).getBoundingClientRect();
  if (reduced() || typeof from.node.animate !== 'function' || !target.width) { land(row); return; }
  const ghost = from.node;
  ghost.removeAttribute('data-fly-badge');
  ghost.classList.add('obadge--flying');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    position: 'fixed', left: `${from.rect.left}px`, top: `${from.rect.top}px`,
    width: `${from.rect.width}px`, height: `${from.rect.height}px`, margin: '0', zIndex: '50', pointerEvents: 'none', transformOrigin: '0 0',
  });
  document.body.appendChild(ghost);
  const scale = Math.max(0.4, Math.min(1, target.height / from.rect.height));
  const dx = target.left - from.rect.left;
  const dy = target.top + (target.height - from.rect.height * scale) / 2 - from.rect.top;
  // A slight lift on the way, so it reads as one object travelling, not a slide.
  const a = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
    { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 24}px) scale(${(1 + scale) / 2})`, opacity: 1, offset: 0.55 },
    { transform: `translate(${dx * 0.95}px, ${dy * 0.95}px) scale(${scale})`, opacity: 1, offset: 0.88 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0, offset: 1 }, // solid until it lands, then becomes the row
  ], { duration: FLY_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  const done = () => { ghost.remove(); land(row); };
  a.onfinish = done;
  a.oncancel = done;
};

/**
 * `number`: the order on the right panel; `live`: it is a real bill (has items, or is paid), so
 * leaving the panel means it went to the list.
 */
export function useFlyToRail(number: number, live: boolean): void {
  const last = useRef<Seen | null>(null);
  const flown = useRef(new Set<number>());
  const listed = useRef(new Set<number>());
  useLayoutEffect(() => {
    const prev = last.current;
    // Already a row before it came to the panel: opened from the list, so it never flies.
    if (prev?.number !== number && listed.current.has(number)) flown.current.add(number);
    listed.current = new Set([...document.querySelectorAll<HTMLElement>('[data-rail-order]')].map((r) => Number(r.dataset.railOrder)));
    const badge = document.querySelector<HTMLElement>('[data-fly-badge]');
    last.current = live && badge ? { number, rect: badge.getBoundingClientRect(), node: badge.cloneNode(true) as HTMLElement } : null;
    if (!prev || prev.number === number || flown.current.has(prev.number)) return;
    flown.current.add(prev.number);
    const row = document.querySelector<HTMLElement>(`[data-rail-order="${prev.number}"]`);
    if (row) fly(prev, row);
  });
}
