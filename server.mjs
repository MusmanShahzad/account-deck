#!/usr/bin/env node
// Account Deck: a local page for switching between saved logins and seeing usage.
// Listens on 127.0.0.1 only. Tokens never leave this process except to the tool's own service.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.mjs';
import claudeDesktop from './providers/claude-desktop.mjs';
import claude from './providers/claude.mjs';
import codex from './providers/codex.mjs';
import cursor from './providers/cursor.mjs';
import antigravity from './providers/antigravity.mjs';

let PORT = Number(process.env.PORT || 4777);
export const PROVIDERS = { 'claude-desktop': claudeDesktop, claude, codex, cursor, antigravity };
const TOKEN = crypto.randomBytes(24).toString('hex');
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html');
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'logo.svg');
const busy = new Set();

function live(p, fresh) {
  try { return p.readLive(fresh); } catch (e) { return { error: e.message }; }
}

const SETTLE_MS = Number(process.env.ACCOUNT_DECK_SETTLE_MS || 10000);
const settling = new Map(); // provider id -> { mark, since }
const lastActive = new Map(); // provider id -> id of the profile last seen signed in

// An account that stops being the signed-in one without the deck doing it was signed out (or
// replaced) from inside the tool, and for these tools that ends the login on the service's
// side too. The saved copy is kept, with a warning, until the account signs in again.
function noteSignOut(p, cur, active) {
  if (!p.signOutEnds) return;
  const was = lastActive.get(p.id);
  if (active) {
    lastActive.set(p.id, active.id);
    if (!was || was === active.id) return;
  } else if (cur !== null || !was) return; // unreadable, still settling, or nobody was signed in
  else lastActive.delete(p.id);
  const prof = store.get(p.id, was);
  if (prof) store.save(p.id, { ...prof, signedOutInApp: Date.now() });
}

// Keeps the saved copy of the signed-in account current (tokens rotate), and
// saves a login the deck has not seen before. Returns the matching profile.
function sync(p, cur, force) {
  if (!cur || cur.error) return null;
  const profiles = store.list(p.id);
  let prof = profiles.find((x) => x.identity.key === cur.identity.key);
  if (!prof) {
    prof = { id: store.newId(), label: '', identity: cur.identity, payload: cur.payload, savedAt: Date.now(), usage: null };
    store.save(p.id, prof);
    settling.delete(p.id);
    return prof;
  }
  // A real name, once learned, is kept when the tool can only offer a placeholder this time.
  const identity = cur.identity.unnamed && !prof.identity.unnamed ? prof.identity : cur.identity;
  if (JSON.stringify(prof.payload) === JSON.stringify(cur.payload) && JSON.stringify(prof.identity) === JSON.stringify(identity)) return prof;
  // A different sign-in under an account that is already saved: either that account signed in
  // again, or someone else just signed in and the app has not recorded who yet. Saving now
  // could put the new person's login over this account's, so wait until it holds still.
  const session = p.sessionOf?.(cur.payload);
  const renewed = !!session && session !== p.sessionOf(prof.payload);
  if (!force && renewed) {
    const mark = `${cur.identity.key}:${session}`, s = settling.get(p.id);
    if (s?.mark !== mark) { settling.set(p.id, { mark, since: Date.now() }); return null; }
    if (Date.now() - s.since < SETTLE_MS) return null;
  }
  settling.delete(p.id);
  prof = { ...prof, identity, payload: cur.payload };
  if (renewed) delete prof.signedOutInApp; // signed in afresh, so the saved login is good again
  store.save(p.id, prof);
  return prof;
}

export function state() {
  return Object.values(PROVIDERS).map((p) => {
    const cur = busy.has(p.id) ? null : live(p);
    const active = sync(p, cur);
    if (!busy.has(p.id)) noteSignOut(p, cur, active);
    return {
      id: p.id,
      name: p.name,
      ...p.detect(),
      restart: p.restart,
      experimental: !!p.experimental,
      hostApp: !!p.hostApp,
      busy: busy.has(p.id),
      error: cur?.error || '',
      usageLocked: !!(p.usageLocked && active && p.usageLocked(active.payload)),
      profiles: store.list(p.id).map((x) => ({
        id: x.id, label: x.label, email: x.identity.email, plan: x.usage?.plan || x.identity.plan,
        uuid: String(x.identity.key).split(':')[0],
        active: active?.id === x.id, usage: x.usage,
        needsSignIn: active?.id !== x.id && (!!p.needsSignIn?.(x.payload) || !!x.usage?.ended),
        signedOut: active?.id !== x.id && !!x.signedOutInApp,
      })),
    };
  });
}

