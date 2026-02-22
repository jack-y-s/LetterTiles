const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Attempt to subset woff2 fonts using pyftsubset (fonttools).
// Falls back cleanly if pyftsubset is not available.

const publicFonts = path.resolve(__dirname, '..', 'public', 'fonts');
if (!fs.existsSync(publicFonts)) {
  console.log('No fonts directory found at', publicFonts, '- skipping subsetting.');
  process.exit(0);
}

const files = fs.readdirSync(publicFonts).filter(f => f.toLowerCase().endsWith('.woff2'));
if (files.length === 0) {
  console.log('No .woff2 files found in', publicFonts, '- skipping subsetting.');
  process.exit(0);
}

// Basic unicode range: Basic Latin + Latin-1 Supplement + punctuation + digits
const unicodes = 'U+0020-00FF';

function runSubset(src, dest, cb) {
  const args = [src, `--flavor=woff2`, `--output-file=${dest}`, `--unicodes=${unicodes}`, `--recommended-glyphs`];
  execFile('pyftsubset', args, (err, stdout, stderr) => {
    if (err) return cb(err, stdout, stderr);
    return cb(null, stdout, stderr);
  });
}

(async () => {
  for (const file of files) {
    const src = path.join(publicFonts, file);
    const base = path.basename(file, '.woff2');
    const dest = path.join(publicFonts, `${base}.subset.woff2`);
    if (fs.existsSync(dest)) {
      console.log('Subset already exists for', file);
      continue;
    }
    try {
      console.log('Attempting to subset', file);
      await new Promise((resolve, reject) => runSubset(src, dest, (err, out, errout) => {
        if (err) return reject(err);
        resolve();
      }));
      console.log('Wrote subset:', dest);
    } catch (e) {
      console.warn('pyftsubset not available or failed; skipping subsetting for', file);
      console.warn('Install fonttools (pip install fonttools) to enable subsetting.');
      // Stop attempting further; subsetting is optional
      process.exit(0);
    }
  }
})();
