/**
 * Local PHP-WASM runner for the Laravel renderer suite (PHP 8.2). Optional
 * convenience; CI verifies the same suite on real PHP 8.3 with Laravel 13.
 *   npm install --no-save @php-wasm/node
 *   node adapters/laravel/tests/run-wasm.mjs
 */
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime, useHostFilesystem } from '@php-wasm/node';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const php = new PHP(await loadNodeRuntime('8.2', { emscriptenOptions: { processId: 1 } }));
useHostFilesystem(php);
const res = await php.cli(['php', join(here, 'run-renderer.php')], { cwd: here, env: {} });
const [out, err, code] = await Promise.all([res.stdoutText, res.stderrText, res.exitCode]);
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
process.exit(code);