// Runs fn with the app closed (when the tool needs that) and reopens it afterwards.
async function withAppClosed(p, fn) {
  if (busy.has(p.id)) throw new Error(`${p.name} is already being switched.`);
  busy.add(p.id);
  try {
    const wasRunning = p.restart ? await p.quit() : false;
    try {
      await p.ready?.();
      const leaving = sync(p, live(p, true), true); // capture the latest tokens of the account we are leaving
      if (leaving) p.keepAside?.(leaving.id); // and anything else of it that only stays still while the app is closed
      fn();
    } finally {
      if (wasRunning) p.launch();
    }
  } finally { busy.delete(p.id); }
}

export const routes = {
  async switch(p, prof) {
    // Checked before the app is closed, so a login that cannot be restored never costs a restart.
    if (p.needsSignIn?.(prof.payload)) throw new Error(p.needsSignInHint);
    // Where the service can be asked, a login it has ended is caught here rather than after
    // the app has been closed and reopened signed out. Any other failure does not block.
    if (p.restart) {
      try { await p.fetchUsage(prof.payload, { active: false }); } catch (e) {
        if (e.ended) { store.save(p.id, { ...prof, usage: { ...(prof.usage || {}), error: e.message, ended: true } }); throw e; }
      }
    }
    await withAppClosed(p, () => {
      p.writeLive(prof.payload, prof.id);
      // The desktop app and Claude Code share one Anthropic account: when the deck has a saved
      // Claude Code login for this same account, switch that too so both stay on the same person.
      if (p.id === 'claude-desktop' && PROVIDERS.claude) {
        const uuid = prof.identity.key;
        const cc = store.list('claude').find((x) => x.identity.key.split(':')[0] === uuid);
        if (cc) { PROVIDERS.claude.writeLive(cc.payload, cc.id); lastActive.set('claude', cc.id); }
      }
    });
    lastActive.set(p.id, prof.id); // the deck's own doing, not a sign-out inside the tool
  },
  async signout(p) {
    // Check before signing out, so a missing CLI never leaves the account signed out with nothing to sign in with.
    if (p.startLogin && p.canLogin && !p.canLogin()) {
      throw new Error(`${p.name} command line is not installed. Install it, then press Add account again.`);
    }
    await withAppClosed(p, () => p.clearLive());
    lastActive.delete(p.id);
    if (p.startLogin) p.startLogin(); // e.g. Codex: open its sign-in page straight away
    return { hint: p.signInHint };
  },
  async unlock(p) { if (p.unlock) await p.unlock(); },
  async usage(p, prof) {
    const cur = live(p);
    const active = !!cur && !cur.error && cur.identity.key === prof.identity.key;
    let usage;
    try {
      const r = await p.fetchUsage(prof.payload, { active });
      usage = { ...r.usage, fetchedAt: Date.now() };
      if (r.payload) { prof.payload = r.payload; if (active) p.writeLive(r.payload); }
    } catch (e) {
      usage = { ...(prof.usage || {}), error: e.message, ended: !!e.ended };
    }
    store.save(p.id, { ...prof, usage });
  },
  async rename(p, prof, body) { store.save(p.id, { ...prof, label: String(body.label || '').slice(0, 40) }); },
  async remove(p, prof) { store.remove(p.id, prof.id); p.forget?.(prof.id); },
};
const NEEDS_PROFILE = new Set(['switch', 'usage', 'rename', 'remove']);

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/logo.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end(fs.readFileSync(LOGO));
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(PAGE, 'utf8').replace('__DECK_TOKEN__', TOKEN), 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.headers['x-deck-token'] !== TOKEN) return send(res, 403, { error: 'Reload the page.' });
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { providers: state() });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });

    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 4096) return send(res, 413, { error: 'too large' }); }
    const body = raw ? JSON.parse(raw) : {};
    const [, , pid, action] = url.pathname.split('/');
    const p = PROVIDERS[pid];
    const fn = routes[action];
    if (!p || !fn) return send(res, 404, { error: 'not found' });
    let prof = null;
    if (NEEDS_PROFILE.has(action)) {
      prof = store.get(p.id, String(body.id || ''));
      if (!prof) return send(res, 404, { error: 'That account is no longer saved.' });
    }
    const extra = (await fn(p, prof, body)) || {};
    send(res, 200, { ...extra, providers: state() });
  } catch (e) {
    send(res, 500, { error: e.message || 'Something went wrong.', providers: state() });
  }
});

// Starts the local page. If the usual port is taken, any free one is used instead.
export function start() {
  return new Promise((resolve, reject) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? server.listen(0, '127.0.0.1') : reject(e)));
    server.once('listening', () => { PORT = server.address().port; resolve(PORT); });
    server.listen(PORT, '127.0.0.1');
  });
}

export { store };

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((port) => console.log(`Account Deck: http://127.0.0.1:${port}`));
}
