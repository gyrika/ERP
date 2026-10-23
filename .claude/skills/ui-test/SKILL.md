---
name: ui-test
description: Write or fix frontend tests (Vitest + Testing Library, jsdom) and optionally check a screen in the running app.
---
# UI test

- Tests: `src/ui/<screen>.ui.test.tsx` (vitest, jsdom, `vite.config.ts`). Domain tests are `*.test.ts` on `node --test`, not vitest.
- Run one file: `npx vitest run src/ui/<screen>.ui.test.tsx` (add `-t "<name>"` for one test). Full: `npm run test:ui`.
- Before writing, open ONE nearby test in the same file for the pattern: `render(<App />)`, `userEvent.setup()`, `localStorage.clear()` in `beforeEach`, `cleanup` in `afterEach`, scope with `within(screen.getByRole(...,{ name }))`.
- Query by role + accessible name (the app is keyboard-first and accessible); no test ids, no CSS selectors, no snapshots.
- Test what the user sees: Send to kitchen, Charge, Undo, kitchen bump, chimes. Fake data comes from `src/fake/data.ts`; don't add fixtures elsewhere.
- Keyboard paths matter (F2 kitchen, F3, F4 user, Ctrl+M manager): cover them with `user.keyboard`.

Visual check (only if asked or layout changed): `npm run dev`, open `http://localhost:5173/#<view>` with Playwright, one screenshot light + dark. Kitchen at `#kitchen`, owner `#owner`, receipt `#receipt`, menu `#menu`.

Stop: a test is flaky after 2 reruns → report the timing cause, don't add sleeps.
Report: tests added/fixed · result.
