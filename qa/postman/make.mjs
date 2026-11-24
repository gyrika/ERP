// Generates the Postman collection (kept as code so it stays reviewable). node postman/make.mjs
import { writeFileSync } from 'node:fs';
const req = (name, method, path, { auth = '{{token}}', body, tests, pre } = {}) => ({
  name,
  event: [
    ...(pre ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
    { listen: 'test', script: { type: 'text/javascript', exec: tests } },
  ],
  request: {
    method,
    header: [{ key: 'Content-Type', value: 'application/json' }, ...(auth ? [{ key: 'Authorization', value: `Bearer ${auth}` }] : [])],
    url: { raw: `{{base}}${path}`, host: ['{{base}}'], path: path.replace(/^\//, '').split('/') },
    ...(body ? { body: { mode: 'raw', raw: body } } : {}),
  },
});
const status = (code) => `pm.test("status is ${code}", () => pm.response.to.have.status(${code}));`;
const fast = `pm.test("responds under 500 ms", () => pm.expect(pm.response.responseTime).to.be.below(500));`;
const discount = (id, pct) => JSON.stringify({ deviceId: 'qa', events: [{
  id, shopId: '{{shop}}', at: '{{now}}', orderNumber: 42, type: 'order.discount_set',
  actor: '{{managerActor}}', totalBefore: 190000, totalAfter: 0, before: null, after: { kind: 'percent', pct } }] }, null, 2)
  .replace('"{{now}}"', '{{now}}').replace('"{{managerActor}}"', '{{managerActor}}');

const items = [
  req('API-01 health needs no token', 'GET', '/api/v1/health', { auth: null, tests: [status(200), fast, 'pm.test("ok is true", () => pm.expect(pm.response.json().ok).to.eql(true));'] }),
  req('API-02 events without a token are refused', 'GET', '/api/v1/events', { auth: null, tests: [status(401), 'pm.test("error unauthorized", () => pm.expect(pm.response.json().error).to.eql("unauthorized"));'] }),
  req('API-03 events with a forged token are refused', 'GET', '/api/v1/events', { auth: 'forged-token-0000', tests: [status(401)] }),
  req('API-04 cashier logs in with the right PIN', 'POST', '/api/v1/login', { body: '{"pin":"1111"}', tests: [status(200), fast, 'const j = pm.response.json(); pm.test("actor is the cashier", () => pm.expect(j.actor.role).to.eql("cashier")); pm.test("PIN hash never returned", () => pm.expect(JSON.stringify(j)).to.not.include("hash"));'] }),
  req('API-05 cashier PIN is not a manager PIN', 'POST', '/api/v1/login', { body: '{"pin":"1111","purpose":"manager"}', tests: [status(401), 'pm.test("wrong_pin, says nothing about who exists", () => pm.expect(pm.response.json().error).to.eql("wrong_pin"));'] }),
  req('API-06 SQL injection in the PIN is just a wrong PIN', 'POST', '/api/v1/login', { body: `{"pin":"' OR '1'='1"}`, tests: [status(401)] }),
  req('API-07 manager logs in for manager mode', 'POST', '/api/v1/login', { body: '{"pin":"2580","purpose":"manager"}', tests: [status(200), 'pm.collectionVariables.set("managerActor", JSON.stringify(pm.response.json().actor));'] }),
  req('API-08 pull events', 'GET', '/api/v1/events?after=0&limit=10', { tests: [status(200), fast, 'pm.test("has events array", () => pm.expect(pm.response.json().events).to.be.an("array"));'] }),
  req('API-09 an event for another shop is refused', 'POST', '/api/v1/events', { body: JSON.stringify({ deviceId: 'qa', events: [{ id: 'x-1', shopId: 'shop-other', at: 1, orderNumber: 1, ticketId: 't', type: 'kitchen.seen' }] }), tests: [status(403), 'pm.test("wrong_shop", () => pm.expect(pm.response.json().error).to.eql("wrong_shop"));'] }),
  req('API-10 malformed JSON body gives 400, not a crash', 'POST', '/api/v1/events', { body: '{"events": [', tests: ['pm.test("4xx client error", () => pm.expect(pm.response.code).to.be.within(400, 499));'] }),
  req('API-11 a 10% discount by a logged-in manager is accepted', 'POST', '/api/v1/events', { pre: ['pm.collectionVariables.set("now", Date.now());', 'pm.collectionVariables.set("eid", "qa-" + Date.now());'], body: discount('{{eid}}-ok', 10), tests: [status(200), 'pm.test("accepted", () => pm.expect(pm.response.json().rejected).to.be.undefined);'] }),
  req('API-12 BUG-01 a negative discount (-50%) is refused', 'POST', '/api/v1/events', { pre: ['pm.collectionVariables.set("now", Date.now());'], body: discount('{{eid}}-neg', -50), tests: ['pm.test("BUG-01: negative percent must be refused with 400", () => pm.response.to.have.status(400));'] }),
  req('API-13 BUG-01 a discount over 100% is refused', 'POST', '/api/v1/events', { pre: ['pm.collectionVariables.set("now", Date.now());'], body: discount('{{eid}}-big', 250), tests: ['pm.test("percent above 100 must be refused with 400", () => pm.response.to.have.status(400));'] }),
  req('API-14 five wrong PINs lock the device (brute force)', 'POST', '/api/v1/login', {
    pre: ['const base = pm.environment.get("base"), token = pm.environment.get("token");',
      'for (let i = 0; i < 5; i++) pm.sendRequest({ url: base + "/api/v1/login", method: "POST", header: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: { mode: "raw", raw: JSON.stringify({ pin: "000" + i }) } }, () => {});',
      'setTimeout(() => {}, 1500);'],
    body: '{"pin":"1111"}', tests: [status(429), 'pm.test("even the right PIN waits", () => pm.expect(pm.response.json().error).to.eql("too_many"));'] }),
];
writeFileSync(new URL('./cheesybeez-api.postman_collection.json', import.meta.url), JSON.stringify({
  info: { name: 'CheesyBeez POS sync API (EC4206)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: items, variable: [{ key: 'managerActor', value: '' }, { key: 'now', value: '0' }, { key: 'eid', value: '' }],
}, null, 2));
