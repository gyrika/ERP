import { beforeEach, describe, expect, it } from 'vitest';
import { cardPlaces, saveCardPlaces } from './cardPlaces.ts';

describe('Visual Flow card places', () => {
  beforeEach(() => localStorage.clear());

  it('keeps where the cards were dragged, per item, after a restart', () => {
    saveCardPlaces('recipe:margherita:L', { 'raw:cheese': { x: 10, y: 20 } });
    saveCardPlaces('recipe:burger', { 'raw:bun': { x: -5, y: 7 } });
    // A restart: only what storage holds is left.
    expect(cardPlaces('recipe:margherita:L')).toEqual({ 'raw:cheese': { x: 10, y: 20 } });
    expect(cardPlaces('recipe:burger')).toEqual({ 'raw:bun': { x: -5, y: 7 } });
    expect(cardPlaces('recipe:pasta')).toEqual({});
  });

  it('drops an item with no moved cards, and survives broken storage', () => {
    saveCardPlaces('recipe:burger', { 'raw:bun': { x: 1, y: 2 } });
    saveCardPlaces('recipe:burger', {});
    expect(localStorage.getItem('vf-cards')).toBe('{}');
    localStorage.setItem('vf-cards', 'not json');
    expect(cardPlaces('recipe:burger')).toEqual({});
  });
});
