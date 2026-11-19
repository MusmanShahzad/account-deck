// Writes the Account Deck logo as SVG: the full app icon, and a one-colour mark for the menu bar.
// Run: node assets/make-logo.mjs   (then: npx electron assets/render-icons.cjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const f = (n) => Math.round(n * 100) / 100;

// A circular "switch" arrow pair inside a circle of radius r, centred at 0,0.
function swapArrows(r, width) {
  const pt = (deg, rad) => [f(Math.cos((deg * Math.PI) / 180) * rad), f(Math.sin((deg * Math.PI) / 180) * rad)];
  const arc = (from, to) => {
    const [x1, y1] = pt(from, r), [x2, y2] = pt(to, r);
    const dir = ((to + 90) * Math.PI) / 180; // travel direction at the end of a clockwise arc
    const [dx, dy] = [Math.cos(dir), Math.sin(dir)], [px, py] = [-dy, dx];
    const head = width * 1.35, len = width * 1.6;
    const tip = [f(x2 + dx * len * 0.55), f(y2 + dy * len * 0.55)];
    const b1 = [f(x2 - dx * len * 0.45 + px * head), f(y2 - dy * len * 0.45 + py * head)];
    const b2 = [f(x2 - dx * len * 0.45 - px * head), f(y2 - dy * len * 0.45 - py * head)];
    return `<path d="M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}" fill="none" stroke="#fff" stroke-width="${width}" stroke-linecap="round"/>` +
      `<path d="M${tip[0]} ${tip[1]}L${b1[0]} ${b1[1]}L${b2[0]} ${b2[1]}Z" fill="#fff" stroke="#fff" stroke-width="${f(width * 0.35)}" stroke-linejoin="round"/>`;
  };
  return arc(205, 318) + arc(25, 138);
}

const card = (w, h, rx) => `x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${rx}"`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a2620"/><stop offset=".5" stop-color="#171512"/><stop offset="1" stop-color="#0b0a08"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ede5d3" stop-opacity=".10"/><stop offset=".45" stop-color="#ede5d3" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="badge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f07a50"/><stop offset="1" stop-color="#c9431f"/>
    </linearGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4ecdb"/><stop offset="1" stop-color="#e2d7c0"/>
    </linearGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000" flood-opacity=".55"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#shine)"/>
  <rect x="122" y="122" width="780" height="780" rx="166" fill="none" stroke="#ede5d3" stroke-opacity=".12" stroke-width="3"/>
  <g transform="translate(560 420) rotate(11)"><rect ${card(430, 300, 46)} fill="none" stroke="#ede5d3" stroke-opacity=".5" stroke-width="10"/></g>
  <g transform="translate(476 548) rotate(-7)" filter="url(#drop)">
    <rect ${card(450, 314, 48)} fill="url(#face)"/>
    <circle cx="-128" cy="-34" r="58" fill="#171512"/>
    <circle cx="-128" cy="-52" r="20" fill="#f4ecdb"/>
    <path d="M-164 -6a36 30 0 0 1 72 0z" fill="#f4ecdb"/>
    <rect x="-46" y="-66" width="214" height="30" rx="15" fill="#171512"/>
    <rect x="-46" y="-10" width="150" height="24" rx="12" fill="#b3a68d"/>
    <rect x="-186" y="74" width="372" height="14" rx="7" fill="#cfc3aa"/>
    <rect x="-186" y="74" width="236" height="14" rx="7" fill="#e5582f"/>
  </g>
  <g transform="translate(722 716)" filter="url(#drop)">
    <circle r="112" fill="url(#badge)"/>
    <circle r="112" fill="none" stroke="#0d0c0a" stroke-width="16"/>
    ${swapArrows(54, 20)}
  </g>
</svg>
`;

// Menu bar mark: the same two cards, one colour, on a 32 px grid (macOS tints it).
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs><mask id="m"><rect width="32" height="32" fill="#fff"/>
    <g transform="translate(14 19.5) rotate(-7)"><circle cx="-4.4" cy="0" r="3" fill="#000"/><rect x="0.4" y="-1.25" width="6.6" height="2.5" rx="1.25" fill="#000"/></g>
  </mask></defs>
  <g transform="translate(18 11.5) rotate(11)"><rect ${card(19, 13.5, 3)} fill="none" stroke="#000" stroke-width="2.4"/></g>
  <g mask="url(#m)"><g transform="translate(14 19.5) rotate(-7)"><rect ${card(21, 14.5, 3.2)} fill="#000"/></g></g>
</svg>
`;

fs.writeFileSync(path.join(dir, 'logo.svg'), icon);
fs.writeFileSync(path.join(dir, 'tray.svg'), tray);
console.log('wrote assets/logo.svg and assets/tray.svg');
