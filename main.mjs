// Desktop shell: a menu bar / system tray icon whose menu lists every saved account
// (click one to switch), plus a window showing the full deck.
import { app, Tray, Menu, BrowserWindow, Notification, nativeImage, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, state, routes, PROVIDERS, store } from './server.mjs';

const MAC = process.platform === 'darwin';
let tray = null, win = null, port = 0, lastMenu = '', working = false, known = null;
const unlockTried = new Map();

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => openWindow());
app.on('window-all-closed', () => {}); // keep living in the tray

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
  if (process.platform !== 'linux') {
    items.push({ label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) });
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
  port = await start();
  tray = new Tray(trayIcon());
  tray.setToolTip('Account Deck');
  refreshMenu();
  setInterval(refreshMenu, 5000);
  setTimeout(refreshUsage, 3000);
  setInterval(refreshUsage, 45000);
  if (!app.getLoginItemSettings().wasOpenedAtLogin) openWindow();
  console.log(`Account Deck running: tray ready, page on port ${port}`);
});
