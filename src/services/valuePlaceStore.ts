import type { Actor } from '../domain/auth.ts';
import { checkPlaceName, nextPlaceName, type PlaceInfo, type ValuePlace, type ValuePlaces } from '../domain/valuePlaces.ts';
import { newLineId } from '../domain/order.ts';
import { appendEvent } from '../ui/eventLog.ts';

const setPlace = (placeId: string, before: PlaceInfo | null, after: PlaceInfo | null, actor: Actor) =>
  appendEvent({ type: 'value.place_set', at: Date.now(), orderNumber: 0, actor, placeId, before, after });

/** A new place under its next free name; returns its id and Undo. */
export const addPlace = (v: ValuePlaces, actor: Actor): { id: string; name: string; undo: () => void } => {
  const id = `va-${newLineId()}`;
  const name = nextPlaceName(v);
  const after = { name, archived: false };
  setPlace(id, null, after, actor);
  return { id, name, undo: () => { setPlace(id, after, null, actor); } };
};

/** A new name, or the place removed; returns its Undo, or what is wrong. */
export const editPlace = (p: ValuePlace, change: Partial<PlaceInfo>, actor: Actor): (() => void) | string => {
  const before = { name: p.name, archived: p.archived };
  const after = { ...before, ...change, name: (change.name ?? p.name).trim() };
  const problem = checkPlaceName(after.name);
  if (problem) return problem;
  setPlace(p.id, before, after, actor);
  return () => { setPlace(p.id, after, before, actor); };
};

/** A card put in a place; returns its Undo. */
export const putInPlace = (v: ValuePlaces, nodeId: string, placeId: string, actor: Actor): (() => void) => {
  const was = v.of.get(nodeId) ?? null;
  const put = (to: string | null) => appendEvent({ type: 'value.card_set', at: Date.now(), orderNumber: 0, actor, nodeId, placeId: to });
  put(placeId);
  return () => { put(was); };
};
