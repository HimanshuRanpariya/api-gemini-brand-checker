#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const dist = path.join(root, 'dist');
const entries = ['index.js', 'package.json', 'controllers', 'routes', 'utils', 'README.md'];

async function copyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const items = await fs.promises.readdir(src, { withFileTypes: true });
  for (const item of items) {
    const srcPath = path.join(src, item.name);
    const destPath = path.join(dest, item.name);
    if (item.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (item.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

(async () => {
  try {
    await fs.promises.rm(dist, { recursive: true, force: true });
    await fs.promises.mkdir(dist, { recursive: true });

    for (const e of entries) {
      const srcPath = path.join(root, e);
      if (!fs.existsSync(srcPath)) continue;
      const stat = await fs.promises.stat(srcPath);
      const destPath = path.join(dist, e);
      if (stat.isDirectory()) {
        await copyDir(srcPath, destPath);
      } else if (stat.isFile()) {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }

    console.log('Build completed — files copied to dist/');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
})();
