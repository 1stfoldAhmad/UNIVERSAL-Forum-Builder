<?php
/**
 * Real Laravel 13 integration check (CI only: PHP ^8.3 + laravel/framework ^13).
 * Boots a real Illuminate container + ServiceProvider, parses a real
 * Illuminate\Http\Request, and submits through the trusted handler. Proves the
 * renderer integrates with Laravel 13 on a real PHP toolchain (not PHP-WASM).
 *
 *   cd adapters/laravel && composer update && php tests/run-laravel13.php
 */
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Illuminate\Container\Container;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Facade;
use VdsForm\OperationRegistry;
use VdsForm\SimpleRbacEvaluator;
use VdsForm\TrustedSubmissionHandler;
use VdsForm\Renderer\RenderController;
use VdsForm\Renderer\Renderer;
use VdsForm\Renderer\VdsFormRendererServiceProvider;

$fail = 0;
function check(string $id, bool $ok, string $detail = ''): void { global $fail; if ($ok) { echo "  ok  $id\n"; } else { $fail++; fwrite(STDERR, "  FAIL $id" . ($detail ? " — $detail" : '') . "\n"); } }

// 1. Real Laravel 13 framework is present.
$version = \Illuminate\Foundation\Application::VERSION;
check('laravel.version-13', str_starts_with($version, '13.'), "got $version");
check('php.version-8.3+', PHP_VERSION_ID >= 80300, 'got ' . PHP_VERSION);

// 2. ServiceProvider registers against a real Illuminate container.
$app = new Container();
Facade::setFacadeApplication($app);
$provider = new VdsFormRendererServiceProvider($app);
$provider->register();
check('provider.binds-controller', $app->make(RenderController::class) instanceof RenderController);
check('provider.binds-alias', $app->make('vds-form.renderer') instanceof RenderController);

// 3. Render a real form to the shared HTML contract.
$ir = json_decode(file_get_contents(__DIR__ . '/../../../execution-adapters/laravel/tests/fixtures/ir/customer-registration.ir.json'), true, 512, JSON_THROW_ON_ERROR);
$html = Renderer::renderForm($ir, ['action' => '/forms/customer-registration']);
check('render.contract', str_contains($html, 'data-vds-form="customer-registration"'));

// 4. Submit through a REAL Illuminate Request + the trusted handler.
$records = [];
$ops = new OperationRegistry();
$ops->register('test:customer.create', function ($payload) use (&$records) { $records[] = $payload; return ['id' => 'C1']; });
$handler = new TrustedSubmissionHandler(['customer-registration' => $ir], $ops, new SimpleRbacEvaluator());
$ctrl = new RenderController(fn() => ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => ['customer:create']]);

$valid = ['customer' => ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'type' => 'individual', 'consent' => true]];
$request = Request::create('/forms/customer-registration?format=json', 'POST', [], [], [], [
    'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json',
], json_encode(['values' => $valid, 'idempotencyKey' => 'k1']));
$body = $request->json()->all();
$input = ['json' => true, 'values' => $body['values'] ?? [], 'idempotencyKey' => $body['idempotencyKey'] ?? '',
          'format' => $request->query('format', ''), 'accept' => $request->header('Accept', ''), 'correlationId' => ''];
[$status, $type, $respBody] = $ctrl->process('POST', $ir, $input, $request->user(), $handler);
check('submit.status-200', $status === 200, "got $status");
check('submit.succeeded', (json_decode($respBody, true)['status'] ?? '') === 'succeeded');
check('submit.persisted', count($records) === 1);

// 5. Permission denial with a real Request and no permissions.
$denied = new RenderController(fn() => ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => []]);
[$status2, , $resp2] = $denied->process('POST', $ir, ['json' => true, 'values' => $valid, 'idempotencyKey' => 'k2', 'format' => 'json'], $request->user(), $handler);
check('submit.denied-403', $status2 === 403, "got $status2");
check('submit.denied-no-record', count($records) === 1);

echo $fail === 0 ? "\nLARAVEL 13 INTEGRATION PASSED (real PHP " . PHP_VERSION . ", Laravel $version)\n" : "\n$fail CHECK(S) FAILED\n";
exit($fail === 0 ? 0 : 1);
