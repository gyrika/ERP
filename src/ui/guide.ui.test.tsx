import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Root } from './Root.tsx';
import { guideBlocks } from './vision/Guide.tsx';

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/#vision/guide'); });
afterEach(cleanup);

test('the owner\'s camera guide opens from #vision/guide, built in (no internet), with a way back', async () => {
  render(<Root />);
  const page = await screen.findByRole('main', { name: 'How to set up the cameras' }, { timeout: 5000 });
  expect(page.querySelector('h1')?.textContent).toBe('Cameras for your tables: how to set up');
  expect([...page.querySelectorAll('h2')].map((h) => h.textContent)).toContain('5. The three timers');
  expect(page.textContent).toMatch(/A visit shorter than this needs no cleaning \(3 min\)/);
  expect(page.textContent).toMatch(/on the shop PC only/);
  expect(screen.getByRole('link', { name: 'Computer vision' }).getAttribute('href')).toBe('#vision');
});

test('the guide reader: headings, list items run together, paragraphs', () => {
  expect(guideBlocks('# T\n\nIntro\n\n## A\n- one\n- two\n\nEnd')).toEqual([
    { kind: 'h1', text: 'T' }, { kind: 'p', text: 'Intro' }, { kind: 'h2', text: 'A' }, { kind: 'ul', items: ['one', 'two'] }, { kind: 'p', text: 'End' },
  ]);
});
