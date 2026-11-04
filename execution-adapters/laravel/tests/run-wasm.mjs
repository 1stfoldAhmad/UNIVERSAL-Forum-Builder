/**
 * Local PHP-WASM test runner for the Laravel/PHP adapter.
 *
 * The Arena sandbox has no native PHP, so this runs the PHP test suites under
 * @php-wasm/node (PHP 8.2, WebAssembly). It is a LOCAL verification convenience:
 *
 *   npm install --no-save --no-audit --no-fund @php-wasm/node
 *   node execution-adapters/laravel/tests/run-wasm.mjs
 *
 * @php-wasm/node is GPL-2.0 and is intentionally NOT a committed dependency.
 * CI verifies the same suites with a real PHP toolchain (shivammathur/setup-php),
 * so this script is optional and never required by the build.
 *
 * Each PHP suite runs in a fresh PHP instance (cli() is single-use). The process
 * exits with a non-zero code if any suite fails.
 */
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime, useHostFilesystem } from '@php-wasm/node';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const all = [
  'run-conformance.php',
  'run-form-conformance.php',
  'run-idempotency-parity.php',
  'run-submission.php',
  'run-controller.php',
  'run-security.php',
  'run-security-policy.php',
  'run-remediation.php',
  'run-operation-limits.php',
  'run-idempotency-recovery.php',
];
const requested = process.argv.slice(2);
const suites = requested.length ? requested : all;

let failures = 0;
for (const suite of suites) {
  const file = join(here, suite.endsWith('.php') ? suite : `${suite}.php`);
  const php = new PHP(await loadNodeRuntime('8.2', { emscriptenOptions: { processId: 1 } }));
  useHostFilesystem(php);
  try {
    // Forward VDS_* flags (e.g. VDS_REQUIRE_ILLUMINATE) so local runs can mirror CI.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VDS_')));
    const res = await php.cli(['php', file], { cwd: here, env });
    const [out, err, code] = await Promise.all([res.stdoutText, res.stderrText, res.exitCode]);
    if (out) process.stdout.write(out);
    if (err) process.stderr.write(err);
    if (code !== 0) failures++;
  } catch (e) {
    failures++;
    process.stderr.write(`ERROR running ${suite}: ${e?.stack ?? e}\n`);
  }
}

console.log(failures === 0 ? '\nALL PHP SUITES PASSED (WASM)' : `\n${failures} PHP SUITE(S) FAILED (WASM)`);
process.exit(failures === 0 ? 0 : 1);
