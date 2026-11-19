// Claude desktop app (the same Anthropic account used on claude.ai and console.anthropic.com).
// The app is claude.ai in a window, so the login itself is the site's session cookie in the
// app's cookie store. config.json only holds what the app derives from it: the account's UUID
// and OAuth token caches. Swapping config.json alone does nothing — the app reopens, reads the
// cookie, and puts the old account straight back — so the deck moves the cookies and the
// config keys together. Both are encrypted by the app and are moved as opaque blobs; the deck
// never decrypts them to switch. Reading a friendly email and usage is optional and asks for
// the app's storage key (macOS shows a prompt you approve), like the Cursor column.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { writeSecret, HOME as DECK_HOME } from '../lib/store.mjs';

const OS = process.platform;
const MAC = OS === 'darwin';
const home = os.homedir();
const DATA = MAC ? path.join(home, 'Library/Application Support/Claude')
  : OS === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'Claude')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
const CONFIG = process.env.CLAUDE_DESKTOP_CONFIG || path.join(DATA, 'config.json');
const WEB_ROOT = process.env.CLAUDE_DESKTOP_DATA || DATA;
const MAC_APP = '/Applications/Claude.app';
const MAC_BIN = '/Applications/Claude.app/Contents/MacOS/Claude';
const MAC_HELPERS = '/Applications/Claude.app/Contents/Frameworks/';
const WIN_EXE = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'AnthropicClaude', 'claude.exe');
const LINUX_NAMES = ['claude-desktop', 'Claude', 'claude'];

// The account-bound keys in config.json, taken from how the app itself uses them:
// - lastKnownAccountUuid (plaintext): who the app expects. When it matches the account the
//   cookie signs in, the app keeps its token cache; when it does not, the app treats it as a
//   change of person, throws the cache away and revokes those tokens. So it must move with
//   the cookies.
// - oauth:tokenCacheV2 / oauth:tokenCache (encrypted): tokens for the Code tab and the rest,
//   stored per account. Newer app versions keep only the V2 one.
// - oauth:staleSessionLatch (encrypted): the app's note that this exact sign-in must be redone.
// Everything else the app keeps per person is already filed under the account's own id
// (sessions, plugins, trusted-device tokens, the device registry) and needs no moving, and
// oauth:everydayRevokeOwed is this computer's to-do list, not an account's, so it stays put.
const KEYS = ['oauth:tokenCache', 'oauth:tokenCacheV2', 'oauth:staleSessionLatch', 'lastKnownAccountUuid'];

// Cookies on the site's own hosts move with the account, except the few that belong to this
// computer rather than to a login (Cloudflare clearance, the device id).
const SITE = /(^|\.)claude\.(ai|com)$/;
const DEVICE_COOKIES = new Set(['cf_clearance', '__cf_bm', 'anthropic-device-id']);
const accountCookie = (host, name) => SITE.test(host) && !DEVICE_COOKIES.has(name);
const cookieDb = () => process.env.CLAUDE_DESKTOP_COOKIES
  || [path.join(DATA, 'Cookies'), path.join(DATA, 'Network', 'Cookies')].find((f) => fs.existsSync(f))
  || path.join(DATA, 'Cookies');

// Cookie timestamps are microseconds since 1601 and do not fit a JS number, so integers are
// read as BigInt and saved as strings.
const pack = (v) => (typeof v === 'bigint' ? { n: String(v) } : typeof v === 'string' ? { s: v } : typeof v === 'number' ? { f: v } : v == null ? {} : { b: Buffer.from(v).toString('base64') });
const unpack = (e) => ('n' in e ? BigInt(e.n) : 's' in e ? e.s : 'f' in e ? e.f : 'b' in e ? Buffer.from(e.b, 'base64') : null);
const chromeNow = () => BigInt(Date.now() + 11644473600000) * 1000n;

let cookieCache = null; // { stamp, saved }: the store is only reread when the file changes

