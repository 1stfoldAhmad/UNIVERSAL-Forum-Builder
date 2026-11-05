/**
 * Generates the machine-readable capability mirrors for the NATIVE renderers
 * from checked-in JSON, and for the TS renderers from their real exported
 * manifests. Native mirrors are asserted equal to the language-native manifest
 * by each platform's own test suite (CI), so this file never invents support.
 *
 * Usage: node scripts/gen-capability-mirrors.mjs [--check]
 *   --check : fail if a TS-derived mirror is out of date (CI guard).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'specifications', 'capabilities');
mkdirSync(outDir, { recursive: true });

const check = process.argv.includes('--check');
const targets = ['react', 'vue', 'angular', 'expo', 'node'];
let drift = [];

for (const t of targets) {
  const mod = await import(join(root, 'adapters', t, 'src', 'capabilities.ts'));
  const manifest = Object.values(mod).find((v) => v && typeof v === 'object' && v.target === t);
  if (!manifest) throw new Error(`no manifest exported for ${t}`);
  const file = join(outDir, `${t}.json`);
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== json) drift.push(t);
  } else {
    writeFileSync(file, json);
    console.log(`wrote specifications/capabilities/${t}.json`);
  }
}

if (check && drift.length) {
  console.error(`Capability mirrors out of date for: ${drift.join(', ')}. Run: npm run capabilities`);
  process.exit(1);
}
if (check) console.log('TS capability mirrors are up to date.');
