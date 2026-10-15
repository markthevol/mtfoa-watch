import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, runProbe, PROBES } from '../watch.mjs';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0), MIN = 60000;
const ok = (name) => ({ name, ok: true }), bad = (name, why = 'HTTP 503') => ({ name, ok: false, why });

test('up and healthy: nothing sent', () => {
  const r = decide({ status: 'up', since: '2026-10-01T00:00:00Z', failing: [] }, [ok('a'), ok('b')], T0);
  assert.equal(r.notify.length, 0); assert.equal(r.state.status, 'up');
});
test('first failure: one urgent message naming what is wrong', () => {
  const r = decide(null, [ok('a'), bad('backend and database')], T0);
  assert.equal(r.state.status, 'down'); assert.equal(r.notify.length, 1);
  assert.equal(r.notify[0].priority, 5); assert.match(r.notify[0].body, /backend and database \(HTTP 503\)/);
});
test('still down: quiet for 30 minutes, then one reminder', () => {
  const down = decide(null, [bad('x')], T0).state;
  assert.equal(decide(down, [bad('x')], T0 + 10 * MIN).notify.length, 0);
  assert.equal(decide(down, [bad('x')], T0 + 29 * MIN).notify.length, 0);
  const r = decide(down, [bad('x')], T0 + 31 * MIN);
  assert.equal(r.notify.length, 1); assert.match(r.notify[0].title, /still down \(31 min\)/);
  assert.equal(decide(r.state, [bad('x')], T0 + 40 * MIN).notify.length, 0);          // the reminder reset the clock
});
test('recovery: one message with how long it was down, then silence', () => {
  const down = decide(null, [bad('x')], T0).state;
  const r = decide(down, [ok('x')], T0 + 18 * MIN);
  assert.equal(r.state.status, 'up'); assert.equal(r.notify.length, 1); assert.match(r.notify[0].body, /about 18 minutes/);
  assert.equal(decide(r.state, [ok('x')], T0 + 25 * MIN).notify.length, 0);
});
test('a probe must fail twice before it counts; a blip that clears is not a failure', async () => {
  let calls = 0;
  const flaky = async () => (++calls === 1 ? new Response('x', { status: 503 }) : new Response('{"status":"ok","database":"ok"}', { status: 200 }));
  const r = await runProbe(PROBES.find((p) => p.name === 'backend and database'), flaky, async () => {}, 2, 0);
  assert.equal(r.ok, true); assert.equal(calls, 2);
  const dead = async () => { throw new Error('connect ECONNREFUSED'); };
  const d = await runProbe(PROBES[0], dead, async () => {}, 2, 0);
  assert.equal(d.ok, false); assert.match(d.why, /ECONNREFUSED/);
});
test('the probes read only public health addresses', () => {
  for (const p of PROBES) assert.match(p.url, /^https:\/\/(mtfoa\.org|mtfoa-backend\.markthevol\.workers\.dev)(\/|$)/);
  assert.ok(PROBES.length >= 5);
  assert.ok(!PROBES.some((p) => /payments/.test(p.url)), 'the payments check stays out of the public watchdog (it asks Stripe each time)');
});