// Returns the account's cookies as { cols, rows }, ready to be saved in a profile.
function readCookies(fresh) {
  const file = cookieDb();
  let st;
  try { st = fs.statSync(file); } catch { return { cols: [], rows: [] }; }
  const stamp = `${st.mtimeMs}:${st.size}`;
  if (!fresh && cookieCache?.stamp === stamp) return cookieCache.saved;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=4000');
    const q = db.prepare('SELECT * FROM cookies ORDER BY host_key, name, path, top_frame_site_key');
    q.setReadBigInts(true);
    const all = q.all().filter((r) => accountCookie(r.host_key, r.name));
    const cols = all.length ? Object.keys(all[0]) : [];
    cookieCache = { stamp, saved: { cols, rows: all.map((r) => cols.map((c) => pack(r[c]))) } };
    return cookieCache.saved;
  } catch {
    if (cookieCache) return cookieCache.saved; // the app was mid-write: keep the last good read
    throw new Error('The Claude app\'s sign-in store could not be read. Close the Claude app and try again.');
  } finally { db?.close(); }
}

// Replaces the account's cookies with the saved ones (or just removes them) in one transaction.
function writeCookies(saved) {
  const file = cookieDb();
  if (!fs.existsSync(file)) {
    if (saved?.rows.length) throw new Error('Open the Claude app once, then try again.');
    return;
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=8000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ?');
      for (const r of db.prepare('SELECT DISTINCT host_key, name FROM cookies').all()) if (accountCookie(r.host_key, r.name)) del.run(r.host_key, r.name);
      if (saved?.rows.length) {
        const have = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((c) => c.name));
        const use = saved.cols.map((c, i) => [c, i]).filter(([c]) => have.has(c));
        const ins = db.prepare(`INSERT OR REPLACE INTO cookies (${use.map(([c]) => c).join(', ')}) VALUES (${use.map(() => '?').join(', ')})`);
        for (const row of saved.rows) ins.run(...use.map(([, i]) => unpack(row[i])));
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`The saved Claude login could not be restored (${err.message}). Sign in to this account again.`);
    }
  } finally { db.close(); cookieCache = null; }
}

// The session cookie itself (still encrypted), used only to tell one sign-in from another.
function sessionOf(saved) {
  if (!saved?.rows?.length) return '';
  const name = saved.cols.indexOf('name'), val = saved.cols.indexOf('encrypted_value');
  return saved.rows.find((r) => r[name]?.s === 'sessionKey')?.[val]?.b || '';
}

// Claude Code inside the app records who is signed in. When that is this account, its email
// names the card without asking for the app's storage key.
let whoCache = null; // { stamp, account }
function knownEmail(uuid) {
  try {
    const file = path.join(home, '.claude.json'), stamp = fs.statSync(file).mtimeMs;
    if (whoCache?.stamp !== stamp) whoCache = { stamp, account: JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount || {} };
    return whoCache.account.accountUuid === uuid ? whoCache.account.emailAddress || '' : '';
  } catch { return ''; }
}

// True when the saved cookies hold a session that has not expired yet.
function hasSession(saved) {
  if (!saved?.rows?.length) return false;
  const name = saved.cols.indexOf('name'), exp = saved.cols.indexOf('expires_utc');
  const row = saved.rows.find((r) => r[name]?.s === 'sessionKey');
  return !!row && (exp < 0 || !row[exp]?.n || BigInt(row[exp].n) > chromeNow());
}
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

let aesKey = null; // kept in memory only, for this run of the deck

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; } };

function writeConfig(mut) {
  const cfg = readConfig();
  if (!cfg) throw new Error('Claude desktop app settings were not found.');
  mut(cfg);
  writeSecret(CONFIG, JSON.stringify(cfg));
}

function unlock() {
  return new Promise((resolve, reject) => {
    if (!MAC) return reject(new Error('Account emails and usage for the Claude app are only available on macOS for now.'));
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Claude Safe Storage'], { timeout: 120000 }, (err, out) => {
      if (err) return reject(new Error('macOS did not release the Claude app\'s storage key (the prompt was denied or timed out).'));
      aesKey = crypto.pbkdf2Sync(out.trim(), 'saltysalt', 1003, 16, 'sha1');
      resolve();
    });
  });
}

// Decrypts one of the app's encrypted values (Electron safeStorage, "v10" + AES-128-CBC).
function decrypt(b64) {
  if (!aesKey) throw new Error('locked');
  const raw = Buffer.from(b64, 'base64');
  if (raw.subarray(0, 3).toString() !== 'v10') return raw.toString('utf8');
  const d = crypto.createDecipheriv('aes-128-cbc', aesKey, Buffer.alloc(16, 0x20));
  return Buffer.concat([d.update(raw.subarray(3)), d.final()]).toString('utf8');
}

