// Cursor: the login is rows of state.vscdb. The tokens are encrypted with a key Cursor keeps in
// the macOS keychain, so swapping the rows works as they are, but reading usage needs that key
// (macOS asks you before handing it over).
//
// What moves with an account follows what Cursor itself clears when it signs out:
// - cursorAuth/*: the tokens, and the email, plan and team Cursor cached for them.
// - the privacy-mode rows: they come from the account (a company account can enforce privacy
//   mode), so the next account must not start on the previous one's setting.
// What stays: the model-provider API keys Cursor also files under cursorAuth/ (they are yours on
// this computer and survive Cursor's own sign-out), and everything Cursor stores per account id
// or checks against the signed-in id by itself (admin settings, agent keys, cloud agents).
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readKeys, writeKeys, text, editor } from '../lib/vscdb.mjs';

const MAC = process.platform === 'darwin';
const app = editor({
  name: 'Cursor', dataName: 'Cursor', dbEnv: 'CURSOR_DB',
  macApp: '/Applications/Cursor.app', macBinary: '/Applications/Cursor.app/Contents/MacOS/Cursor',
  winExe: 'cursor/Cursor.exe', linuxNames: ['cursor', 'Cursor'],
});
const DB = app.dbPath;
const GLOBS = ['cursorAuth/*', 'cursorai/donotchange/*'];
const OWN_KEYS = new Set(['openAIKey', 'claudeKey', 'googleKey', 'azureApiKey', 'bedrockAccessKey', 'bedrockSecretKey'].map((k) => `cursorAuth/${k}`));
const PRIVACY = new Set(['privacyMode', 'newPrivacyMode2', 'newPrivacyModeHoursRemainingInGracePeriod', 'partnerDataShare'].map((k) => `cursorai/donotchange/${k}`));
const stays = (key) => OWN_KEYS.has(key) || (key.startsWith('cursorai/donotchange/') && !PRIVACY.has(key));
const PREFIX = 'cursor-safe-storage:v1:';

let aesKey = null; // kept in memory only, for this run of the deck

function unlock() {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Cursor Safe Storage'], { timeout: 120000 }, (err, out) => {
      if (err) return reject(new Error('macOS did not release Cursor\'s storage key (the prompt was denied or timed out).'));
      aesKey = crypto.pbkdf2Sync(out.trim(), 'saltysalt', 1003, 16, 'sha1');
      resolve();
    });
  });
}

function token(payload) {
  const v = text(payload, 'cursorAuth/accessToken');
  if (!v.startsWith(PREFIX)) return v;
  if (!aesKey) throw new Error('locked');
  const raw = Buffer.from(v.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-128-cbc', aesKey, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(raw.subarray(3)), d.final()]).toString('utf8');
}

const cents = (n) => `$${(n / 100).toFixed(2)}`;

export default {
  id: 'cursor',
  name: 'Cursor',
  restart: true,
  appName: 'Cursor',
  signOutEnds: true,
  signInHint: 'Cursor reopens signed out. Sign in there and the new account shows up here by itself. Use this button instead of signing out inside Cursor, which ends the saved login.',

  detect() { return { installed: app.installed(), running: app.running() }; },
  usageLocked(payload) { return MAC && !aesKey && text(payload, 'cursorAuth/accessToken').startsWith(PREFIX); },
  unlock,

  readLive() {
    const payload = readKeys(DB, GLOBS, stays);
    if (!payload['cursorAuth/accessToken']) return null;
    let scoped = {};
    try { scoped = JSON.parse(text(payload, 'cursorAuth/cachedScopedProfile')); } catch {}
    const email = text(payload, 'cursorAuth/cachedEmail');
    // The token itself says whose login it is. When it can be read and the cached profile rows
    // still name someone else, Cursor is mid sign-in: wait for the rows to catch up.
    let owner = '';
    try { owner = JSON.parse(Buffer.from(token(payload).split('.')[1], 'base64url').toString()).sub || ''; } catch {}
    if (owner && scoped.authId && owner !== scoped.authId) return null;
    return {
      identity: {
        key: owner || scoped.authId || text(payload, 'cursorAuth/stripeMembershipAuthId') || email,
        email: email || scoped.displayName || 'Cursor account',
        plan: text(payload, 'cursorAuth/stripeMembershipType').replace(/_/g, ' '),
      },
      payload,
    };
  },

  sessionOf(payload) { return text(payload, 'cursorAuth/accessToken'); },

  writeLive(payload) { writeKeys(DB, GLOBS, payload, stays); },
  clearLive() { writeKeys(DB, GLOBS, {}, stays); },
  quit: () => app.quit(),
  launch: () => app.launch(),

  async fetchUsage(payload) {
    let t;
    try { t = token(payload); } catch { throw new Error(MAC ? 'Usage is locked. Use "Show usage" on the Cursor column first.' : 'Cursor usage can only be read on macOS for now.'); }
    let sub = '';
    try { sub = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub || ''; } catch {}
    const user = sub.split('|').pop();
    const r = await fetch('https://cursor.com/api/usage-summary', {
      headers: { cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${user}::${t}`)}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401 || (r.status >= 300 && r.status < 400)) {
      // These logins do not renew themselves: once Cursor refuses one it stays refused, which is
      // what signing out inside Cursor does to it. Switching to it would only open Cursor signed out.
      throw Object.assign(new Error('Cursor has ended this saved login, which is what signing out inside Cursor does. Use Sign in again here to get it back. Do not sign out inside Cursor to do it: that ends the other account too.'), { ended: true });
    }
    if (r.status !== 200) throw new Error(`Cursor usage request failed (HTTP ${r.status}).`);
    const j = await r.json();
    const resetsAt = j.billingCycleEnd ? Date.parse(j.billingCycleEnd) : null;
    const plan = j.individualUsage?.plan || {};
    const meters = [];
    // The dashboard's "Included in Pro+" bars: Cursor Models and Other Models, each a
    // percentage of the plan's pooled allowance (not the base included/used figures).
    if (typeof plan.autoPercentUsed === 'number') meters.push({ label: 'Cursor models', usedPercent: plan.autoPercentUsed, resetsAt });
    if (typeof plan.apiPercentUsed === 'number') meters.push({ label: 'Other models', usedPercent: plan.apiPercentUsed, resetsAt });
    const od = j.individualUsage?.onDemand;
    if (od?.enabled && od.limit) {
      meters.push({ label: 'On-demand', usedPercent: (100 * (od.used || 0)) / od.limit, detail: `${cents(od.used || 0)} of ${cents(od.limit)}`, resetsAt });
    }
    return { usage: { plan: (j.membershipType || '').replace(/_/g, ' '), meters, note: meters.length ? '' : 'Cursor returned no usage figures for this account.' } };
  },
};
