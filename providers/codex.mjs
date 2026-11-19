// Codex CLI: the whole login is ~/.codex/auth.json, so switching is swapping that file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { writeSecret } from '../lib/store.mjs';
import { editor } from '../lib/vscdb.mjs';

const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AUTH = path.join(HOME, 'auth.json');
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const jwt = (t) => {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
};

function identity(auth) {
  const t = auth.tokens;
  if (t?.id_token || t?.access_token) {
    const p = jwt(t.id_token || t.access_token);
    const a = p['https://api.openai.com/auth'] || {};
    const account = t.account_id || a.chatgpt_account_id || '';
    return { key: `${account}:${p.email || ''}`, email: p.email || 'ChatGPT account', plan: a.chatgpt_plan_type || '' };
  }
  if (auth.OPENAI_API_KEY) {
    const k = auth.OPENAI_API_KEY;
    return { key: 'key:' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 16), email: `API key ••••${k.slice(-4)}`, plan: 'api key' };
  }
  return null;
}

async function refresh(auth) {
  const r = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: auth.tokens.refresh_token, scope: 'openid profile email' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('Login expired. Switch to this account and run `codex login` again.');
  const j = await r.json();
  return { ...auth, tokens: { ...auth.tokens, ...Object.fromEntries(['id_token', 'access_token', 'refresh_token'].filter((k) => j[k]).map((k) => [k, j[k]])) }, last_refresh: new Date().toISOString() };
}

const windowName = (s) => (s === 18000 ? '5-hour limit' : s === 604800 ? 'Weekly limit' : s ? `${Math.round(s / 3600)}-hour limit` : 'Limit');

export default {
  id: 'codex',
  name: 'Codex',
  // The ChatGPT desktop app (bundle com.openai.codex) reads this login when it starts, so
  // switching closes and reopens it, the same way Cursor and Claude do.
  restart: true,
  desktopApp: editor({
    name: 'ChatGPT', dataName: 'com.openai.codex', dbEnv: 'CODEX_DESKTOP_DB',
    macApp: '/Applications/ChatGPT.app', macBinary: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    winExe: 'ChatGPT/ChatGPT.exe', linuxNames: ['chatgpt', 'ChatGPT'],
  }),
  signInHint: 'Codex sign-in is opening in your browser. The new account shows up here once you finish.',

  // Starts `codex login` after Add account. It opens the browser itself; the new login is
  // saved by the deck as soon as the auth file is written. Runs through a login shell so
  // the app finds codex on the same PATH as the user's terminal.
  quit() { return this.desktopApp.quit(); },
  launch() { this.desktopApp.launch(); },

  // True when the codex command can be run from a login shell (the same PATH as a terminal).
  canLogin() {
    try {
      const shell = process.platform === 'win32' ? null : (process.env.SHELL || '/bin/zsh');
      if (!shell) { execFileSync('where', ['codex'], { stdio: 'ignore', windowsHide: true }); return true; }
      return !!execFileSync(shell, ['-lc', 'command -v codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return false; }
  },

  startLogin() {
    const shell = process.platform === 'win32' ? null : (process.env.SHELL || '/bin/zsh');
    const child = shell
      ? spawn(shell, ['-lc', 'codex login'], { detached: true, stdio: 'ignore' })
      : spawn('cmd', ['/c', 'codex', 'login'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  },

  detect() {
    const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => ['codex', 'codex.cmd', 'codex.exe'].some((f) => fs.existsSync(path.join(d, f))));
    return { installed: fs.existsSync(HOME) || onPath, running: this.desktopApp.running() };
  },

  readLive() {
    let auth;
    try { auth = JSON.parse(fs.readFileSync(AUTH, 'utf8')); } catch { return null; }
    const id = identity(auth);
    return id ? { identity: id, payload: auth } : null;
  },

  writeLive(payload) {
    fs.mkdirSync(HOME, { recursive: true });
    writeSecret(AUTH, JSON.stringify(payload, null, 2));
  },

  clearLive() { fs.rmSync(AUTH, { force: true }); },

  async fetchUsage(payload) {
    if (!payload.tokens?.access_token) return { usage: { note: 'Usage is not available for API-key logins.' } };
    let auth = payload, updated;
    const call = () => fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        authorization: `Bearer ${auth.tokens.access_token}`,
        accept: 'application/json',
        'user-agent': 'codex-cli',
        ...(auth.tokens.account_id ? { 'chatgpt-account-id': auth.tokens.account_id } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    let r = await call();
    if (r.status === 401 && auth.tokens.refresh_token) { auth = updated = await refresh(auth); r = await call(); }
    if (!r.ok) throw new Error(`Codex usage request failed (HTTP ${r.status}).`);
    const j = await r.json();
    const meters = [];
    for (const k of ['primary_window', 'secondary_window']) {
      const w = j.rate_limit?.[k];
      if (w && typeof w.used_percent === 'number') {
        meters.push({ label: windowName(w.limit_window_seconds), usedPercent: w.used_percent, resetsAt: w.reset_at ? w.reset_at * 1000 : null });
      }
    }
    const bal = j.credits?.balance;
    return {
      usage: { plan: j.plan_type || '', meters, note: bal != null && Number(bal) > 0 ? `Credits: ${bal}` : meters.length ? '' : 'No limits reported for this account.' },
      payload: updated,
    };
  },
};
