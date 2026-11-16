import { screen, within } from '@testing-library/react';

/** The Held bills list in the order history on the left, for tests that open another bill. */
export const heldList = () => within(screen.getByRole('list', { name: 'Held bills' }));

/** "Held bills · N", the history's count. */
export const heldCount = (n: number) => screen.getByRole('heading', { name: `Held bills · ${n}` });
