// Helpers for VS Code-style editors (Cursor, Antigravity): their login lives in a few
// rows of state.vscdb, and the app has to be closed while those rows are swapped.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OS = process.platform;
const enc = (v) => (typeof v === 'string' ? { s: v } : { b: Buffer.from(v).toString('base64') });
const dec = (e) => ('s' in e ? e.s : Buffer.from(e.b, 'base64'));

// `stays(key)` marks rows that match a glob but belong to the computer, not to the account:
// they are neither saved nor replaced nor removed.
export function readKeys(dbPath, globs, stays = () => false) {
  if (!fs.existsSync(dbPath)) return {};
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=4000');
    const out = {};
    const q = db.prepare('SELECT key, value FROM ItemTable WHERE key GLOB ?');
    for (const g of globs) for (const r of q.all(g)) if (r.value != null && !stays(r.key)) out[r.key] = enc(r.value);
    return out;
  } finally { db.close(); }
}

// Replaces every row matching `globs` with `entries` in one transaction.
export function writeKeys(dbPath, globs, entries, stays = () => false) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=8000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const find = db.prepare('SELECT key FROM ItemTable WHERE key GLOB ?');
      const del = db.prepare('DELETE FROM ItemTable WHERE key = ?');
      for (const g of globs) for (const r of find.all(g)) if (!stays(r.key)) del.run(r.key);
      const ins = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
      for (const [k, e] of Object.entries(entries)) if (!stays(k)) ins.run(k, dec(e));
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  } finally { db.close(); }
}

export const text = (entries, key) => (entries[key] && 's' in entries[key] ? entries[key].s : '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Describes one editor on the current operating system: where its data is and how to
// tell whether it is open, close it politely, and open it again.
// def: { name, dataName, macApp, macBinary, winExe (under %LOCALAPPDATA%\Programs), linuxNames, dbEnv }
export function editor(def) {
  const home = os.homedir();
  const dataDir = OS === 'darwin' ? path.join(home, 'Library/Application Support', def.dataName)
    : OS === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), def.dataName)
    : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), def.dataName);
  const dbPath = process.env[def.dbEnv] || path.join(dataDir, 'User/globalStorage/state.vscdb');
  const winExe = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs', def.winExe);
  const image = path.basename(def.winExe);
  let relaunch = null; // Linux: the exact program that was running, so the same one is reopened

  function pids() {
    try {
      if (OS === 'darwin') return execFileSync('pgrep', ['-f', def.macBinary], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
      if (OS === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return [...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
      }
      const found = [];
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          if (!def.linuxNames.includes(fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim())) continue;
          if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('--type=')) continue; // helper process
          found.push(Number(d));
        } catch {}
      }
      return found;
    } catch { return []; }
  }

  return {
    dbPath,
    installed: () => (OS === 'darwin' ? fs.existsSync(def.macApp) : OS === 'win32' ? fs.existsSync(winExe) : fs.existsSync(dataDir)),
    running: () => pids().length > 0,

    // Asks the app to close normally and waits. Never force-kills: if it stays open
    // (for example a dialog is blocking), the caller gets an error and nothing is changed.
    async quit() {
      const running = pids();
      if (!running.length) return false;
      if (OS === 'linux') {
        try {
          const env = fs.readFileSync(`/proc/${running[0]}/environ`, 'utf8').split('\0').find((e) => e.startsWith('APPIMAGE='));
          relaunch = env ? env.slice(9) : fs.readlinkSync(`/proc/${running[0]}/exe`);
        } catch {}
      }
      if (OS === 'win32') { try { execFileSync('taskkill', ['/IM', image], { stdio: 'ignore', windowsHide: true }); } catch {} }
      else for (const pid of running) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      for (let i = 0; i < 150; i++) {
        await sleep(200);
        if (!pids().length) { await sleep(500); return true; }
      }
      throw new Error(`${def.name} did not close within 30 seconds. Close it yourself, then try again.`);
    },

    launch() {
      const [cmd, args] = OS === 'darwin' ? ['open', ['-a', def.macApp]] : OS === 'win32' ? [winExe, []] : [relaunch || def.linuxNames[0], []];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    },
  };
}