// Pulls whatever account details the token cache holds, without assuming an exact shape.
function details(cfg) {
  for (const k of ['oauth:tokenCacheV2', 'oauth:tokenCache']) {
    if (!cfg[k]) continue;
    try {
      const o = JSON.parse(decrypt(cfg[k]));
      const flat = JSON.stringify(o);
      const email = o.account?.email_address || o.account?.email || o.email_address || o.email || (flat.match(/"email[_a-z]*"\s*:\s*"([^"]+@[^"]+)"/) || [])[1] || '';
      const plan = o.account?.subscription_type || o.subscriptionType || o.plan || '';
      const access = o.access_token || o.accessToken || o.claudeAiOauth?.accessToken || '';
      return { email, plan, access };
    } catch {}
  }
  return {};
}

function pids() {
  try {
    if (MAC) return execFileSync('pgrep', ['-f', MAC_BIN], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
    if (OS === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return [...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
    }
    const found = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (!LINUX_NAMES.includes(fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim())) continue;
        if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=')) continue;
        found.push(Number(d));
      } catch {}
    }
    return found;
  } catch { return []; }
}

// The claude.ai page inside the app keeps its own copy of the signed-in account's data in the
// page's browser storage (conversations, projects, the account it last showed, Code-tab drafts).
// Left in place, the next account opens on top of the previous one's data: the window shows the
// wrong account and the page signs itself out. So each account gets its own copy, moved while
// the app is closed. An account with no copy yet starts with empty storage and the page fills it
// from the server, as after a fresh sign-in.
const WEB = ['Local Storage', 'IndexedDB', 'Session Storage'];
const PROFILE_ID = /^[a-f0-9]{12}$/;
const webCopy = (id) => path.join(DECK_HOME, 'claude-desktop-web', id);

