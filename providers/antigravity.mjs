// Antigravity: same storage style as Cursor. Usage comes from the editor's own local
// helper process, so it can only be read for the account that is signed in right now.
// EXPERIMENTAL: written from public notes about Antigravity's storage, not tested on an install.
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readKeys, writeKeys, text, editor } from '../lib/vscdb.mjs';

const app = editor({
  name: 'Antigravity', dataName: 'Antigravity', dbEnv: 'ANTIGRAVITY_DB',
  macApp: '/Applications/Antigravity.app', macBinary: '/Applications/Antigravity.app/Contents/MacOS/',
  winExe: 'Antigravity/Antigravity.exe', linuxNames: ['antigravity', 'Antigravity'],
});
const DB = app.dbPath;
const GLOBS = ['antigravityAuthStatus', 'antigravityUnifiedStateSync.oauthToken', 'antigravityUnifiedStateSync.userStatus', 'jetskiStateSync.agentManagerInitState'];

function post(port, csrf, method) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } });
    const req = https.request({
      host: '127.0.0.1', port, method: 'POST', rejectUnauthorized: false, timeout: 4000,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': csrf, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { res.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error('bad status')); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function userStatus() {
  if (process.platform === 'win32') throw new Error('Antigravity usage cannot be read on Windows yet.');
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const line = ps.split('\n').find((l) => /language_server/.test(l) && /antigravity/i.test(l));
  if (!line) throw new Error('Open Antigravity to read usage for the signed-in account.');
  const pid = line.trim().split(/\s+/)[0];
  const csrf = (line.match(/--csrf_token[= ](\S+)/) || [])[1] || '';
  let ports = [];
  try {
    ports = [...execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid], { encoding: 'utf8' }).matchAll(/:(\d+) \(LISTEN\)/g)].map((m) => Number(m[1]));
  } catch {}
  for (const port of new Set(ports)) {
    try { return await post(port, csrf, 'GetUserStatus'); } catch {}
  }
  throw new Error('Antigravity is open but its usage service did not answer.');
}

export default {
  id: 'antigravity',
  name: 'Antigravity',
  restart: true,
  appName: 'Antigravity',
  experimental: true,
  signInHint: 'Antigravity reopens signed out. Sign in there and the new account shows up here by itself.',

  detect() { return { installed: app.installed(), running: app.running() }; },

  readLive() {
    const payload = readKeys(DB, GLOBS);
    const tok = payload['antigravityUnifiedStateSync.oauthToken'] || payload['jetskiStateSync.agentManagerInitState'];
    if (!tok) return null;
    let st = {};
    try { st = JSON.parse(text(payload, 'antigravityAuthStatus')); } catch {}
    return {
      identity: {
        key: st.email || crypto.createHash('sha256').update(JSON.stringify(tok)).digest('hex').slice(0, 16),
        email: st.email || st.name || 'Antigravity account',
        plan: '',
      },
      payload,
    };
  },

  writeLive(payload) { writeKeys(DB, GLOBS, payload); },
  clearLive() { writeKeys(DB, GLOBS, {}); },
  quit: () => app.quit(),
  launch: () => app.launch(),

  async fetchUsage(_payload, { active }) {
    if (!active) throw new Error('Antigravity only reports usage for the signed-in account. Switch to this one to refresh it.');
    const us = (await userStatus()).userStatus || {};
    const meters = (us.cascadeModelConfigData?.clientModelConfigs || [])
      .filter((c) => c.quotaInfo)
      .map((c) => ({
        label: c.label || 'Model',
        usedPercent: 100 * (1 - (c.quotaInfo.remainingFraction ?? 0)),
        resetsAt: c.quotaInfo.resetTime ? Date.parse(c.quotaInfo.resetTime) : null,
      }));
    return { usage: { plan: us.planStatus?.planInfo?.planName || us.userTier?.name || '', meters, note: meters.length ? '' : 'Antigravity returned no quota figures.' } };
  },
};
