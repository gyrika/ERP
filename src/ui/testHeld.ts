import { fireEvent, screen, within } from '@testing-library/react';

/** The Held bills list in the bill panel (opened if it is not), for tests that open another bill. */
export const heldList = () => {
  const btn = screen.getByRole('button', { name: /^Held bills/ });
  if (btn.getAttribute('aria-pressed') !== 'true') fireEvent.click(btn);
  return within(screen.getByRole('list', { name: 'Held bills' }));
};
