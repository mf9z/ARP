'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];

const VIEWBOX = '170.5 44.5 250 250';

function buildLogo() {
  const source = fs.readFileSync(path.join(root, 'assets', 'ardp.svg'), 'utf8');
  const paths = [...source.matchAll(/<path d="([^"]+)" fill="(#[0-9a-fA-F]{6})"/g)].map((m) => ({ d: m[1], fill: m[2].toLowerCase() }));
  const byFill = (fill) => {
    const found = paths.find((p) => p.fill === fill);
    if (!found) throw new Error(`assets/ardp.svg has no ${fill} path`);
    return found.d;
  };
  const blue = byFill('#03aeee');
  const ink = byFill('#282121');
  const orange = byFill('#ea8a38');
  const glint = byFill('#ffffff');
  // the first sub-path is the outline: filled white it gives the belly and the sticker edge
  const silhouette = ink.slice(0, ink.indexOf('Z') + 1);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="250" height="250">`,
    `<path d="${blue}" fill="#03aeee"/>`,
    `<path d="${silhouette}" fill="#ffffff" stroke="#ffffff" stroke-width="9" stroke-linejoin="round"/>`,
    `<path d="${ink}" fill="#282121" fill-rule="evenodd"/>`,
    `<path d="${orange}" fill="#ea8a38" fill-rule="evenodd"/>`,
    `<path d="${glint}" fill="#ffffff" fill-rule="evenodd"/>`,
    '</svg>',
    '',
  ].join('\n');
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const svg = buildLogo();
    fs.writeFileSync(path.join(root, 'src', 'app', 'ui', 'logo.svg'), svg);

    const out = path.join(root, 'assets', 'icons');
    fs.mkdirSync(out, { recursive: true });

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('about:blank');
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    for (const size of SIZES) {
      const png = await win.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = ${JSON.stringify(url)};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(img, 0, 0, ${size}, ${size});
        return c.toDataURL('image/png');
      })()`);
      fs.writeFileSync(path.join(out, `icon-${size}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    console.log(`wrote logo.svg and ${SIZES.length} icons`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
