const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://storage.ko-fi.com/cdn/fullLogoKofi.png';
const outPath = path.join(__dirname, '..', 'public', 'kofi.png');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error('Failed to fetch logo: ' + res.statusCode));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

fs.mkdir(path.dirname(outPath), { recursive: true }, (err) => {
  if (err) throw err;
  download(url, outPath).then(() => console.log('Saved Ko-fi logo to', outPath)).catch((e) => {
    console.error('Failed to download Ko-fi logo:', e.message);
    process.exit(1);
  });
});
