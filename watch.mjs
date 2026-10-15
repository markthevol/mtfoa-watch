// MTFOA outside watchdog. Runs every 5 minutes on GitHub (a different company from Cloudflare and not your Mac), asks the site's public
// health addresses a few real questions, and pushes a message to the phone (ntfy) when something has gone down, a reminder every 30 minutes
// while it stays down, and a message when it is back. It never contains member data: it only reads the same public addresses anyone can open.
//
//   node watch.mjs            run once (reads state.json, writes state.json, sends ntfy if needed)
//   env NTFY_TOPIC            the private ntfy topic (a GitHub secret)
//   env DRY_RUN=1             print what it would send, send nothing
import fs from 'node:fs';

const SITE = 'https://mtfoa.org';
const API = 'https://mtfoa-backend.markthevol.workers.dev';
export const PROBES = [
  { name: 'website pages', url: SITE + '/', ok: (r, t) => r.status === 200 && /Middle Tennessee|MTFOA/i.test(t) },
  { name: 'member portal page', url: SITE + '/mymtfoa', ok: (r, t) => r.status === 200 && t.length > 50000 },
  { name: 'backend and database', url: API + '/health', ok: (r, t) => r.status === 200 && /"database":"ok"/.test(t) },
  { name: 'members, roster, meetings', url: API + '/?type=health', ok: (r, t) => r.status === 200 && /"status":"ok"/.test(t) && !/false/.test(t) },
  { name: 'sign-in service', url: API + '/', method: 'POST', body: '{"action":"passkeyoptions"}', ok: (r, t) => r.status === 200 && /"status":"ok"/.test(t) },
];
const REMIND_MS = 30 * 60000;

export async function runProbe(p, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tries = 2, gapMs = 20000) {
  let why = '';
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetchFn(p.url, { method: p.method || 'GET', headers: p.body ? { 'content-type': 'text/plain' } : {}, body: p.body, signal: ctl.signal, redirect: 'follow' });
      const t = await r.text(); clearTimeout(timer);
      if (p.ok(r, t)) return { name: p.name, ok: true };
      why = 'HTTP ' + r.status + (t.length < 200 ? ': ' + t.replace(/\s+/g, ' ').slice(0, 120) : '');
    } catch (e) { why = String(e && e.name === 'AbortError' ? 'no answer in 15 seconds' : (e && e.message) || e).slice(0, 120); }
    if (i < tries - 1) await sleep(gapMs);                       // a blip must fail twice, 20 seconds apart, before anyone is woken
  }
  return { name: p.name, ok: false, why };
}

// prev: { status: 'up'|'down', since, lastNotified, failing: [] } or null. results: [{name, ok, why}]. Returns the new state and the messages to send.
export function decide(prev, results, nowMs) {
  const failing = results.filter((r) => !r.ok);
  const iso = new Date(nowMs).toISOString();
  const was = prev && prev.status === 'down' ? 'down' : 'up';
  const lines = failing.map((f) => '- ' + f.name + (f.why ? ' (' + f.why + ')' : ''));
  if (failing.length && was === 'up') {
    return { state: { status: 'down', since: iso, lastNotified: iso, failing: failing.map((f) => f.name) },
      notify: [{ title: 'MTFOA site problem', priority: 5, tags: 'rotating_light', body: 'Not working right now:\n' + lines.join('\n') + '\n\nStatus: https://status.mtfoa.org' }] };
  }
  if (failing.length && was === 'down') {
    const due = nowMs - Date.parse(prev.lastNotified || prev.since || iso) >= REMIND_MS;
    const mins = Math.round((nowMs - Date.parse(prev.since || iso)) / 60000);
    return { state: { ...prev, failing: failing.map((f) => f.name), lastNotified: due ? iso : prev.lastNotified },
      notify: due ? [{ title: 'MTFOA still down (' + mins + ' min)', priority: 4, tags: 'warning', body: 'Still not working:\n' + lines.join('\n') }] : [] };
  }
  if (!failing.length && was === 'down') {
    const mins = Math.max(1, Math.round((nowMs - Date.parse(prev.since || iso)) / 60000));
    return { state: { status: 'up', since: iso, lastNotified: iso, failing: [] },
      notify: [{ title: 'MTFOA is back', priority: 3, tags: 'white_check_mark', body: 'Everything answers again after about ' + mins + ' minutes.' }] };
  }
  return { state: prev && prev.status === 'up' ? prev : { status: 'up', since: iso, lastNotified: '', failing: [] }, notify: [] };
}

export async function sendNtfy(topic, m, fetchFn = fetch, server = 'https://ntfy.sh') {
  const res = await fetchFn(server.replace(/\/$/, '') + '/' + encodeURIComponent(topic), {
    method: 'POST', headers: { Title: m.title, Priority: String(m.priority), Tags: m.tags, Click: 'https://status.mtfoa.org' }, body: m.body,
  });
  return res.ok;
}

async function main() {
  const topic = process.env.NTFY_TOPIC || '', dry = process.env.DRY_RUN === '1';
  if (!topic && !dry) { console.error('NTFY_TOPIC is not set'); process.exit(1); }
  const results = await Promise.all(PROBES.map((p) => runProbe(p)));
  const verbose = dry || process.env.VERBOSE === '1';        // this repository is public: a run log says how many checks passed, not which failed or why
  if (verbose) results.forEach((r) => console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.why ? '  -> ' + r.why : '')));
  else console.log('checked ' + results.length + ' things: ' + results.filter((r) => r.ok).length + ' answered');
  let prev = null; try { prev = JSON.parse(fs.readFileSync('state.json', 'utf8')); } catch (e) { prev = null; }
  const { state, notify } = decide(prev, results, Date.now());
  for (const m of notify) {
    if (dry) { console.log('WOULD SEND:', JSON.stringify(m)); continue; }
    const sent = await sendNtfy(topic, m);
    console.log('phone message ' + (sent ? 'sent' : 'not accepted'));
    if (!sent) state.lastNotified = prev ? prev.lastNotified : '';       // try again on the next run
  }
  if (!prev || JSON.stringify(prev) !== JSON.stringify(state)) fs.writeFileSync('state.json', JSON.stringify(state, null, 1) + '\n');
}
if (process.argv[1] && process.argv[1].endsWith('watch.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
