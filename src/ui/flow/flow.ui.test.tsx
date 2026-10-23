import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BigStepper } from './BigStepper.tsx';
import { ChoiceCard, InfoCard } from './ChoiceCard.tsx';
import { DoneStep } from './DoneStep.tsx';
import { FlowSheet } from './FlowSheet.tsx';

afterEach(cleanup);

test('the sheet has a title, progress, one big button, a way back, and says which step this is', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn(); const onBack = vi.fn(); const next = vi.fn();
  render(<FlowSheet title="GRN" sub="PO-0001" step={{ index: 2, of: 4, label: 'Check each item' }} onBack={onBack} onClose={onClose} primary={{ label: 'All came', onClick: next }}>
    <p>content</p>
  </FlowSheet>);
  expect(screen.getByRole('dialog', { name: 'GRN' })).toBeTruthy();
  expect(screen.getByText('Step 2 of 4 · Check each item')).toBeTruthy();
  const bar = screen.getByRole('progressbar', { name: 'Progress' });
  expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['2', '4']);
  await user.click(screen.getByRole('button', { name: 'All came' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect([next.mock.calls.length, onBack.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 1, 1]);
});

test('keys: Enter does the big button, Esc goes back one step and then closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn(); const onBack = vi.fn(); const next = vi.fn();
  const { rerender } = render(<FlowSheet title="Orders" onBack={onBack} onClose={onClose} primary={{ label: 'Go', onClick: next }}><input aria-label="box" /></FlowSheet>);
  await user.keyboard('{Enter}');
  expect(next).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('textbox', { name: 'box' }));
  await user.keyboard('{Enter}'); // in a text box it means "next"
  expect(next).toHaveBeenCalledTimes(2);
  screen.getByRole('button', { name: 'Close' }).focus();
  await user.keyboard('{Enter}'); // on a button it presses that button, not the big one
  expect(next).toHaveBeenCalledTimes(2);
  expect(onClose).toHaveBeenCalledTimes(1);
  await user.keyboard('{Escape}');
  expect(onBack).toHaveBeenCalledTimes(1);

  (document.activeElement as HTMLElement).blur();
  rerender(<FlowSheet title="Orders" onClose={onClose} primary={{ label: 'Go', onClick: next, disabled: true }}>x</FlowSheet>);
  await user.keyboard('{Enter}');
  expect(next).toHaveBeenCalledTimes(2); // a disabled main button is not pressed
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(2); // nowhere to go back: it closes

  rerender(<FlowSheet title="Orders" onClose={onClose} keys={false} primary={{ label: 'Go', onClick: next }}>x</FlowSheet>);
  await user.keyboard('{Enter}{Escape}');
  expect([next.mock.calls.length, onClose.mock.calls.length]).toEqual([2, 2]); // keys are off while something sits on top
});

test('a screen that only informs has no foot; an error is read out', () => {
  render(<FlowSheet title="Done" onClose={() => {}} error="Pick one first.">x</FlowSheet>);
  expect(screen.getByRole('alert').textContent).toBe('Pick one first.');
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  expect(document.querySelector('.cta')).toBeNull();
});

test('the big stepper: − and + step, the number can be typed, orange when it differs', async () => {
  const user = userEvent.setup();
  const onText = vi.fn(); const onBump = vi.fn();
  const { container } = render(<BigStepper value="3" unit="packs" label="Packs of Pizza Flour" tone="warn" onText={onText} onBump={onBump}
    lessLabel="One less of Pizza Flour" moreLabel="One more of Pizza Flour" />);
  await user.click(screen.getByRole('button', { name: 'One more of Pizza Flour' }));
  await user.click(screen.getByRole('button', { name: 'One less of Pizza Flour' }));
  expect(onBump.mock.calls).toEqual([[1], [-1]]);
  await user.type(screen.getByRole('textbox', { name: 'Packs of Pizza Flour' }), '5');
  expect(onText).toHaveBeenLastCalledWith('5'); // the box selects its text on focus, so typing replaces it
  expect(screen.getByText('packs')).toBeTruthy();
  expect(container.querySelector('.bigstep--warn')).toBeTruthy();
});

test('cards: a choice can be picked, a summary line is not a button', async () => {
  const user = userEvent.setup();
  const pick = vi.fn();
  render(<>
    <ChoiceCard name="Prima" line="3 to order" badge={3} tone="warn" pressed={false} onClick={pick} />
    <ChoiceCard name="Wait for the rest" pressed onClick={pick} />
    <InfoCard name="Pizza Flour" line="Expected 3 · Received 2" tone="warn" aside="short −1" label="Pizza Flour: short" />
  </>);
  await user.click(screen.getByRole('button', { name: /Prima/ }));
  expect(pick).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Wait for the rest' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getAllByRole('button')).toHaveLength(2);
  expect(screen.getByRole('group', { name: 'Pizza Flour: short' }).textContent).toContain('short −1');
});

test('the finish says what happened and offers what to do next', () => {
  render(<DoneStep title="GRN-0001 saved" line="Stock is updated."><button type="button">Next delivery</button></DoneStep>);
  expect(screen.getByRole('status').textContent).toContain('GRN-0001 saved');
  expect(screen.getByRole('button', { name: 'Next delivery' })).toBeTruthy();
});
