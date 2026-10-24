/**
 * How well the language model opens pages by voice (SCRUM-145): 24 requests, said the way staff
 * say them, against the POS's real page list. Run it before changing the model, the prompt or the
 * page labels, and keep the change only if the score does not drop (a wrong page is worse than none).
 *
 *   npx wrangler dev --port 8790          (in cloud/, with a test device in the local database)
 *   npm run ai-eval -- <device token> [cloud address]
 */
import { matchPage, voicePages } from '../src/domain/voicePages.ts';

const [token, base = 'http://127.0.0.1:8790'] = process.argv.slice(2);
if (!token) { console.error('usage: npm run ai-eval -- <device token> [cloud address]'); process.exit(1); }

const CASES: [string, string | null][] = [
  ['open stock', 'items'], ['how much did we sell today', 'owner'], ['show me the cheese', 'items'],
  ['change the price of margherita', 'menu'], ['any new orders from the website', null], ['I want to order flour from the supplier', 'order'],
  ['what is the food cost of a burger', 'recipes'], ['show the kitchen', 'kitchen'], ['give a refund', null], ['check for updates', 'setup'],
  ['how many pizzas did we make', 'owner'], ['is the mozzarella running low', 'items'], ['open the till', 'register'], ['what time is it', null],
  ['a delivery just came', 'receive'], ['we need more dough made', 'semi'], ['add a new cashier', 'setup'], ['mark the seafood pizza sold out', 'menu'],
  ['how much is left of the bbq sauce', 'items'], ['the supplier phone number', 'suppliers'], ['take an order', 'register'], ['what should I buy today', 'order'],
  ['count the cheese', 'count'], ["show me today's money", 'owner'],
];

const pages = voicePages({ seesOwner: true, managesStock: true, owner: true, setup: true });
let right = 0, wrongPage = 0;
for (const [text, want] of CASES) {
  let got = matchPage(text, pages)?.id ?? null;
  const how = got ? 'words' : 'model';
  if (!got) {
    const r = await fetch(`${base}/api/v1/ai/command`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, commands: pages.map(({ id, label }) => ({ id, label })) }),
    });
    const d = (await r.json()) as { id?: string | null; message?: string };
    if (!r.ok) { console.error(`${r.status}: ${d.message}`); process.exit(1); }
    got = d.id ?? null;
  }
  if (got === want) right++; else if (got !== null) wrongPage++;
  console.log(`${got === want ? '✓' : '✗'} ${how.padEnd(5)} "${text}" → ${got}${got === want ? '' : `   (want ${want})`}`);
}
console.log(`\n${right}/${CASES.length} right, ${wrongPage} wrong page${wrongPage === 1 ? '' : 's'}`);
