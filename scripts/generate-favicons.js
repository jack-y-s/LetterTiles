const sharp = require('sharp');
const pngToIcoRaw = require('png-to-ico');
const pngToIco = (pngToIcoRaw && pngToIcoRaw.default) ? pngToIcoRaw.default : pngToIcoRaw;
const fs = require('fs');

const input = 'frontend/public/Logo.png';
const out = 'frontend/public';

async function run() {
  await sharp(input).resize(16,16).png().toFile(`${out}/favicon-16.png`);
  await sharp(input).resize(32,32).png().toFile(`${out}/favicon-32.png`);
  await sharp(input).resize(48,48).png().toFile(`${out}/favicon-48.png`);
  await sharp(input).resize(180,180).png().toFile(`${out}/apple-touch-icon.png`);
  await sharp(input).resize(192,192).png().toFile(`${out}/android-chrome-192x192.png`);
  await sharp(input).resize(512,512).png().toFile(`${out}/android-chrome-512x512.png`);

  const buf = await pngToIco([
    `${out}/favicon-16.png`,
    `${out}/favicon-32.png`,
    `${out}/favicon-48.png`
  ]);
  fs.writeFileSync(`${out}/favicon.ico`, buf);
  console.log('Favicons generated in', out);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
