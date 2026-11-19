// Desktop shell: a menu bar / system tray icon whose menu lists every saved account
// (click one to switch), plus a window showing the full deck.
import { app, Tray, Menu, BrowserWindow, Notification, nativeImage, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { start, state, routes, PROVIDERS, store } from './server.mjs';

const MAC = process.platform === 'darwin';
let tray = null, win = null, port = 0, lastMenu = '', working = false, known = null;
const unlockTried = new Map();

// A short log in ~/.account-deck/deck.log, kept under 200 KB, for finding start-up problems.
const LOG = path.join(store.HOME, 'deck.log');
function log(...parts) {
  try {
    fs.mkdirSync(store.HOME, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200000) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {}
}
process.on('uncaughtException', (e) => log('uncaught:', e?.stack || e));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e?.stack || e));
log('launch', JSON.stringify(process.argv.slice(1)));

if (!app.requestSingleInstanceLock()) { log('another copy is running; quitting'); app.quit(); }
// Started at login: stay in the menu bar instead of opening the window. Windows marks that
// with a --hidden argument. macOS and Linux use an environment variable, because the packaged
// Mac app does not start at all when launched with an extra argument.
const HIDDEN = '--hidden';
const HIDDEN_ENV = 'ACCOUNT_DECK_HIDDEN';
app.on('second-instance', (_e, argv) => { if (!argv.includes(HIDDEN)) openWindow(); });
app.on('window-all-closed', () => {}); // keep living in the tray

// Start at login. macOS gets a per-user LaunchAgent, which (unlike the system login-item
// switch) can tell the app it was started at login, so the deck starts quietly in the menu bar.
// Linux gets an XDG autostart entry. Windows uses its own login items with --hidden.
const LINUX = process.platform === 'linux';
const AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'local.accountdeck.app.plist');
const AUTOSTART = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'account-deck.desktop');
const program = () => (LINUX && process.env.APPIMAGE) || process.execPath;
const xml = (v) => v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const agentFor = (exe) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.accountdeck.app</string>
  <key>ProgramArguments</key><array><string>${xml(exe)}</string></array>
  <key>EnvironmentVariables</key><dict><key>${HIDDEN_ENV}</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
