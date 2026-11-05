/**
 * Generates docs/PLATFORM_SUPPORT_MATRIX.md from the REAL capability manifests
 * (specifications/capabilities/*.json) plus the CI workflow configuration.
 *
 * Nothing here is hand-asserted: every cell is derived from a manifest that the
 * owning renderer's own test suite verifies. Native mirrors are asserted equal
 * to the Dart/Kotlin/Swift manifests by their test suites; TS mirrors are
 * generated from the exported manifests and guarded by --check.
 *
 * Usage: node scripts/gen-support-matrix.mjs [--check]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const capDir = join(root, 'specifications', 'capabilities');
const OUT = join(root, 'docs', 'PLATFORM_SUPPORT_MATRIX.md');

const ORDER = ['react', 'vue', 'angular', 'expo', 'node', 'flutter', 'compose', 'swiftui'];
const manifests = new Map();
for (const f of readdirSync(capDir).filter((f) => f.endsWith('.json'))) {
  const m = JSON.parse(readFileSync(join(capDir, f), 'utf8'));
  manifests.set(m.target, m);
}
const targets = ORDER.filter((t) => manifests.has(t));

const LAYOUTS = ['section', 'group', 'row', 'columns', 'tabs', 'tab', 'accordion', 'steps', 'step', 'fieldset', 'summary', 'repeater', 'divider', 'text'];
const FEATURES = [
  ['multiStep', 'Multi-step wizards'],
  ['repeaters', 'Repeaters'],
  ['localization', 'Localization'],
  ['accessibility', 'Accessibility semantics'],
  ['filePicker', 'File / image selection'],
  ['camera', 'Camera capture'],
  ['barcode', 'Barcode scanning'],
  ['signature', 'Signature capture'],
  ['richText', 'Rich text'],
  ['dragDrop', 'Drag & drop upload'],
  ['draftPersistence', 'Draft persistence'],
  ['offlineQueue', 'Offline queue'],
  ['uploadProgress', 'Upload progress'],
  ['uploadCancel', 'Upload cancellation'],
  ['submissionGuard', 'Single active submission'],
];

const ICON = {
  'supported': '✅',
  'partial': '🟡',
  'unsupported': '—',
  'requires-host-adapter': '🔌',
};

function fieldStatus(m, type) {
  const explicit = m.fieldStatus?.[type];
  if (explicit) return explicit;
  const cap = m.fieldTypes?.[type];
  if (!cap) return { status: 'unsupported', reason: 'Not in this renderer’s field set.' };
  return cap.supported === false
    ? { status: 'unsupported', reason: 'Declared unsupported by the field capability.' }
    : { status: 'supported' };
}

function featureStatus(m, key) {
  if (m.featureStatus?.[key]) return m.featureStatus[key];
  const b = m.features?.[key];
  if (b === undefined) return { status: 'unsupported', reason: 'Not declared.' };
  return b ? { status: 'supported' } : { status: 'unsupported' };
}

function layoutStatus(m, node) {
  return m.layoutStatus?.[node] ?? { status: 'partial', reason: 'No explicit layout status declared.' };
}

const ALL_FIELDS = [...new Set(targets.flatMap((t) => Object.keys(manifests.get(t).fieldTypes ?? {})))];
// Include fields that only appear in fieldStatus (e.g. signature on natives).
for (const t of targets) for (const f of Object.keys(manifests.get(t).fieldStatus ?? {})) if (!ALL_FIELDS.includes(f)) ALL_FIELDS.push(f);
ALL_FIELDS.sort();

const lines = [];
const push = (s = '') => lines.push(s);

push('# Platform support matrix');
push();
push('> **Generated file — do not edit by hand.**');
push('> Regenerate with `npm run support-matrix`; CI fails if it is out of date (`npm run support-matrix:check`).');
push();
push('Every cell below is derived from a renderer capability manifest in');
push('`specifications/capabilities/*.json`. Those manifests are verified against the');
push('renderers themselves: TypeScript mirrors are generated from the exported');
push('manifests, and the Dart/Kotlin/Swift manifests are asserted equal to their');
push('mirrors by each platform’s own test suite. **No equivalence is claimed by hand.**');
push();
push('## Legend');
push();
push('| Symbol | Status | Meaning |');
push('| --- | --- | --- |');
push('| ✅ | Supported | Implemented, wired, tested and usable as-is. |');
push('| 🟡 | Partial | Works with the documented limitation in the manifest. |');
push('| 🔌 | Requires host adapter | Renderer code exists; a host-injected adapter is required before use. |');
push('| — | Unsupported | Not implemented on this target. |');
push();
push('A capability is never marked ✅ merely because an interface exists or the code compiles.');
push();

push('## Field types');
push();
push(`| Field | ${targets.map((t) => `\`${t}\``).join(' | ')} |`);
push(`| --- | ${targets.map(() => '---').join(' | ')} |`);
for (const f of ALL_FIELDS) {
  push(`| \`${f}\` | ${targets.map((t) => ICON[fieldStatus(manifests.get(t), f).status] ?? '?').join(' | ')} |`);
}
push();

push('## Layout nodes (all 14 canonical types)');
push();
push(`| Layout node | ${targets.map((t) => `\`${t}\``).join(' | ')} |`);
push(`| --- | ${targets.map(() => '---').join(' | ')} |`);
for (const n of LAYOUTS) {
  push(`| \`${n}\` | ${targets.map((t) => ICON[layoutStatus(manifests.get(t), n).status] ?? '?').join(' | ')} |`);
}
push();

push('## Features');
push();
push(`| Feature | ${targets.map((t) => `\`${t}\``).join(' | ')} |`);
push(`| --- | ${targets.map(() => '---').join(' | ')} |`);
for (const [key, label] of FEATURES) {
  push(`| ${label} | ${targets.map((t) => ICON[featureStatus(manifests.get(t), key).status] ?? '?').join(' | ')} |`);
}
push();

push('## Required host adapters');
push();
push('These are the injection points a host application must supply. Nothing here is');
push('bundled, and none of it is a production VDS service — supply your own.');
push();
for (const t of targets) {
  const m = manifests.get(t);
  const rows = [];
  for (const [k, v] of Object.entries(m.featureStatus ?? {})) {
    if (v.status === 'requires-host-adapter') rows.push(`| ${k} | ${(v.requires ?? []).map((r) => `\`${r}\``).join(', ') || '—'} | ${v.reason ?? ''} |`);
  }
  if (!rows.length) continue;
  push(`### \`${t}\``);
  push();
  push('| Capability | Required adapter(s) | Note |');
  push('| --- | --- | --- |');
  rows.forEach((r) => push(r));
  push();
}

push('## Documented limitations (partial / unsupported)');
push();
push('| Target | Capability | Status | Reason |');
push('| --- | --- | --- | --- |');
for (const t of targets) {
  const m = manifests.get(t);
  const seen = new Set();
  const add = (name, d) => {
    if (!d || d.status === 'supported' || d.status === 'requires-host-adapter') return;
    const key = `${name}:${d.status}`;
    if (seen.has(key)) return;
    seen.add(key);
    push(`| \`${t}\` | ${name} | ${d.status} | ${d.reason ?? '—'} |`);
  };
  for (const [k, v] of Object.entries(m.featureStatus ?? {})) add(k, v);
  for (const [k, v] of Object.entries(m.fieldStatus ?? {})) add(`field \`${k}\``, v);
  for (const [k, v] of Object.entries(m.layoutStatus ?? {})) add(`layout \`${k}\``, v);
}
push();

push('## CI verification');
push();
push('Version combinations below are read from `.github/workflows/ci.yml`. A row');
push('describes what CI is **configured to run**; the pass/fail result of a specific');
push('run is recorded in `docs/audit/FINAL_COMPLETION_AUDIT_2026.md` with its run id.');
push();
const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const jobBlocks = [];
{
  // Parse only the `jobs:` mapping — the `on:` block also has 2-space keys.
  const jobsIdx = ci.indexOf('\njobs:\n');
  const body = jobsIdx >= 0 ? ci.slice(jobsIdx + '\njobs:\n'.length) : ci;
  const marks = [...body.matchAll(/^  ([a-z0-9-]+):$/gm)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    jobBlocks.push(body.slice(m.index + 2, end));
  });
}
push('| Job | Runner | Matrix |');
push('| --- | --- | --- |');
for (const block of jobBlocks) {
  const name = block.match(/^([a-z0-9-]+):/)?.[1];
  if (!name) continue;
  const runner = block.match(/runs-on:\s*(\S+)/)?.[1] ?? '—';
  const simple = block.match(/^\s+(node|php|python|package):\s*\[([^\]]+)\]/m);
  let matrix = 'single configuration';
  if (simple) matrix = `${simple[1]}: ${simple[2].replace(/'/g, '').replace(/\s+/g, ' ')}`;
  else if (/include:/.test(block)) {
    const pairs = [...block.matchAll(/django:\s*'([^']+)',\s*python:\s*'([^']+)'/g)];
    if (pairs.length) {
      const byDjango = new Map();
      for (const p of pairs) {
        if (!byDjango.has(p[1])) byDjango.set(p[1], []);
        byDjango.get(p[1]).push(p[2]);
      }
      matrix = [...byDjango].map(([d, ps]) => `Django ${d} × Python ${ps.join(', ')}`).join('; ');
    }
  }
  push(`| \`${name}\` | ${runner} | ${matrix} |`);
}
push();

push('## Packaging evidence');
push();
push('| Target | Artifact | CI step | Published? |');
push('| --- | --- | --- | --- |');
push('| TypeScript packages | JS + `.d.ts`, npm tarballs | `typescript` → build/pack/fresh-install smoke | **No** |');
push('| Python (execution + renderer) | wheel + sdist | `packaging` → build + fresh-venv install | **No** |');
push('| PHP / Laravel | Composer package | `laravel`, `laravel13` → `composer validate` + fresh consumer install | **No** |');
push('| Flutter | pub package | `flutter` → `pub publish --dry-run` | **No** |');
push('| Compose | `core.jar` + UI AAR | `compose` → `:core:jar :ui:assembleRelease` | **No** |');
push('| SwiftUI | SwiftPM targets | `swiftui` → `swift build` + `package describe` | **No** |');
push();
push('Local builds are packaging evidence, **not** a production-readiness claim.');
push();

push('## Physical-device verification');
push();
push('**Status: pending.** No physical iOS or Android device verification has been');
push('performed. Camera capture, native pickers, permission prompts, real-lifecycle');
push('uploads, restart durability and offline transitions remain to be verified on');
push('device by the host application. Automated tests use injected fake adapters and');
push('never claim device behaviour.');
push();

const out = lines.join('\n');
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== out) {
    console.error('docs/PLATFORM_SUPPORT_MATRIX.md is out of date. Run: npm run support-matrix');
    process.exit(1);
  }
  console.log('Support matrix is up to date.');
} else {
  writeFileSync(OUT, out);
  console.log(`wrote docs/PLATFORM_SUPPORT_MATRIX.md (${targets.length} targets, ${ALL_FIELDS.length} field types)`);
}
