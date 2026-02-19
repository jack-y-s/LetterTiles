const sharp = require('sharp');
const fs = require('fs');

const input = 'frontend/public/Logo.png';
const outDir = 'frontend/public';
const sizes = [64, 128, 256, 512];

async function makeTransparentSized(w) {
  const outPath = `${outDir}/logo-${w}x${w}.png`;
  // If the source already has an alpha channel, just resize and preserve transparency.
  const meta = await sharp(input).metadata();
  if (meta.hasAlpha) {
    await sharp(input)
      .resize(w, w, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log('Wrote (preserved alpha)', outPath);
    return;
  }

  // Otherwise, attempt to remove a near-white background by thresholding.
  const resized = await sharp(input)
    .resize(w, w, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();

  const mask = await sharp(resized)
    .grayscale()
    .threshold(240)
    .negate()
    .png()
    .toBuffer();

  await sharp(resized)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log('Wrote', outPath);
}

async function run() {
  if (!fs.existsSync(input)) {
    console.error('Input not found:', input);
    process.exit(1);
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const s of sizes) {
    await makeTransparentSized(s);
  }

  console.log('Done generating raster logos.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
