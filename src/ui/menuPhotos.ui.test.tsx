import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setMenuState } from '../domain/menu.ts';
import { EMPTY_MENU_STATE } from '../domain/menuEdits.ts';
import { photoTools } from '../services/menuPhotos.ts';
import { readAll } from './eventLog.ts';
import { Root } from './Root.tsx';

// jsdom draws nothing: "made small" is the picture as it came, marked WebP.
const shrink = photoTools.shrink;
beforeEach(() => {
  localStorage.clear(); history.replaceState(null, '', '/'); setMenuState(EMPTY_MENU_STATE);
  photoTools.shrink = async (b: Blob) => new Blob([await b.arrayBuffer()], { type: 'image/webp' });
});
afterEach(() => { cleanup(); setMenuState(EMPTY_MENU_STATE); photoTools.shrink = shrink; });

const picture = (bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], 'pizza.jpg', { type: 'image/jpeg' });
const photoEvents = () => readAll().filter((e) => e.type === 'menu.photo_set');
const strips = () => document.querySelectorAll('.card__photo');
const pictures = () => document.querySelectorAll('.card__photo img');

test('a dish never given a photo shows the cheesybeez.com photo; his own photo replaces it; Remove hides it; Undo', async () => {
  const user = userEvent.setup();
  render(<Root />);
  expect(pictures().length).toBeGreaterThan(1); // from the first day, before any photo is chosen

  location.hash = '#menu';
  await user.click(await screen.findByRole('button', { name: 'Change Margherita' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Change Margherita' }));
  expect(sheet.getByRole('img', { name: 'Photo of Margherita' })).toBeTruthy(); // the cheesybeez.com one
  await user.upload(sheet.getByLabelText('Photo file'), picture());
  await waitFor(() => expect(sheet.getByRole('status').textContent).toContain('Photo changed.'));
  const [set] = photoEvents();
  expect(set).toMatchObject({ itemId: 'margherita', photo: expect.stringMatching(/^[a-f0-9]{64}$/) });

  // Remove, then Undo puts it back.
  await user.click(sheet.getByRole('button', { name: 'Remove photo' }));
  expect(photoEvents().at(-1)).toMatchObject({ itemId: 'margherita', photo: null });
  expect(sheet.getByText(/No photo/)).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Undo' }));
  expect(photoEvents().at(-1)).toMatchObject({ photo: set.photo });
  expect(sheet.getByRole('img', { name: 'Photo of Margherita' })).toBeTruthy();

  await user.keyboard('{Escape}'); // the sheet
  await user.keyboard('{Escape}'); // the Menu screen, back to the Register
  await screen.findAllByRole('button', { name: 'M 1,450' });
  expect(strips().length).toBeGreaterThan(1);
  expect(pictures().length).toBeGreaterThan(1);

  // A tap on the photo adds the first size.
  await user.click(document.querySelector('.card__photo:has(img)') as HTMLElement);
  expect(within(screen.getByRole('complementary', { name: 'Current order' })).getByText(/Margherita/)).toBeTruthy();
});

test('a picture pasted with Ctrl+V on the sheet becomes the photo; pasted text is left alone', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: 'Change Margherita' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Change Margherita' }));
  const paste = (files: File[]) => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files } });
    fireEvent(window, e);
    return e;
  };
  expect(paste([]).defaultPrevented).toBe(false); // text: left alone
  expect(photoEvents()).toHaveLength(0);
  expect(paste([picture([9, 9])]).defaultPrevented).toBe(true);
  await waitFor(() => expect(photoEvents()).toHaveLength(1));
  expect(sheet.getByRole('img', { name: 'Photo of Margherita' })).toBeTruthy();
});

test('a new dish gets its photo with it, only once it is added; Undo takes both back', async () => {
  const user = userEvent.setup();
  history.replaceState(null, '', '/#menu');
  render(<Root />);
  await user.click(await screen.findByRole('button', { name: '+ Add a pizza' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Add a pizza' }));
  await user.type(sheet.getByLabelText('English'), 'Test Pizza');
  await user.upload(sheet.getByLabelText('Photo file'), picture());
  expect(await sheet.findByRole('img', { name: 'Photo of Test Pizza' })).toBeTruthy();
  await user.click(sheet.getByRole('button', { name: 'Next' }));
  await user.click(sheet.getByRole('button', { name: 'Later' }));
  expect(photoEvents()).toHaveLength(0); // not until it is added
  await user.type(sheet.getByLabelText('Medium price'), '100');
  await user.type(sheet.getByLabelText('Large price'), '200');
  await user.click(sheet.getByRole('button', { name: 'Add to the menu' }));
  expect(photoEvents()).toMatchObject([{ itemId: 'new-test-pizza', photo: expect.stringMatching(/^[a-f0-9]{64}$/) }]);

  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(photoEvents().at(-1)).toMatchObject({ itemId: 'new-test-pizza', photo: '' });
});
