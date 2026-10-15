import type { D1Like } from './cloud.ts';

/**
 * The owner's questions page (/questions?k=<key>): the missing recipe amounts, menu
 * and receipt details, answered on a phone with no account and no app. The key in the
 * link (a Worker secret, ANSWER_KEY) is the only way in. Every save is kept; the newest
 * is the answer. Claude reads them with `npm run answers` in cloud/.
 */
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const MAX_BODY = 64_000;

export async function answersApi(req: Request, db: D1Like, answerKey: string | undefined, now: () => number = Date.now): Promise<Response> {
  const key = req.headers.get('x-answer-key') ?? '';
  if (!answerKey || !sameText(key, answerKey)) return json(401, { error: 'unauthorized', message: 'this link is not right' });
  if (req.method === 'GET') {
    const row = await db.prepare('SELECT saved_at, body FROM owner_answers ORDER BY id DESC LIMIT 1').first<{ saved_at: number; body: string }>();
    return json(200, row ? { savedAt: row.saved_at, answers: JSON.parse(row.body) } : { savedAt: null, answers: {} });
  }
  if (req.method !== 'POST') return json(405, { error: 'server', message: 'method not allowed' });
  const text = await req.text();
  if (text.length > MAX_BODY) return json(400, { error: 'invalid_event', message: 'too long' });
  let answers: unknown;
  try { answers = (JSON.parse(text) as { answers?: unknown }).answers; } catch { return json(400, { error: 'invalid_event', message: 'not JSON' }); }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)
    || !Object.values(answers).every((v) => typeof v === 'string' && v.length <= 4000)) {
    return json(400, { error: 'invalid_event', message: 'answers must be text' });
  }
  const t = now();
  await db.prepare('INSERT INTO owner_answers (saved_at, body) VALUES (?, ?)').bind(t, JSON.stringify(answers)).run();
  return json(200, { savedAt: t });
}

