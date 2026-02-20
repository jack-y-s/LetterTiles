#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'spawn-command', 'lib', 'spawn-command.js');
try {
  if (!fs.existsSync(target)) {
    console.log('[postinstall-patch] spawn-command not present, skipping.');
    process.exit(0);
  }
  let src = fs.readFileSync(target, 'utf8');
  if (!/util\._extend\(\{\},\s*options\)/.test(src)) {
    console.log('[postinstall-patch] no util._extend found, nothing to do.');
    process.exit(0);
  }
  const patched = src.replace(/util\._extend\(\{\},\s*options\)/g, 'Object.assign({}, options)');
  fs.writeFileSync(target, patched, 'utf8');
  console.log('[postinstall-patch] patched spawn-command to replace util._extend.');
} catch (e) {
  console.error('[postinstall-patch] failed to apply patch:', e);
  process.exit(1);
}
