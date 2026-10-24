import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_MODEL, MAX_AUDIO_BYTES, pickCommand, readCommandAsk, SPEECH_MODEL, type AiLike } from './ai.ts';
import { createCloud, sha256Hex } from './cloud.ts';
import { fakeD1 } from './fakeD1.ts';

const COMMANDS = [
  { id: 'owner', label: 'Owner view' },
  { id: 'stock', label: 'Stock' },
  { id: 'menu', label: 'Menu and prices' },
];

/** Workers AI that answers what the test says, and remembers what it was asked. */
const fakeAi = (answer: (model: string, input: Record<string, unknown>) => unknown) => {
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const ai: AiLike = { run: async (model, input) => { calls.push({ model, input }); return answer(model, input); } };
  return { ai, calls };
};

async function setup(ai: AiLike | null, dailyCalls?: number) {
  const { d1, db } = fakeD1();
  db.prepare("INSERT INTO shops (id, name, created_at) VALUES ('shop-a', 'A', 0)").run();
  db.prepare("INSERT INTO devices (id, tenant_id, kind, token_hash, created_at) VALUES ('d1', 'shop-a', 'shop_server', ?, 0)").run(await sha256Hex('server-a'));
  const handle = createCloud(d1, { now: () => Date.UTC(2026, 9, 24, 12), ai, aiDailyCalls: dailyCalls });
  const ask = (body: unknown, token: string | null = 'server-a') => handle(new Request('https://cloud.test/api/v1/ai/command', {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
  }));
  const hear = (audio: Uint8Array<ArrayBuffer>, type = 'audio/webm') => handle(new Request('https://cloud.test/api/v1/ai/transcribe', {
    method: 'POST', headers: { authorization: 'Bearer server-a', 'content-type': type }, body: audio,
  }));
  return { ask, hear };
}

test('only a paired device may use the language model', async () => {
  const { ask } = await setup(fakeAi(() => ({ response: 'stock' })).ai);
  assert.equal((await ask({ text: 'open stock', commands: COMMANDS }, null)).status, 401);
  assert.equal((await ask({ text: 'open stock', commands: COMMANDS }, 'nobody')).status, 401);
});

test('the model picks one of the commands it was given; anything else is none', async () => {
  let reply = 'stock';
  const { ai, calls } = fakeAi(() => ({ response: reply }));
  const { ask } = await setup(ai);
  assert.deepEqual(await (await ask({ text: 'how much cheese is left', commands: COMMANDS })).json(), { id: 'stock', cached: false });
  assert.equal(calls[0].model, COMMAND_MODEL);
  assert.match(JSON.stringify(calls[0].input), /stock: Stock/);
  reply = 'refunds';
  assert.deepEqual(await (await ask({ text: 'give a refund', commands: COMMANDS })).json(), { id: null, cached: false });
});

test('the same question again is answered from the cache, without the model', async () => {
  const { ai, calls } = fakeAi(() => ({ response: 'owner' }));
  const { ask } = await setup(ai);
  await ask({ text: "Today's  sales", commands: COMMANDS });
  assert.deepEqual(await (await ask({ text: "today's sales", commands: COMMANDS })).json(), { id: 'owner', cached: true });
  assert.equal(calls.length, 1);
  // A different list of commands is a different question (a cashier sees fewer than the owner).
  await ask({ text: "today's sales", commands: COMMANDS.slice(1) });
  assert.equal(calls.length, 2);
});

test("past the shop's daily cap the model is not called: 429", async () => {
  const { ai, calls } = fakeAi(() => ({ response: 'menu' }));
  const { ask } = await setup(ai, 2);
  assert.equal((await ask({ text: 'one', commands: COMMANDS })).status, 200);
  assert.equal((await ask({ text: 'two', commands: COMMANDS })).status, 200);
  const third = await ask({ text: 'three', commands: COMMANDS });
  assert.equal(third.status, 429);
  assert.equal(((await third.json()) as { error: string }).error, 'too_many');
  assert.equal(calls.length, 2);
});

test('no model set up, or the model fails: 503, never a guess', async () => {
  assert.equal((await (await setup(null)).ask({ text: 'open stock', commands: COMMANDS })).status, 503);
  const broken = await setup(fakeAi(() => { throw new Error('down'); }).ai);
  const r = await broken.ask({ text: 'open stock', commands: COMMANDS });
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'unavailable');
});

test('a malformed request is refused before the model is asked', async () => {
  const { ai, calls } = fakeAi(() => ({ response: 'stock' }));
  const { ask } = await setup(ai);
  assert.equal((await ask({ text: '', commands: COMMANDS })).status, 400);
  assert.equal((await ask({ text: 'open stock', commands: [] })).status, 400);
  assert.equal((await ask({ text: 'open stock', commands: [{ id: 'bad id!', label: 'x' }] })).status, 400);
  assert.equal(calls.length, 0);
});

test('a recording becomes words; empty, too long or not audio is refused', async () => {
  const { ai, calls } = fakeAi(() => ({ text: '  open   stock ' }));
  const { hear } = await setup(ai);
  assert.deepEqual(await (await hear(new Uint8Array([1, 2, 3]))).json(), { text: 'open stock' });
  assert.equal(calls[0].model, SPEECH_MODEL);
  assert.deepEqual(calls[0].input, { audio: [1, 2, 3] });
  assert.equal((await hear(new Uint8Array())).status, 400);
  assert.equal((await hear(new Uint8Array(MAX_AUDIO_BYTES + 1))).status, 413);
  assert.equal((await hear(new Uint8Array([1]), 'text/plain')).status, 400);
});

test('reading the reply: the id alone, or exactly one id named in a sentence', () => {
  assert.equal(pickCommand({ response: ' "stock". ' }, COMMANDS), 'stock');
  assert.equal(pickCommand({ response: 'The screen is menu.' }, COMMANDS), 'menu');
  assert.equal(pickCommand({ response: 'stock or menu' }, COMMANDS), null);
  assert.equal(pickCommand({ response: 'none' }, COMMANDS), null);
  assert.equal(pickCommand(undefined, COMMANDS), null);
  // Newer Workers AI models answer in the OpenAI shape.
  assert.equal(pickCommand({ choices: [{ message: { content: 'owner' } }] }, COMMANDS), 'owner');
  assert.equal(pickCommand({ choices: [{ message: { content: null } }] }, COMMANDS), null);
  assert.equal(typeof readCommandAsk({ text: 'x'.repeat(201), commands: COMMANDS }), 'string');
});
