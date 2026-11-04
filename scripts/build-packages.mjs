#!/usr/bin/env node
/**
 * Real package build pipeline: emits ESM JavaScript + TypeScript declarations
 * into each publishable workspace's dist/. Workspace development continues to
 * resolve source via package exports; packed release artifacts rewrite exports
 * to dist/ (see pack-packages.mjs). No publishing happens here.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

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
  // vds-logic depends on a vendored file: dependency and is not packable as-is.
  return dirs.filter((d) => !d.endsWith(join('integrations', 'vds-logic')) && existsSync(join(d, 'src', 'index.ts')));
}

function verifyPeers(manifest, dir) {
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const deps = manifest.dependencies ?? {};
  for (const p of peers) {
    if (deps[p]) throw new Error(`${dir}: peer dependency ${p} must not also be a direct dependency`);
  }
  return peers;
}

function postProcessDist(dir, manifest) {
  // Post-emit fixups: JSON assets live inside the package, and Node ESM needs
  // explicit .js extensions on relative import/export specifiers.
  const dist = join(dir, 'dist');
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (existsSync(p) && readdirSync(dirname(p)).includes(name) && name !== '.' && name !== '..') {
        // recurse into directories
        try {
          if (readdirSync(p).length >= 0 && !name.includes('.')) { walk(p); continue; }
        } catch { /* file */ }
      }
      if (name.endsWith('.js') || name.endsWith('.d.ts')) {
        let s = readFileSync(p, 'utf8');
        if (manifest.name === '@vds-form/spec') s = s.replaceAll('../../../specifications/json-schema/vds-form-1.0.0.schema.json', './schema.json');
        if (manifest.name === '@vds-form/conformance') s = s.replaceAll('../fixtures/', './fixtures/');
        s = s.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (m, a, spec, b) => extname(spec) ? m : `${a}${spec}.js${b}`);
        if (name.endsWith('.js')) s = s.replace(/from\s+(['"][^'"]+\.json['"])\s*;/g, 'from $1 with { type: "json" };');
        writeFileSync(p, s);
      }
    }
  };
  walk(dist);
}

let failed = false;
for (const dir of workspaceDirs()) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const peers = verifyPeers(manifest, dir);
  const dist = join(dir, 'dist');
  const buildOut = join(dir, '.build');
  rmSync(dist, { recursive: true, force: true });
  rmSync(buildOut, { recursive: true, force: true });
  const rel = relative(root, dir);
  const tsconfig = {
    extends: join(root, 'tsconfig.json'),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: buildOut,
      rootDir: root,
      composite: false,
      typeRoots: [join(root, 'node_modules', '@types')],
    },
    include: [join(dir, 'src', '**/*')],
    exclude: ['**/tests/**', '**/*.test.*'],
  };
  const cfgPath = join(dir, 'tsconfig.build.tmp.json');
  writeFileSync(cfgPath, JSON.stringify(tsconfig, null, 2));
  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: root, encoding: 'utf8' });
  rmSync(cfgPath, { force: true });
  if (r.status !== 0) {
    failed = true;
    console.error(`BUILD FAILED ${manifest.name}\n${r.stdout}\n${r.stderr}`);
    rmSync(buildOut, { recursive: true, force: true });
    continue;
  }
  mkdirSync(dist, { recursive: true });
  const srcOut = join(buildOut, rel, 'src');
  cpSync(srcOut, dist, { recursive: true });
  if (manifest.name === '@vds-form/spec') {
    cpSync(join(root, 'specifications', 'json-schema', 'vds-form-1.0.0.schema.json'), join(dist, 'schema.json'));
  }
  if (manifest.name === '@vds-form/conformance') {
    cpSync(join(dir, 'fixtures'), join(dist, 'fixtures'), { recursive: true });
  }
  postProcessDist(dir, manifest);
  rmSync(buildOut, { recursive: true, force: true });
  console.log(`built ${manifest.name}${peers.length ? ` (peers: ${peers.join(', ')})` : ''}`);
}
process.exit(failed ? 1 : 0);
