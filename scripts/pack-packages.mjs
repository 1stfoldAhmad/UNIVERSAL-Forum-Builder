#!/usr/bin/env node
/**
 * Stage release-ready package directories and npm tarballs under .release/.
 * Rewrites exports/main/types to dist/ and pins internal @vds-form/* dependency
 * versions to the workspace manifests. DOES NOT PUBLISH. Run build-packages first.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function workspaceDirs() {
  const dirs = [];
  for (const base of ['packages', 'adapters', 'integrations', 'tools']) {
    const abs = join(root, base);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const dir = join(abs, name);
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  dirs.push(join(root, 'execution-adapters', 'node'));
  return dirs.filter((d) => !d.endsWith(join('integrations', 'vds-logic')) && existsSync(join(d, 'src', 'index.ts')));
}

const dirs = workspaceDirs();
const versions = new Map();
for (const dir of dirs) {
  const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  versions.set(m.name, m.version);
}

const tarballs = {};
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!existsSync(join(dir, 'dist', 'index.js'))) throw new Error(`${manifest.name}: dist missing; run npm run build:packages`);
  const stage = join(out, manifest.name.replace('@', '').replace('/', '-'));
  mkdirSync(stage, { recursive: true });
  cpSync(join(dir, 'dist'), join(stage, 'dist'), { recursive: true });
  const deps = { ...(manifest.dependencies ?? {}) };
  for (const [name, ver] of Object.entries(deps)) {
    if (versions.has(name)) deps[name] = versions.get(name);
  }
  const packed = {
    ...manifest,
    dependencies: deps,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' },
      './package.json': './package.json',
    },
    files: ['dist'],
    scripts: {},
  };
  if (packed.bin) {
    // CLI bin is built to dist/bin.js by the package build.
    packed.bin = Object.fromEntries(Object.entries(packed.bin).map(([k]) => [k, './dist/bin.js']));
  }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(packed, null, 2));
  for (const f of ['README.md', 'LICENSE']) if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));
  const r = spawnSync('npm', ['pack', '--pack-destination', out], { cwd: stage, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm pack failed for ${manifest.name}: ${r.stdout}\n${r.stderr}`);
  const tgz = r.stdout.trim().split('\n').pop();
  tarballs[manifest.name] = join(out, tgz);
  console.log(`packed ${manifest.name} -> ${tgz}`);
}
writeFileSync(join(out, 'tarballs.json'), JSON.stringify(tarballs, null, 2));