`;

function startsAtLogin() {
  if (MAC) return fs.existsSync(AGENT);
  if (LINUX) return fs.existsSync(AUTOSTART);
  return app.getLoginItemSettings({ args: [HIDDEN] }).openAtLogin;
}

function setStartsAtLogin(on) {
  try {
    if (MAC) {
      if (!on) return fs.rmSync(AGENT, { force: true });
      fs.mkdirSync(path.dirname(AGENT), { recursive: true });
      return fs.writeFileSync(AGENT, agentFor(program()));
    }
    if (LINUX) {
      if (!on) return fs.rmSync(AUTOSTART, { force: true });
      fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
      return fs.writeFileSync(AUTOSTART, `[Desktop Entry]\nType=Application\nName=Account Deck\nExec=env ${HIDDEN_ENV}=1 "${program()}"\nX-GNOME-Autostart-enabled=true\n`);
    }
    app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] });
  } catch (e) {
    dialog.showMessageBox({ type: 'error', message: 'Could not change Start at login', detail: e.message });
  }
}

// Keeps the login entry pointing at this copy of the app (after a move to Applications, say),
// and carries over a login item made by an earlier version through the system switch.
function tidyLoginItem() {
  if (MAC && app.getLoginItemSettings().openAtLogin) { app.setLoginItemSettings({ openAtLogin: false }); setStartsAtLogin(true); }
  if (MAC && startsAtLogin()) {
    try { if (fs.readFileSync(AGENT, 'utf8') !== agentFor(program())) setStartsAtLogin(true); } catch {}
  }
}

// A copy opened straight from a download asks once to move itself into Applications, so the
// login entry and macOS's permissions stay attached to one stable place.
async function offerMove() {
  if (!MAC || !app.isPackaged || app.isInApplicationsFolder()) return;
  const asked = path.join(store.HOME, '.asked-to-move');
  if (fs.existsSync(asked)) return;
  const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Move to Applications', 'Not now'], defaultId: 0, cancelId: 1, message: 'Move Account Deck to your Applications folder?', detail: 'It then keeps working from one place, including when it starts at login.' });
  try { fs.mkdirSync(store.HOME, { recursive: true }); fs.writeFileSync(asked, ''); } catch {}
  if (response === 0) { try { app.moveToApplicationsFolder(); } catch (e) { dialog.showMessageBox({ type: 'error', message: 'Could not move Account Deck', detail: e.message }); } }
}

// The logo, drawn from assets/logo.svg by assets/render-icons.cjs. On macOS the menu bar gets the
// one-colour mark (a template image, so macOS tints it for light and dark menu bars); elsewhere
// the tray shows the full-colour logo.
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const LOGO = path.join(ASSETS, 'icon-256.png');
function trayIcon() {
  if (MAC) {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'icon-64.png')).resize({ width: 16, height: 16, quality: 'best' });
}

function openWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({ width: 1180, height: 760, minWidth: 380, minHeight: 420, title: 'Account Deck', autoHideMenuBar: true, ...(MAC ? {} : { icon: LOGO }) });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.on('closed', () => { win = null; });
}

const usageText = (u) => (u?.meters?.length ? '   ' + u.meters.map((m) => `${Math.round(m.usedPercent)}%`).join(' / ') : '');

async function switchTo(p, a) {
  if (working) return;
  const name = a.label || a.email;
  // The menu ticks whatever was clicked by itself, so it is redrawn on every way out of here.
  const redraw = () => refreshMenu((lastMenu = ''));
  if (a.needsSignIn) { redraw(); return addAccount(p, a); }
  if (p.restart && p.running) {
    const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Switch', 'Cancel'], defaultId: 0, cancelId: 1, message: `Switch ${p.name} to ${name}?`, detail: p.hostApp ? `${p.name} will close and reopen. Any Claude Code session inside it will end.` : `${p.name} will close and reopen.` });
    if (response !== 0) return redraw();
  }
  working = true;
  try {
    const prof = store.get(p.id, a.id);
    if (!prof) throw new Error('That account is no longer saved.');
    await routes.switch(PROVIDERS[p.id], prof);
    await routes.usage(PROVIDERS[p.id], store.get(p.id, a.id)).catch(() => {});
  } catch (e) {
    dialog.showMessageBox({ type: 'error', message: `Could not switch ${p.name}`, detail: e.message });
  } finally { working = false; redraw(); }
}

// Signs the tool out on this computer only, so another account can sign in. The account being
// left stays saved and still works, which signing out inside the tool itself does not promise.
async function addAccount(p, again) {
  if (working) return;
  const who = again ? again.label || again.email : '';
  const { response } = await dialog.showMessageBox({ type: 'question', buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1, message: again ? `Sign in to ${p.name} as ${who} again?` : `Add another ${p.name} account?`, detail: `${p.name} is signed out on this computer so you can sign in with another account. The current account stays saved.${p.restart && p.running ? ` ${p.name} will close and reopen.` : ''}${p.hostApp && p.running ? ' Any Claude Code session inside it will end.' : ''}` });
  if (response !== 0) return;
  working = true;
  try {
    const { hint } = await routes.signout(PROVIDERS[p.id]);
    dialog.showMessageBox({ type: 'info', message: again ? `Now sign in to ${p.name} as ${who}` : `Sign in to ${p.name}`, detail: hint });
  } catch (e) {
    dialog.showMessageBox({ type: 'error', message: `Could not sign ${p.name} out`, detail: e.message });
  } finally { working = false; refreshMenu((lastMenu = '')); }
}

function refreshMenu() {
  let providers;
  try { providers = state(); } catch { return; }
  // Says so when a sign-in is picked up by itself, since nothing else on screen changes.
  const ids = new Set(providers.flatMap((p) => p.profiles.map((a) => `${p.id}/${a.id}`)));
  if (known && Notification.isSupported()) {
    for (const p of providers) for (const a of p.profiles) {
      if (!known.has(`${p.id}/${a.id}`)) new Notification({ title: `${p.name} account saved`, body: `${a.label || a.email} is ready to switch to.`, ...(MAC ? {} : { icon: LOGO }) }).show();
    }
  }
  known = ids;
  const key = JSON.stringify(providers.map((p) => [p.id, p.installed, p.running, p.busy, p.profiles.map((a) => [a.id, a.label, a.email, a.active, a.needsSignIn, usageText(a.usage)])]));
  if (key === lastMenu) return;
  lastMenu = key;
  const items = [];
  for (const p of providers.filter((x) => x.installed || x.profiles.length)) {
    items.push({ label: p.name, enabled: false });
    if (!p.profiles.length) items.push({ label: '   No accounts yet', enabled: false });
    for (const a of p.profiles) {
      items.push({ label: (a.label || a.email) + (a.needsSignIn ? '   (sign in again)' : usageText(a.usage)), type: 'checkbox', checked: a.active, enabled: !p.busy, click: () => (a.active ? refreshMenu((lastMenu = '')) : switchTo(p, a)) });
    }
    if (p.installed) items.push({ label: '   Add account…', enabled: !p.busy, click: () => addAccount(p) });
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Open Account Deck', click: openWindow });
  {
    items.push({ label: 'Start at login', type: 'checkbox', checked: startsAtLogin(), click: (i) => { setStartsAtLogin(i.checked); refreshMenu((lastMenu = '')); } });
  }
  items.push({ type: 'separator' }, { label: 'Quit Account Deck', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// Keeps usage figures fresh while the window is closed (each account at most every 10 minutes).
async function refreshUsage() {
  const jobs = [];
  for (const p of Object.values(PROVIDERS)) {
    const live = (() => { try { return p.readLive(); } catch { return null; } })();
    for (const prof of store.list(p.id)) {
      const active = live?.identity.key === prof.identity.key;
      if ((p.id === 'antigravity' || p.id === 'claude-desktop') && !active) continue;
      if (p.usageLocked?.(prof.payload)) {
        const t = unlockTried.get(p.id) || 0;
        if (Date.now() - t < 600000) continue;
        unlockTried.set(p.id, Date.now());
        try { await p.unlock(); } catch { continue; }
      }
      if (prof.usage?.fetchedAt && Date.now() - prof.usage.fetchedAt < 60000) continue;
      jobs.push(routes.usage(p, prof).catch(() => {}));
    }
  }
  await Promise.all(jobs); // refresh every account concurrently
  refreshMenu();
}

app.whenReady().then(async () => {
  if (MAC) app.dock?.hide();
  app.setAboutPanelOptions({ applicationName: 'Account Deck', iconPath: LOGO });
  log('ready');
  port = await start();
  log('page on port', port);
  tray = new Tray(trayIcon());
  tray.setToolTip('Account Deck');
  refreshMenu();
  setInterval(refreshMenu, 5000);
  setTimeout(refreshUsage, 3000);
  setInterval(refreshUsage, 45000);
  tidyLoginItem();
  const atLogin = process.argv.includes(HIDDEN) || process.env[HIDDEN_ENV] === '1' || app.getLoginItemSettings().wasOpenedAtLogin;
  delete process.env[HIDDEN_ENV]; // so apps the deck reopens do not inherit it
  if (!atLogin) { openWindow(); offerMove(); }
  console.log(`Account Deck running: tray ready, page on port ${port}`);
});
