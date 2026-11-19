// Claude Code: the login is the claudeAiOauth entry, with a few account-bound neighbours, inside
// a credentials blob (macOS keychain item "Claude Code-credentials", or ~/.claude/.credentials.json
// on Windows and Linux), plus the oauthAccount entry in ~/.claude.json.
//
// What moves with an account follows what Claude Code itself removes when it signs out:
// - in the blob: claudeAiOauth, organizationUuid, trustedDeviceToken, enterpriseGateway, designOauth.
//   The blob also holds MCP server sign-ins. Those are not part of the account: they are never
//   saved in a profile, and a switch or sign-out leaves them exactly as they are.
// - in ~/.claude.json: oauthAccount, and the caches Claude Code keeps about that account
//   (model access, usage, org defaults), which are dropped so the next account starts clean.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeSecret } from '../lib/store.mjs';

const MAC = process.platform === 'darwin';
const CUSTOM = process.env.CLAUDE_CONFIG_DIR;
const DIR = CUSTOM || path.join(os.homedir(), '.claude');
const CONFIG = CUSTOM ? path.join(DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
const CRED_FILE = path.join(DIR, '.credentials.json');
// Claude Code adds a short hash of a non-default settings folder to the keychain item's name.
const SERVICE = 'Claude Code-credentials' + (CUSTOM ? '-' + crypto.createHash('sha256').update(DIR.normalize('NFC')).digest('hex').slice(0, 8) : '');
const KEYCHAIN_USER = process.env.USER || os.userInfo().username;
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ACCOUNT_KEYS = ['claudeAiOauth', 'organizationUuid', 'trustedDeviceToken', 'enterpriseGateway', 'designOauth'];
const ACCOUNT_CACHES = ['additionalModelOptionsCache', 'additionalModelOptionsAnsweredAt', 'additionalModelCostsCache', 'modelAccessCache', 'orgModelDefaultCache', 'cachedArtifactRoster', 'artifactRosterDenied', 'lastSeenOrgDefaultUpdatedAt', 'clientDataCache', 'clientDataCacheSlots', 'autoCompactWindowsCache', 'cachedUsageUtilization', 'githubWebConnectionStatusCache', 'startupPrefetchedAt'];
const SECURITY = '/usr/bin/security';

let cache = null; // { key, blob | err, at }: avoids asking the keychain on every refresh

// The whole blob as an object; {} when nothing is stored yet.
function readBlob() {
  let text;
  if (!MAC) {
    try { text = fs.readFileSync(CRED_FILE, 'utf8'); } catch { return {}; }
  } else {
    try {
      text = execFileSync(SECURITY, ['find-generic-password', '-a', KEYCHAIN_USER, '-s', SERVICE, '-w'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      if (e.status === 44) return {}; // no such item: nobody has signed in
      throw new Error('macOS did not release the Claude Code login (allow the keychain prompt, then reopen the deck).');
    }
  }
  try { const blob = JSON.parse(text); return blob && typeof blob === 'object' ? blob : {}; } catch { throw new Error('The stored Claude Code login could not be read.'); }
}

function writeBlob(blob) {
  const empty = !Object.keys(blob).length;
  if (!MAC) {
    if (empty) return fs.rmSync(CRED_FILE, { force: true });
    fs.mkdirSync(DIR, { recursive: true });
    return writeSecret(CRED_FILE, JSON.stringify(blob));
  }
  if (empty) {
    try { execFileSync(SECURITY, ['delete-generic-password', '-a', KEYCHAIN_USER, '-s', SERVICE], { stdio: 'ignore', timeout: 60000 }); } catch {}
    return;
  }
  const text = JSON.stringify(blob), hex = Buffer.from(text).toString('hex');
  // Passed on stdin as hex so the secret does not appear in a process list. That road takes one
  // line of about 4 KB and silently drops anything longer, so a larger blob (several MCP
  // sign-ins are enough) goes as an argument instead, the same way Claude Code does it.
  const line = `add-generic-password -U -a "${KEYCHAIN_USER}" -s "${SERVICE}" -X "${hex}"\n`;
  try {
    if (line.length <= 4000) execFileSync(SECURITY, ['-i'], { input: line, timeout: 60000, stdio: ['pipe', 'ignore', 'ignore'] });
    else execFileSync(SECURITY, ['add-generic-password', '-U', '-a', KEYCHAIN_USER, '-s', SERVICE, '-X', hex], { timeout: 60000, stdio: 'ignore' });
  } catch {}
  // Neither road reports a failed save reliably, so the item is read back.
  if (JSON.stringify(readBlob()) !== text) throw new Error('macOS did not save the Claude Code login to the keychain. Nothing else was changed.');
}

const pick = (blob) => Object.fromEntries(ACCOUNT_KEYS.filter((k) => blob[k] !== undefined).map((k) => [k, blob[k]]));

// Missing file: null. A file that is there but cannot be read is an error, never "empty":
// writing over it would wipe every Claude Code setting on this computer.
function readConfig(strict) {
  let text;
  try { text = fs.readFileSync(CONFIG, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch {
    if (strict) throw new Error('Claude Code is rewriting its settings file right now. Try again in a moment.');
    return null;
  }
}

function setAccount(account) {
  const cfg = readConfig(true) || {};
  if (account) cfg.oauthAccount = account; else delete cfg.oauthAccount;
  for (const k of ACCOUNT_CACHES) delete cfg[k];
  writeSecret(CONFIG, JSON.stringify(cfg, null, 2));
}

const oauth = (creds) => { try { return JSON.parse(creds).claudeAiOauth || {}; } catch { return {}; } };

// Whose login a token is, asked of the service itself. ~/.claude.json cannot be trusted for
// this: every Claude Code on the computer writes its own account there, including the copy
// inside the Claude desktop app, so it can name a different account than the stored login.
const owners = new Map(); // login fingerprint -> { accountUuid, emailAddress, organizationUuid } | null | Promise
const fingerprint = (o) => crypto.createHash('sha256').update(o.refreshToken || o.accessToken).digest('hex');
function owner(o) {
  const k = fingerprint(o);
  if (!owners.has(k)) {
    owners.set(k, (async () => {
      let found = null;
      try {
        const r = await fetch('https://api.anthropic.com/api/oauth/profile', { headers: { authorization: `Bearer ${o.accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        const j = r.ok ? await r.json() : null;
        if (j?.account?.uuid) found = { accountUuid: j.account.uuid, emailAddress: j.account.email || '', organizationUuid: j.organization?.uuid || '' };
      } catch {}
      owners.set(k, found);
      if (!found) setTimeout(() => { if (owners.get(k) === null) owners.delete(k); }, 60000).unref(); // offline or expired: ask again later
      return found;
    })());
  }
  return owners.get(k);
}

async function renew(payload) {
  const o = oauth(payload.credentials);
  const r = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('Login expired. Switch to this account and run /login in Claude Code.');
  const j = await r.json();
  const all = JSON.parse(payload.credentials);
  all.claudeAiOauth = { ...o, accessToken: j.access_token, refreshToken: j.refresh_token || o.refreshToken, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return { ...payload, credentials: JSON.stringify(all) };
}

const LABELS = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };

export default {
  id: 'claude',
  name: 'Claude Code',
  restart: false,
  signInHint: 'Run `claude` in a terminal and use /login. The new account shows up here by itself.',

  detect() { return { installed: fs.existsSync(DIR) || fs.existsSync(CONFIG), running: false }; },

  readLive(fresh) {
    const cfgAcct = readConfig()?.oauthAccount;
    const key = `${cfgAcct?.accountUuid || ''}:${cfgAcct?.organizationUuid || ''}`;
    if (fresh || !cache || cache.key !== key || Date.now() - cache.at > 60000) {
      try { cache = { key, blob: readBlob(), at: Date.now() }; } catch (err) { cache = { key, err, at: Date.now() }; }
    }
    if (cache.err) throw cache.err;
    const o = cache.blob.claudeAiOauth;
    if (!o?.accessToken) return null;
    const who = owner(o);
    if (who instanceof Promise) return null; // being asked; the next refresh has the answer
    let acct;
    if (who) acct = cfgAcct?.accountUuid === who.accountUuid && (cfgAcct.organizationUuid || '') === who.organizationUuid ? cfgAcct : who;
    else {
      // The service could not be asked (offline, or the token has run out). Fall back to the
      // settings file, unless the stored login plainly belongs to another organization.
      const org = cache.blob.organizationUuid;
      if (!cfgAcct?.accountUuid || (org && cfgAcct.organizationUuid && org !== cfgAcct.organizationUuid)) return null;
      acct = cfgAcct;
    }
    return {
      identity: { key: `${acct.accountUuid}:${acct.organizationUuid || ''}`, email: acct.emailAddress || 'Claude account', plan: o.subscriptionType || '' },
      payload: { credentials: JSON.stringify(pick(cache.blob)), oauthAccount: acct },
    };
  },

  // Waits until it is known whose login is stored, so the account being left is saved correctly.
  async ready() {
    cache = null;
    try { const o = readBlob().claudeAiOauth; if (o?.accessToken) await owner(o); } catch {}
  },

  // Only the account's own entries are replaced; MCP sign-ins and anything else stay as they are.
  writeLive(payload) {
    const saved = JSON.parse(payload.credentials), blob = readBlob();
    for (const k of ACCOUNT_KEYS) { delete blob[k]; if (saved[k] !== undefined) blob[k] = saved[k]; }
    readConfig(true); // refuse before touching the keychain if the settings file cannot be read
    writeBlob(blob);
    setAccount(payload.oauthAccount);
    cache = null;
  },
  clearLive() {
    const blob = readBlob();
    for (const k of ACCOUNT_KEYS) delete blob[k];
    readConfig(true);
    writeBlob(blob);
    setAccount(null);
    cache = null;
  },

  async fetchUsage(payload, { active }) {
    let cur = payload, updated;
    const call = () => fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${oauth(cur.credentials).accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    let r = await call();
    if (r.status === 401) {
      // The signed-in account's tokens belong to Claude Code: renewing them here could sign a
      // running session out, so only pick up what Claude Code itself has already renewed.
      if (active) { const live = this.readLive(true); if (live) cur = live.payload; } else cur = updated = await renew(cur);
      r = await call();
      if (r.status === 401 && active) throw new Error('Claude Code needs to renew this login. Open Claude Code once, then refresh.');
    }
    if (!r.ok) throw new Error(`Claude usage request failed (HTTP ${r.status}).`);
    const j = await r.json();
    const meters = Object.entries(LABELS)
      .filter(([k]) => j[k] && typeof j[k].utilization === 'number')
      .map(([k, label]) => ({ label, usedPercent: j[k].utilization, resetsAt: j[k].resets_at ? Date.parse(j[k].resets_at) : null }));
    return { usage: { plan: oauth(cur.credentials).subscriptionType || '', meters, note: meters.length ? '' : 'No limits reported for this account.' }, payload: updated };
  },
};
