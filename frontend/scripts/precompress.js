const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Precompress files in dist (brotli + gzip)
const DIST = path.join(__dirname, '..', 'dist');
const compressExtensions = ['.js', '.css', '.html', '.svg', '.json', '.txt'];

function walk(dir, cb) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function shouldCompress(file) {
  const ext = path.extname(file).toLowerCase();
  return compressExtensions.includes(ext);
}

if (!fs.existsSync(DIST)) {
  console.log('No dist folder found, skipping precompress.');
  process.exit(0);
}

walk(DIST, (file) => {
  if (!shouldCompress(file)) return;
  const data = fs.readFileSync(file);
  // gzip
  try {
    const gz = zlib.gzipSync(data, { level: zlib.constants.Z_BEST_COMPRESSION });
    fs.writeFileSync(file + '.gz', gz);
    console.log('Wrote', file + '.gz');
  } catch (e) { console.error('gzip failed', file, e); }
  // brotli
  try {
    if (zlib.brotliCompressSync) {
      const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
      fs.writeFileSync(file + '.br', br);
      console.log('Wrote', file + '.br');
    }
  } catch (e) { console.error('brotli failed', file, e); }
});
