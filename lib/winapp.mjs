// Windows helpers: apps installed from the Microsoft Store (MSIX), closing apps that keep
// running in the tray when their window closes, and files that Windows keeps locked.
import { execFileSync, spawn } from 'node:child_process';

export const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script, timeout = 15000) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'ignore'] });

// The Start menu's id for an app, whichever way it was installed. Store apps have no fixed
// .exe to run; they are opened through this id. Cached: found ids for the whole run, a miss
// for ten minutes, so a missing app does not mean a PowerShell call on every refresh.
const appIds = new Map();
export function startMenuAppId(name) {
  if (!WIN) return '';
  const c = appIds.get(name);
  if (c && (c.id || Date.now() - c.at < 600000)) return c.id;
  let id = '';
  try { id = ps(`Get-StartApps | Where-Object { $_.Name -eq '${name.replace(/'/g, "''")}' } | Select-Object -First 1 -ExpandProperty AppID`).trim(); } catch {}
  appIds.set(name, { id, at: Date.now() });
  return id;
}

// Opens an app by its .exe when there is one, otherwise by its Start menu id.
export function launchWindowsApp(exe, startMenuName, exists) {
  const child = exe && exists(exe)
    ? spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    : (() => {
      const id = startMenuAppId(startMenuName);
      if (!id) throw new Error(`${startMenuName} could not be found to reopen it. Open it yourself.`);
      return spawn('explorer.exe', [`shell:AppsFolder\\${id}`], { detached: true, stdio: 'ignore' });
    })();
  child.on('error', () => {});
  child.unref();
}

// Running processes with this file name, with their full paths, so two programs that share a
// name (the Claude app and the Claude Code CLI are both claude.exe) can be told apart.
// tasklist is fast; a process's path is looked up with PowerShell once, when it first appears.
const known = new Map(); // image -> Map(pid -> path)
export function windowsProcesses(image) {
  if (!WIN) return [];
  if (!known.has(image)) known.set(image, new Map());
  const paths = known.get(image);
  let pids;
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    pids = [...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
  } catch { return []; }
  const unknown = pids.filter((pid) => !paths.has(pid));
  if (unknown.length) {
    try {
      const found = parseProcessList(ps(`Get-CimInstance Win32_Process -Filter "${unknown.map((pid) => `ProcessId=${pid}`).join(' OR ')}" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.ExecutablePath)" }`, 10000));
      for (const p of found) paths.set(p.pid, p.path);
    } catch {}
  }
  for (const pid of [...paths.keys()]) if (!pids.includes(pid)) paths.delete(pid); // Windows reuses ids
  return pids.map((pid) => ({ pid, path: paths.get(pid) || '' }));
}

export function parseProcessList(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [pid, parent, ...rest] = l.split('|');
    return { pid: Number(pid), parent: Number(parent), path: rest.join('|') };
  }).filter((p) => p.pid > 0);
}

// Asks the processes to close the way the window's close button would. An app that only hides
// to the tray then gets ended outright after `forceAfterMs` (0: never). Forcing skips the app's
// last save, so it is kept for apps whose login is already on disk well before they close.
export async function closeWindowsProcesses(list, still, { forceAfterMs = 0, limitMs = 30000 } = {}) {
  const ids = (l) => l.flatMap((p) => ['/PID', String(p.pid)]);
  try { execFileSync('taskkill', ids(list), { stdio: 'ignore', windowsHide: true }); } catch {}
  const t0 = Date.now();
  let forced = false;
  while (Date.now() - t0 < limitMs) {
    await sleep(250);
    const left = still();
    if (!left.length) { await sleep(500); return true; } // let Windows release the files
    if (forceAfterMs && !forced && Date.now() - t0 > forceAfterMs) {
      forced = true;
      try { execFileSync('taskkill', [...ids(left), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }
  }
  return false;
}

// Runs fn again for a short while when Windows reports the file as in use by another program
// (an editor, an antivirus scan, Claude Code reading its settings). Elsewhere it runs once.
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = new Int32Array(new SharedArrayBuffer(4));
export function retryLocked(fn, tries = WIN ? 25 : 0) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !LOCKED.has(e.code)) throw e;
      Atomics.wait(pause, 0, 0, 80 + i * 20);
    }
  }
}
