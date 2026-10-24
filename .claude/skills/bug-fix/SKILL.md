---
name: bug-fix
description: Fix a bug in the CheesyBeez POS (domain, UI, server or cloud) with the smallest safe change and a test that proves it.
---
# Bug fix

1. Restate the bug in one line: which mind (cashier / kitchen / owner), what happens, what should.
2. Locate with `grep -rn` on the visible text, event type or function name. Read only the hits (use offset/limit on big files). Skip `node_modules`, `dist*`, `excel/`.
3. Find the root cause before editing. Domain logic lives in `src/domain` (pure), UI in `src/ui`, server in `server/`, cloud in `cloud/src`.
4. Write a failing test first, next to the code:
   - domain/server: `node --test --experimental-strip-types --no-warnings src/domain/<x>.test.ts`
   - UI: `npx vitest run src/ui/<x>.ui.test.tsx`
5. Minimal fix. Keep money in integer cents. Kitchen changes must be events. Don't touch `src/domain/menu.ts` prices.
6. Rerun the targeted test, then `npm test && npm run build`.

Rules: no unrelated refactors, no dependency changes, never weaken a test.
Stop: root cause still unclear after 3 attempts → report what you know and ask.
Report: cause · fix · files · test result (one line each).
