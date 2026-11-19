// Renders the SVG logo to every PNG the app needs with Electron's own renderer, then builds
// the macOS .icns with iconutil. Each SVG is drawn once at 1024 px and scaled down from there.
// Run: npx electron assets/render-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const A = __dirname, B = path.join(A, '..', 'build'), N = 1024;

function draw(win, svgFile) {
  return new Promise((resolve, reject) => {
    const svg = fs.readFileSync(path.join(A, svgFile), 'utf8');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-icon-')), 'page.html');
    fs.writeFileSync(file, `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${N}px;height:${N}px}</style></head><body>${svg}</body></html>`);
    const wc = win.webContents;
    let loaded = false;
    const onPaint = (_e, _dirty, image) => {
      if (!loaded || image.isEmpty() || image.getSize().width < N) return;
      wc.off('paint', onPaint);
      resolve(image);
    };
    wc.on('paint', onPaint);
    wc.once('did-finish-load', () => { loaded = true; setTimeout(() => wc.invalidate(), 200); });
    win.loadFile(file).catch(() => {});
    setTimeout(() => reject(new Error('render timed out: ' + svgFile)), 20000);
  });
}

const save = (img, size, out) => fs.writeFileSync(out, (img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' })).toPNG());

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: N, height: N, show: false, frame: false, transparent: true, useContentSize: true,
      webPreferences: { offscreen: { deviceScaleFactor: 1 }, backgroundThrottling: false } });
    win.webContents.setFrameRate(30);
    const logo = await draw(win, 'logo.svg');
    const tray = await draw(win, 'tray.svg');
    win.destroy();
    fs.mkdirSync(B, { recursive: true });
    const set = path.join(B, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) { save(logo, s, path.join(set, `icon_${s}x${s}.png`)); save(logo, s * 2, path.join(set, `icon_${s}x${s}@2x.png`)); }
    save(logo, N, path.join(B, 'icon.png'));          // Windows and Linux installers
    save(logo, 256, path.join(A, 'icon-256.png'));     // window icon on Windows and Linux
    save(logo, 64, path.join(A, 'icon-64.png'));       // notifications, tray on Windows and Linux
    save(tray, 16, path.join(A, 'trayTemplate.png'));  // macOS menu bar
    save(tray, 32, path.join(A, 'trayTemplate@2x.png'));
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(B, 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
    console.log('rendered all icons');
    app.exit(0); setTimeout(() => process.exit(0), 500);
  } catch (e) { console.error(e); app.exit(1); setTimeout(() => process.exit(1), 500); }
});
