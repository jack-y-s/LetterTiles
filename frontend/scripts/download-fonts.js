const fs = require('fs');
const path = require('path');
const https = require('https');

// Downloads Inter woff2 files from Google Fonts CSS and saves to public/fonts
// Usage: node scripts/download-fonts.js

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) return reject(new Error('Failed to fetch ' + url + ' status ' + res.statusCode));
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
  });
}

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error('Failed to download ' + url + ' status ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  try {
    const family = 'Inter:wght@400;600;800';
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`;
    console.log('Fetching font CSS from', url);
    const css = await fetchText(url);
    const woff2Urls = new Set();
    // Match url(...) for .woff2 files
    const re = /url\((https:\/\/[^)]+\.woff2)\)/g;
    let m;
    while ((m = re.exec(css)) !== null) {
      if (m[1]) woff2Urls.add(m[1]);
    }
    if (woff2Urls.size === 0) {
      console.log('No woff2 urls found; aborting.');
      return;
    }
    const publicFonts = path.resolve(__dirname, '..', 'public', 'fonts');
    if (!fs.existsSync(publicFonts)) fs.mkdirSync(publicFonts, { recursive: true });
    for (const url of woff2Urls) {
      const name = path.basename(url.split('?')[0]);
      const dest = path.join(publicFonts, name);
      if (fs.existsSync(dest)) {
        console.log('Already have', name);
        continue;
      }
      console.log('Downloading', url, '->', dest);
      await download(url, dest);
    }
    // Write a local fonts.css referencing the downloaded files.
    const fontFiles = Array.from(woff2Urls).map(u => ({ url: u, file: path.basename(u.split('?')[0]) }));
    const fontsCssPath = path.resolve(__dirname, '..', 'public', 'fonts.css');
    const fontFace = fontFiles.map((f) => {
      // Try to extract weight from the URL (wght= or wght@), fallback to 400
      let w = '400';
      const m1 = /wght=(\d+)/.exec(f.url);
      const m2 = /wght@(\d+)/.exec(f.url);
      if (m1 && m1[1]) w = m1[1];
      else if (m2 && m2[1]) w = m2[1];
      return `@font-face { font-family: 'Inter'; font-style: normal; font-weight: ${w}; font-display: swap; src: url('/fonts/${f.file}') format('woff2'); }`;
    }).join('\n');
    fs.writeFileSync(fontsCssPath, `/* Auto-generated fonts.css */\n${fontFace}\n`);
    console.log('Wrote', fontsCssPath);
  } catch (e) {
    console.error('download-fonts failed', e);
    process.exitCode = 1;
  }
})();
