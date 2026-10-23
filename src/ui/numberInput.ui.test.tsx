import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { NumberInput, numberText } from './NumberInput.tsx';

afterEach(cleanup);

test('numberText keeps digits and one point, never letters (SCRUM-137)', () => {
  expect(numberText('two', 3)).toBe('');
  expect(numberText('2 packs', 3)).toBe('2');
  expect(numberText('Rs 1,250.50', 2)).toBe('1250.50');
  expect(numberText('1.2.3', 3)).toBe('1.23');
  expect(numberText('1.23456', 3)).toBe('1.234');
  expect(numberText('1.5', 0)).toBe('1');
  expect(numberText('-5', 3)).toBe('5');
});

function Box() {
  const [v, setV] = useState('');
  return <label>Packs<NumberInput value={v} onText={setV} unit="packs" /></label>;
}

test('the number box ignores letters typed or pasted and shows what it counts', async () => {
  const user = userEvent.setup();
  render(<Box />);
  const box = screen.getByRole('textbox', { name: /Packs/ }) as HTMLInputElement;
  await user.type(box, 'abc');
  expect(box.value).toBe('');
  await user.click(box);
  await user.paste('3 packs');
  expect(box.value).toBe('3');
  expect(box.getAttribute('inputmode')).toBe('decimal');
  expect(screen.getByText('packs')).toBeTruthy();
});