function saveWeb(id) {
  if (!PROFILE_ID.test(id)) return;
  const dest = webCopy(id), tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  for (const d of WEB) {
    const src = path.join(WEB_ROOT, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, d), { recursive: true });
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

// Puts the account's own page storage in place (or empty storage). On any failure the storage
// that was there is put back, so a failed move never leaves the page with half of each.
function loadWeb(id) {
  const src = id && PROFILE_ID.test(id) ? webCopy(id) : null;
  const old = path.join(WEB_ROOT, '.account-deck-web-old');
  fs.rmSync(old, { recursive: true, force: true });
  fs.mkdirSync(old, { recursive: true });
  const moved = [];
  try {
    for (const d of WEB) {
      const live = path.join(WEB_ROOT, d);
      if (fs.existsSync(live)) { fs.renameSync(live, path.join(old, d)); moved.push(d); }
    }
    if (src && fs.existsSync(src)) {
      for (const d of WEB) {
        const s = path.join(src, d);
        if (fs.existsSync(s)) fs.cpSync(s, path.join(WEB_ROOT, d), { recursive: true });
      }
    }
  } catch (err) {
    for (const d of WEB) fs.rmSync(path.join(WEB_ROOT, d), { recursive: true, force: true });
    for (const d of moved) fs.renameSync(path.join(old, d), path.join(WEB_ROOT, d));
    fs.rmSync(old, { recursive: true, force: true });
    throw new Error(`The Claude app's page data could not be switched (${err.message}).`);
  }
  fs.rmSync(old, { recursive: true, force: true });
}

// The app's helper processes: the one that owns the cookie store outlives the main process briefly.
function helpers() {
  if (!MAC) return [];
  try { return execFileSync('pgrep', ['-f', MAC_HELPERS], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: 'claude-desktop',
  name: 'Claude',
  restart: true,
  appName: 'Claude',
  experimental: true,
  // This flag is read by the UI to add an extra warning: switching ends any Claude Code
  // session running inside the app, including the one that may have opened the deck.
  hostApp: true,
  signOutEnds: true,
  signInHint: 'The Claude app reopens signed out. Sign in there and the account shows up here by itself. Use this button instead of "Log out" inside the app, which can end the saved login.',
  needsSignInHint: 'This account was saved without its sign-in, so the Claude app cannot be switched to it yet. Use Sign in again, sign in to it once in the Claude app, and it is saved properly from then on.',

  detect() {
    const installed = MAC ? fs.existsSync(MAC_APP) : OS === 'win32' ? fs.existsSync(WIN_EXE) : fs.existsSync(DATA);
    return { installed: installed || fs.existsSync(CONFIG), running: pids().length > 0 };
  },

  usageLocked() { return MAC && !aesKey; },
  unlock,

  readLive(fresh) {
    const cfg = readConfig();
    const uuid = cfg?.lastKnownAccountUuid;
    if (!cfg || !uuid) return null;
    // Signed in means the session cookie is there. The token caches come and go between app
    // versions (and are re-made by the app when missing), so they do not decide it.
    const cookies = readCookies(fresh);
    if (!hasSession(cookies)) return null;
    const payload = { ...Object.fromEntries(KEYS.filter((k) => cfg[k] != null).map((k) => [k, cfg[k]])), cookies };
    let email = '', plan = '';
    if (aesKey) { const d = details(cfg); email = d.email; plan = d.plan; }
    email ||= knownEmail(uuid);
    return {
      identity: email ? { key: uuid, email, plan } : { key: uuid, email: `Claude account ••${uuid.slice(-4)}`, plan, unnamed: true },
      payload,
    };
  },

  sessionOf(payload) { return sessionOf(payload.cookies); },

  // A profile saved before the deck captured cookies has nothing to sign in with.
  needsSignIn(payload) { return !hasSession(payload.cookies); },

  // Called with the app closed, for the account being left: its page storage is kept with it.
  keepAside(profileId) { saveWeb(profileId); },
  forget(profileId) { if (PROFILE_ID.test(profileId)) fs.rmSync(webCopy(profileId), { recursive: true, force: true }); },

  // Cookies first: if they cannot be written nothing has changed, and the app stays as it was.
  writeLive(payload, profileId) {
    writeCookies(payload.cookies);
    writeConfig((cfg) => { for (const k of KEYS) { delete cfg[k]; if (payload[k] != null) cfg[k] = payload[k]; } });
    loadWeb(profileId);
  },
  // Only removed from this computer: the session stays valid, so the saved copy keeps working.
  // The next person starts with empty page storage, not the previous account's.
  clearLive() {
    writeCookies(null);
    writeConfig((cfg) => { for (const k of KEYS) delete cfg[k]; });
    loadWeb(null);
  },

  async quit() {
    const running = pids();
    if (!running.length) return false;
    if (OS === 'win32') { try { execFileSync('taskkill', ['/IM', 'claude.exe'], { stdio: 'ignore', windowsHide: true }); } catch {} }
    else for (const pid of running) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      if (!pids().length) {
        // Wait for the helpers too, so the cookie store is fully written and released.
        for (let j = 0; j < 40 && helpers().length; j++) await sleep(125);
        await sleep(300);
        return true;
      }
    }
    throw new Error('The Claude app did not close within 30 seconds. Close it yourself, then try again.');
  },

  launch() {
    const [cmd, args] = MAC ? ['open', ['-a', MAC_APP]] : OS === 'win32' ? [WIN_EXE, []] : [LINUX_NAMES[0], []];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  },

  async fetchUsage(payload, { active }) {
    if (!aesKey) throw new Error('Usage is locked. Use "Show usage" on the Claude (desktop) column first.');
    // Reconstruct a config-shaped object so details() can read this profile's saved caches.
    const { access, plan } = details(payload);
    // Usage for desktop-app logins isn't fetched: the app keeps that token in its own
    // encrypted session store, which the deck does not read. Accounts still switch.
    if (!access) return { usage: { plan, meters: [], note: 'Usage is not shown for Claude desktop accounts. Switching still works.' } };
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${access}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) throw new Error(active ? 'This login needs renewing. Open the Claude app, then refresh.' : 'The saved login has expired. Switch to this account once to renew it.');
    if (!r.ok) throw new Error(`Claude usage request failed (HTTP ${r.status}).`);
    const j = await r.json();
    const LABELS = { five_hour: '5-hour limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };
    const meters = Object.entries(LABELS)
      .filter(([k]) => j[k] && typeof j[k].utilization === 'number')
      .map(([k, label]) => ({ label, usedPercent: j[k].utilization, resetsAt: j[k].resets_at ? Date.parse(j[k].resets_at) : null }));
    return { usage: { plan, meters, note: meters.length ? '' : 'No limits reported for this account.' } };
  },
};