/**
 * Questions, grouped by what they unlock in the POS. [id, question, kind]; a list of
 * options makes it a choice. Second round (2026-10-14): only what his own files leave open.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Kind = 'line' | 'text' | string[];
const SECTIONS: { title: string; why: string; questions: [string, string, Kind][] }[] = [
  {
    title: 'Two batches',
    why: 'These two answers show what 20 of your pizzas cost to make.',
    questions: [
      ['blendYield', 'Cheese blend: you mix 1 kg Prabhat + 1 kg Margarita. How many grams of blended cheese do you get?', 'line'],
      ['sauceYield', 'Pizza sauce: one batch is 2,550 g peeled tomato, 550 g tomato paste, 500 g water, herbs and salt. How many grams of finished sauce does it make?', 'line'],
    ],
  },
  {
    title: 'Which recipe is it?',
    why: 'These are on the counter screen, but the POS cannot tell which of your recipes they are.',
    questions: [
      ['pastaRecipe', 'Italian Pasta (Single / Medium / Large) is made as:', [
        'Chicken Alfredo, penne', 'Chicken Alfredo, spaghetti', 'Chicken Bolognese, penne', 'Chicken Bolognese, spaghetti',
        'The customer chooses Alfredo or Bolognese']],
      ['sausagesRecipe', 'Sausages pizza (M / L) is made with:', ['The Chicken Sausages recipe', 'The BBQ Sausages recipe', 'Its own recipe (write it below)']],
      ['sausagesOwn', 'Only if it has its own recipe: what goes on, and how much? (10" / 12")', 'text'],
      ['bbqPork', 'BBQ Pork pizza (M / L): your sheets have no recipe for it.', ['We sell it (recipe below)', "We don't sell it any more: hide it"]],
      ['bbqPorkRecipe', 'Only if you sell it: what goes on, and how much? (10" / 12")', 'text'],
    ],
  },
  {
    title: 'Buying prices',
    why: 'What you pay, and for how much. For example "Rs 1,200 for 1 kg". Your latest bill is fine.',
    questions: [
      ['basil', 'Basil (in the pizza sauce)', 'line'],
      ['friedChicken', 'Fried chicken cubes (the devilled / BBQ topping): what does 1 kg cost you, ready to use?', 'line'],
      ['chickenBreast', 'Raw chicken breast (Crispy Chicken Burger)', 'line'],
      ['cornFlour', 'Corn flour', 'line'],
      ['curd', 'Curd', 'line'],
      ['garlic', 'Fresh garlic', 'line'],
      ['ginger', 'Fresh ginger', 'line'],
      ['msg', 'MSG (if the breading uses a different MSG, give both)', 'line'],
      ['onionPowder', 'Onion powder', 'line'],
    ],
  },
  {
    title: 'Same thing, different name',
    why: 'Your recipes and your price list name these differently.',
    questions: [
      ['ketchup', 'Burger ketchup is the Kist 4 L ketchup?', ['Yes (count 1 ml as 1 g)', 'No, another one (write it in Notes)']],
      ['mayo', 'Burger mayonnaise is the 3.78 L bulk mayo?', ['Yes (count 1 ml as 1 g)', 'No, another one (write it in Notes)']],
      ['bacon', 'Pizza bacon is the Elephant House bacon ends, 500 g pack?', ['Yes', 'No, another one (write it in Notes)']],
      ['prawnsPerKg', 'Prawns: how many pieces in 1 kg? (your price list says about 35)', 'line'],
      ['sausagesPerPack', 'Pussallawa jumbo sausage: how many sausages in the 1 kg pack?', 'line'],
      ['tomatoSlices', 'Tomato: how many burger slices do you get from 1 kg?', 'line'],
    ],
  },
  {
    title: 'Ask your phone',
    why: 'Coming next: type "How was today?" on your phone and get a short answer from your own sales.',
    questions: [
      ['aiOk', 'To write those answers, your sales numbers (never customer names or phone numbers) are sent to Claude, an AI service by Anthropic. Is that OK?', ['Yes', 'No']],
      ['aiLanguage', 'Answers in:', ['English', 'Sinhala', 'Tamil']],
    ],
  },
  {
    title: 'Menu (if you like)',
    why: 'Leave empty if nothing to add.',
    questions: [
      ['moreMenu', 'Anything you sell that is not on the counter screen yet (fries, hot dogs, wings, drinks…)? Names, sizes and prices.', 'text'],
      ['names', 'Sinhala and Tamil names of the menu items, if you want them on screen', 'text'],
      ['notes', 'Anything else we should know', 'text'],
    ],
  },
];

const field = (id: string, q: string, kind: Kind): string => Array.isArray(kind)
  ? `<fieldset><legend>${esc(q)}</legend>${kind.map((o) => `<label class="opt"><input type="radio" name="${id}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</fieldset>`
  : `<label for="${id}">${esc(q)}${kind === 'text'
    ? `<textarea id="${id}" name="${id}"></textarea>` : `<input id="${id}" name="${id}" autocomplete="off">`}</label>`;

export const questionsPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>CheesyBeez questions</title>
<link rel="icon" type="image/png" href="/icons/favicon-32.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap">
<meta name="robots" content="noindex">
<style>
:root{--bg:#F2F1EF;--card:#FFF;--fg:#1C1C1E;--muted:#6E6D72;--line:#E3E1DE;--honey:#B9781F;--ok:#1E7A4F;--bad:#C8363B}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1C1C1E;--fg:#F5F5F7;--muted:#A1A1A6;--line:#3A3A3C;--honey:#E8A94B;--ok:#30A46C;--bad:#E5484D;color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "DM Sans",system-ui,sans-serif}
main{max-width:680px;margin:0 auto;padding:24px 16px calc(110px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:18px}
.brand{font-weight:600;font-size:15px}
h1{margin:0;font-size:28px;line-height:1.2;letter-spacing:-.5px;text-wrap:balance}
.lead{margin:0;color:var(--muted)}
.have{margin:0;padding:12px 16px;border-radius:14px;background:var(--card);border-left:5px solid var(--ok);font-size:15px}
section{background:var(--card);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:14px}
h2{margin:0;font-size:18px}
.why{margin:-8px 0 0;color:var(--muted);font-size:14px}
label{display:flex;flex-direction:column;gap:6px;font-size:15px}
fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}legend{font-size:15px;padding:0;margin-bottom:6px}
label.opt{flex-direction:row;align-items:center;gap:12px;min-height:48px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
label.opt input{width:22px;height:22px;min-height:0;margin:0;accent-color:var(--honey)}
input,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-height:46px;width:100%}
textarea{min-height:80px;resize:vertical}
input:focus,textarea:focus{outline:2px solid var(--honey);outline-offset:1px}
.bar{position:fixed;left:0;right:0;bottom:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));background:var(--card);border-top:1px solid var(--line);display:flex;gap:14px;align-items:center;justify-content:center}
button{font:inherit;font-weight:600;min-height:50px;padding:0 28px;border-radius:12px;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
button:disabled{opacity:.4}
#status{font-size:14px;color:var(--muted)}#status.ok{color:var(--ok)}#status.bad{color:var(--bad)}
.closed{text-align:center;margin-top:20vh}
</style></head><body>
<main id="form" hidden>
  <span class="brand">CheesyBeez</span>
  <h1>Last questions, Nisal</h1>
  <p class="lead">For Nisal Vimukthi. Answer what you know and leave the rest empty. Press <b>Save</b> any time; you can open this link again later and change your answers.</p>
  <p class="have">Already received, thank you: kitchen times (pizza 10 min, burger 3 min, pasta 20 min), your toppings, burger breading, pasta sizes, half &amp; half and the receipt. After this page there are no more questions.</p>
  ${SECTIONS.map((s) => `<section><h2>${esc(s.title)}</h2><p class="why">${esc(s.why)}</p>
  ${s.questions.map(([id, q, kind]) => field(id, q, kind)).join('\n  ')}
  </section>`).join('\n  ')}
</main>
<main id="closed" class="closed" hidden><span class="brand">CheesyBeez</span><h1>This link is not right</h1><p class="lead">Ask for the link again: it has to be opened exactly as it was sent.</p></main>
<div class="bar" id="bar" hidden><button id="save" type="button">Save</button><span id="status" role="status">Not saved yet</span></div>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
const fields = () => [...document.querySelectorAll('#form input:not([type=radio]), #form textarea')];
const choices = () => [...new Set([...document.querySelectorAll('#form input[type=radio]')].map((r) => r.name))];
let earlier = {};
const status = document.getElementById('status');
const say = (t, tone) => { status.textContent = t; status.className = tone || ''; };
const when = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const call = (method, body) => fetch('/api/v1/answers', { method, headers: { 'x-answer-key': key, 'content-type': 'application/json' }, body });
(async () => {
  try {
    const r = await call('GET');
    if (r.status === 401) { document.getElementById('closed').hidden = false; return; }
    const { savedAt, answers } = await r.json();
    earlier = answers;
    for (const f of fields()) if (typeof answers[f.id] === 'string') f.value = answers[f.id];
    for (const r of document.querySelectorAll('#form input[type=radio]')) r.checked = answers[r.name] === r.value;
    document.getElementById('form').hidden = false;
    document.getElementById('bar').hidden = false;
    if (savedAt) say('Last saved ' + when(savedAt), 'ok');
  } catch { document.getElementById('form').hidden = false; document.getElementById('bar').hidden = false; say('No connection: answers can be typed, then saved when online.', 'bad'); }
})();
document.addEventListener('input', () => say('Not saved yet'));
document.addEventListener('change', () => say('Not saved yet'));
document.getElementById('save').addEventListener('click', async (e) => {
  const button = e.currentTarget; button.disabled = true; say('Saving…');
  // Earlier answers stay: this page only adds to them.
  const answers = { ...earlier }; for (const f of fields()) answers[f.id] = f.value.trim();
  for (const n of choices()) answers[n] = document.querySelector('#form input[name="' + n + '"]:checked')?.value || '';
  try {
    const r = await call('POST', JSON.stringify({ answers }));
    if (!r.ok) throw new Error();
    earlier = answers;
    say('Saved ' + when((await r.json()).savedAt), 'ok');
  } catch { say('Not saved: check the internet and press Save again.', 'bad'); }
  button.disabled = false;
});
</script></body></html>`;
