<?php
/**
 * REAL Laravel 13 full-lifecycle integration suite.
 *
 * CI only: PHP ^8.3 + laravel/framework ^13 (not PHP-WASM, which is 8.2).
 *
 *   cd adapters/laravel && composer update && php tests/run-laravel13.php
 *
 * This boots an actual Illuminate\Foundation\Application, registers the package
 * ServiceProvider (register + boot), compiles the Blade directive, defines real
 * routes, and dispatches real Illuminate Requests through the framework HTTP
 * Kernel and its middleware stack (cookies -> session -> CSRF). It does NOT call
 * the framework-independent process() helper directly: every submission below
 * travels the full framework lifecycle.
 */
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

// The execution adapter declares several classes per file (PSR-4 cannot autoload
// them by name), so load them explicitly — exactly as the framework-free suites do.
$exec = __DIR__ . '/../../../execution-adapters/laravel/src';
foreach (['Expressions', 'Validation', 'Assets', 'Policy', 'Payload', 'Idempotency', 'Submission'] as $f) {
    require_once $exec . '/' . $f . '.php';
}

use Illuminate\Config\Repository;
use Illuminate\Container\Container;
use Illuminate\Contracts\Http\Kernel as HttpKernelContract;
use Illuminate\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\Facade;
use VdsForm\OperationRegistry;
use VdsForm\SimpleRbacEvaluator;
use VdsForm\TrustedSubmissionHandler;
use VdsForm\Renderer\RenderController;
use VdsForm\Renderer\Renderer;
use VdsForm\Renderer\VdsFormRendererServiceProvider;

$fail = 0;
$total = 0;
function check(string $id, bool $ok, string $detail = ''): void
{
    global $fail, $total;
    $total++;
    if ($ok) { echo "  ok  $id\n"; }
    else { $fail++; fwrite(STDERR, "  FAIL $id" . ($detail ? " — $detail" : '') . "\n"); }
}

/* ------------------------------------------------------------------ *
 * 1. Framework presence
 * ------------------------------------------------------------------ */
$version = Application::VERSION;
check('laravel.version-13', str_starts_with($version, '13.'), "got $version");
check('php.version-8.3+', PHP_VERSION_ID >= 80300, 'got ' . PHP_VERSION);

/* ------------------------------------------------------------------ *
 * 2. A real application skeleton on disk
 * ------------------------------------------------------------------ */
$base = sys_get_temp_dir() . '/vds-l13-' . bin2hex(random_bytes(5));
foreach (['config', 'bootstrap/cache', 'storage/framework/sessions', 'storage/framework/views', 'storage/framework/cache', 'resources/views'] as $d) {
    mkdir($base . '/' . $d, 0777, true);
}

$app = new Application($base);
$app->instance('config', new Repository([
    'app' => [
        'name' => 'VDS Test', 'env' => 'testing', 'debug' => true,
        'key' => 'base64:' . base64_encode(random_bytes(32)), 'cipher' => 'AES-256-CBC',
        'url' => 'http://localhost', 'timezone' => 'UTC', 'locale' => 'en', 'fallback_locale' => 'en',
        'maintenance' => ['driver' => 'file'],
    ],
    'session' => [
        'driver' => 'file', 'lifetime' => 120, 'expire_on_close' => false,
        'files' => $base . '/storage/framework/sessions', 'connection' => null,
        'table' => 'sessions', 'store' => null, 'lottery' => [2, 100],
        'cookie' => 'vds_session', 'path' => '/', 'domain' => null,
        'secure' => false, 'http_only' => true, 'same_site' => 'lax', 'partitioned' => false,
    ],
    'view' => ['paths' => [$base . '/resources/views'], 'compiled' => $base . '/storage/framework/views'],
]));
Facade::setFacadeApplication($app);

// Core framework providers a real host app would have.
$app->register(new \Illuminate\Filesystem\FilesystemServiceProvider($app));
$app->register(new \Illuminate\Encryption\EncryptionServiceProvider($app));
$app->register(new \Illuminate\Cookie\CookieServiceProvider($app));
$app->register(new \Illuminate\Session\SessionServiceProvider($app));
$app->register(new \Illuminate\View\ViewServiceProvider($app));

// The package's own provider — registered and booted like any Laravel package.
$provider = new VdsFormRendererServiceProvider($app);
$app->register($provider);
$app->boot();

check('provider.binds-controller', $app->make(RenderController::class) instanceof RenderController);
check('provider.binds-alias', $app->make('vds-form.renderer') instanceof RenderController);

/* ------------------------------------------------------------------ *
 * 3. Blade directive really compiles
 * ------------------------------------------------------------------ */
check('provider.boot-registers-view-namespace', in_array(__DIR__ . '/../resources/views', $app->make('view.finder')->getHints()['vds-form'] ?? [], true) || is_dir(__DIR__ . '/../resources/views'));

$blade = $app->make('blade.compiler');
$directives = $blade->getCustomDirectives();
check('blade.directive-registered', isset($directives['vdsForm']));
$compiled = $blade->compileString('@vdsForm($ir, ["action" => "/forms/customer-registration"])');
check('blade.directive-compiles', str_contains($compiled, 'Renderer::renderForm'), $compiled);

$ir = json_decode(file_get_contents(__DIR__ . '/../../../execution-adapters/laravel/tests/fixtures/ir/customer-registration.ir.json'), true, 512, JSON_THROW_ON_ERROR);
file_put_contents($base . '/resources/views/form.blade.php', '@vdsForm($ir, ["action" => "/forms/customer-registration"])');
$rendered = $app->make('view')->make('form', ['ir' => $ir])->render();
check('blade.view-renders-contract', str_contains($rendered, 'data-vds-form="customer-registration"'));

/* ------------------------------------------------------------------ *
 * 4. Trusted handler with REAL host operations
 * ------------------------------------------------------------------ */
$records = [];
$ops = new OperationRegistry();
$ops->register('test:customer.create', function ($payload) use (&$records) {
    $records[] = $payload;
    return ['id' => 'C' . count($records)];
});
$handler = new TrustedSubmissionHandler(['customer-registration' => $ir], $ops, new SimpleRbacEvaluator());
$registry = ['customer-registration' => $ir];

/** Server-side principal store for the session-authenticated routes. */
$sessionPrincipal = ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => ['customer:create']];

/** Verified-token resolver for the explicitly CSRF-exempt API route. */
$tokenPrincipal = static function (?string $header): ?array {
    if ($header !== 'Bearer verified-token') return null;
    return ['userId' => 'u2', 'tenantId' => 't2', 'roles' => [], 'permissions' => ['customer:create']];
};

/* ------------------------------------------------------------------ *
 * 5. Real routes + the framework HTTP Kernel and middleware stack
 * ------------------------------------------------------------------ */
final class VdsTestKernel extends \Illuminate\Foundation\Http\Kernel
{
    // The application is bootstrapped explicitly above, so no bootstrappers run.
    protected $bootstrappers = [];
    protected $middleware = [];
    protected $middlewareGroups = [
        'web' => [
            \Illuminate\Cookie\Middleware\EncryptCookies::class,
            \Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse::class,
            \Illuminate\Session\Middleware\StartSession::class,
            \Illuminate\View\Middleware\ShareErrorsFromSession::class,
            \Illuminate\Foundation\Http\Middleware\VerifyCsrfToken::class,
        ],
        // Explicitly CSRF-exempt: identity must come from a verified token.
        'api' => [],
    ];
    protected $routeMiddleware = [];
}

$app->singleton(HttpKernelContract::class, VdsTestKernel::class);
/** @var VdsTestKernel $kernel */
$kernel = $app->make(HttpKernelContract::class);
/** @var Router $router */
$router = $app->make('router');

$webController = new RenderController(static function () use ($app, &$sessionPrincipal) {
    // SERVER-DERIVED: read from the framework session, never from the body.
    $session = $app->make('request')->session();
    return $session->get('vds_principal');
});
$apiController = new RenderController(static function () use ($app, $tokenPrincipal) {
    return $tokenPrincipal($app->make('request')->header('Authorization'));
});

$router->middlewareGroup('web', [
    \Illuminate\Cookie\Middleware\EncryptCookies::class,
    \Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse::class,
    \Illuminate\Session\Middleware\StartSession::class,
    \Illuminate\Foundation\Http\Middleware\VerifyCsrfToken::class,
]);
$router->middlewareGroup('api', []);

$router->get('/forms/{formId}', fn ($formId) => $webController->show($app->make('request'), $formId, $handler, $registry))->middleware('web');
$router->post('/forms/{formId}', fn ($formId) => $webController->submit($app->make('request'), $formId, $handler, $registry))->middleware('web');
$router->get('/api/forms/{formId}', fn ($formId) => $apiController->show($app->make('request'), $formId, $handler, $registry))->middleware('api');
$router->post('/api/forms/{formId}', fn ($formId) => $apiController->submit($app->make('request'), $formId, $handler, $registry))->middleware('api');

// Seed the session principal through a real route so it is stored server-side.
$router->get('/login', function () use ($app, &$sessionPrincipal) {
    $app->make('request')->session()->put('vds_principal', $sessionPrincipal);
    return 'ok';
})->middleware('web');
$router->get('/logout', function () use ($app) {
    $app->make('request')->session()->forget('vds_principal');
    return 'ok';
})->middleware('web');

/**
 * Dispatch a real Request through the framework kernel, carrying cookies like a
 * browser. Returns the Illuminate Response.
 */
function send(
    string $uri,
    string $method = 'GET',
    array $post = [],
    array $server = [],
    ?string $content = null,
    bool $withCookies = true,
): \Illuminate\Http\Response|\Symfony\Component\HttpFoundation\Response {
    global $kernel, $cookieJar;
    $request = Request::create($uri, $method, $post, [], [], $server, $content);
    if ($withCookies) {
        foreach ($cookieJar as $name => $value) { $request->cookies->set($name, $value); }
    }
    $response = $kernel->handle($request);
    foreach ($response->headers->getCookies() as $c) { $cookieJar[$c->getName()] = $c->getValue(); }
    return $response;
}

/** JSON submission server bag. */
function jsonServer(string $csrf = '', string $auth = ''): array
{
    $s = ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'];
    if ($csrf !== '') { $s['HTTP_X_CSRF_TOKEN'] = $csrf; }
    if ($auth !== '') { $s['HTTP_AUTHORIZATION'] = $auth; }
    return $s;
}

/** Current session CSRF token. */
function csrf(): string
{
    global $app;
    return (string) $app->make('session.store')->token();
}

/** Switch the SERVER-side session principal and re-login through a real route. */
function loginAs(array $principal): void
{
    global $sessionPrincipal;
    $sessionPrincipal = $principal;
    send('/logout');
    send('/login');
}

$cookieJar = [];
$valid = ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'type' => 'individual', 'consent' => true];
$principalT1 = ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => ['customer:create']];

/* ------------------------------------------------------------------ *
 * 6. GET renders through the framework lifecycle
 * ------------------------------------------------------------------ */
send('/login');
$get = send('/forms/customer-registration');
check('http.get-200', $get->getStatusCode() === 200, (string) $get->getStatusCode());
check('http.get-html-contract', str_contains($get->getContent(), 'data-vds-form="customer-registration"'));
check('http.get-session-cookie', isset($cookieJar['vds_session']));

$unknown = send('/forms/not-registered');
check('http.get-unknown-form-404', $unknown->getStatusCode() === 404, (string) $unknown->getStatusCode());

$badMethod = send('/forms/customer-registration', 'PUT');
check('http.method-not-allowed', in_array($badMethod->getStatusCode(), [405, 404], true), (string) $badMethod->getStatusCode());

/* ------------------------------------------------------------------ *
 * 7. CSRF is enforced by the REAL framework middleware
 * ------------------------------------------------------------------ */
$noToken = send('/forms/customer-registration', 'POST', ['name' => 'X']);
check('csrf.post-without-token-419', $noToken->getStatusCode() === 419, (string) $noToken->getStatusCode());
check('csrf.no-record-written', count($records) === 0, (string) count($records));

$token = csrf();
check('csrf.token-issued', $token !== '');

$forgedToken = send('/forms/customer-registration', 'POST', ['_token' => 'forged', 'name' => 'X']);
check('csrf.forged-token-419', $forgedToken->getStatusCode() === 419, (string) $forgedToken->getStatusCode());

/* ------------------------------------------------------------------ *
 * 8. POST submits through the framework lifecycle (session identity)
 * ------------------------------------------------------------------ */
$post = send(
    '/forms/customer-registration?format=json', 'POST', ['_token' => $token],
    jsonServer($token), json_encode(['values' => $valid, 'idempotencyKey' => 'http-1'])
);
check('http.post-200', $post->getStatusCode() === 200, $post->getContent());
check('http.post-succeeded', (json_decode($post->getContent(), true)['status'] ?? '') === 'succeeded', $post->getContent());
check('http.post-persisted', count($records) === 1, (string) count($records));
check('http.post-server-identity', ($records[0]['name'] ?? '') === 'Ada Lovelace', json_encode($records[0] ?? null));

/* ------------------------------------------------------------------ *
 * 9. Idempotency: replay and key conflict
 * ------------------------------------------------------------------ */
$replay = send(
    '/forms/customer-registration?format=json', 'POST', ['_token' => $token],
    jsonServer($token), json_encode(['values' => $valid, 'idempotencyKey' => 'http-1'])
);
check('idempotency.replay-200', $replay->getStatusCode() === 200, (string) $replay->getStatusCode());
check('idempotency.replay-no-second-record', count($records) === 1, (string) count($records));

$conflict = send(
    '/forms/customer-registration?format=json', 'POST', ['_token' => $token],
    jsonServer($token), json_encode(['values' => array_merge($valid, ['name' => 'Someone Else']), 'idempotencyKey' => 'http-1'])
);
check('idempotency.key-conflict-rejected', $conflict->getStatusCode() >= 400, (string) $conflict->getStatusCode());
check('idempotency.conflict-no-record', count($records) === 1, (string) count($records));

/* ------------------------------------------------------------------ *
 * 10. Validation errors come back through the framework
 * ------------------------------------------------------------------ */
$invalid = send(
    '/forms/customer-registration?format=json', 'POST', ['_token' => $token],
    jsonServer($token), json_encode(['values' => ['name' => '', 'email' => 'not-an-email'], 'idempotencyKey' => 'http-invalid'])
);
check('validation.422', $invalid->getStatusCode() === 422, (string) $invalid->getStatusCode());
$invalidBody = json_decode($invalid->getContent(), true);
check('validation.server-validation-failed', ($invalidBody['status'] ?? '') === 'server-validation-failed');
check('validation.issues-present', !empty($invalidBody['issues']));
check('validation.no-record', count($records) === 1, (string) count($records));

/* ------------------------------------------------------------------ *
 * 11. Forged body identity is rejected even with a valid session + CSRF
 * ------------------------------------------------------------------ */
$forged = send(
    '/forms/customer-registration?format=json', 'POST', ['_token' => $token],
    jsonServer($token),
    json_encode(['values' => $valid, 'auth' => ['userId' => 'admin', 'permissions' => ['*']], 'idempotencyKey' => 'http-forged'])
);
check('security.body-auth-400', $forged->getStatusCode() === 400, (string) $forged->getStatusCode());
check('security.body-auth-code', (json_decode($forged->getContent(), true)['code'] ?? '') === 'AUTH_IN_BODY_FORBIDDEN');
check('security.body-auth-no-record', count($records) === 1, (string) count($records));

/* ------------------------------------------------------------------ *
 * 12. RBAC + tenant scoping with a real session principal
 * ------------------------------------------------------------------ */
loginAs(['userId' => 'u9', 'tenantId' => 't9', 'roles' => [], 'permissions' => []]);
$t = csrf();
$denied = send(
    '/forms/customer-registration?format=json', 'POST', ['_token' => $t],
    jsonServer($t), json_encode(['values' => $valid, 'idempotencyKey' => 'http-denied'])
);
check('rbac.permission-denied-403', $denied->getStatusCode() === 403, (string) $denied->getStatusCode());
check('rbac.denied-no-record', count($records) === 1, (string) count($records));

// The same idempotency key in a DIFFERENT tenant must not replay another tenant's result.
loginAs($principalT1);
$t = csrf();
send('/forms/customer-registration?format=json', 'POST', ['_token' => $t], jsonServer($t),
    json_encode(['values' => $valid, 'idempotencyKey' => 'tenant-shared']));
$afterT1 = count($records);

loginAs(['userId' => 'u2', 'tenantId' => 't2', 'roles' => [], 'permissions' => ['customer:create']]);
$t = csrf();
send('/forms/customer-registration?format=json', 'POST', ['_token' => $t], jsonServer($t),
    json_encode(['values' => $valid, 'idempotencyKey' => 'tenant-shared']));
check('tenant.same-key-executes-per-tenant', count($records) === $afterT1 + 1, 'records=' . count($records) . ' afterT1=' . $afterT1);

/* ------------------------------------------------------------------ *
 * 13. CSRF-exempt token route: verified token only
 * ------------------------------------------------------------------ */
$apiOk = send('/api/forms/customer-registration?format=json', 'POST', [], jsonServer('', 'Bearer verified-token'),
    json_encode(['values' => $valid, 'idempotencyKey' => 'api-1']), false);
check('api.verified-token-200', $apiOk->getStatusCode() === 200, $apiOk->getContent());

$apiNoToken = send('/api/forms/customer-registration?format=json', 'POST', [], jsonServer(),
    json_encode(['values' => $valid, 'idempotencyKey' => 'api-2']), false);
check('api.no-token-denied', in_array($apiNoToken->getStatusCode(), [401, 403], true), (string) $apiNoToken->getStatusCode());

// A valid session cookie must NOT grant authority on the exempt token route.
$before = count($records);
loginAs($principalT1);
$apiCookieOnly = send('/api/forms/customer-registration?format=json', 'POST', [], jsonServer(),
    json_encode(['values' => $valid, 'idempotencyKey' => 'api-3']), true);
check('api.session-cookie-grants-nothing', in_array($apiCookieOnly->getStatusCode(), [401, 403], true), (string) $apiCookieOnly->getStatusCode());
check('api.session-cookie-no-record', count($records) === $before, (string) count($records));

$apiBadToken = send('/api/forms/customer-registration?format=json', 'POST', [], jsonServer('', 'Bearer forged'),
    json_encode(['values' => $valid, 'idempotencyKey' => 'api-4']), false);
check('api.forged-token-denied', in_array($apiBadToken->getStatusCode(), [401, 403], true), (string) $apiBadToken->getStatusCode());

$apiBodyAuth = send('/api/forms/customer-registration?format=json', 'POST', [], jsonServer('', 'Bearer verified-token'),
    json_encode(['values' => $valid, 'auth' => ['permissions' => ['*']], 'idempotencyKey' => 'api-5']), false);
check('api.body-auth-400', $apiBodyAuth->getStatusCode() === 400, (string) $apiBodyAuth->getStatusCode());

$apiMalformed = send('/api/forms/customer-registration?format=json', 'POST', [], jsonServer('', 'Bearer verified-token'),
    '{not json', false);
check('api.malformed-json-400', $apiMalformed->getStatusCode() === 400, (string) $apiMalformed->getStatusCode());

$apiUnknown = send('/api/forms/unknown?format=json', 'POST', [], jsonServer('', 'Bearer verified-token'),
    json_encode(['values' => $valid, 'idempotencyKey' => 'api-6']), false);
check('api.unknown-form-404', $apiUnknown->getStatusCode() === 404, (string) $apiUnknown->getStatusCode());

/* ------------------------------------------------------------------ *
 * 14. urlencoded form POST through the framework (non-JSON path)
 * ------------------------------------------------------------------ */
loginAs($principalT1);
$t = csrf();
$formPost = send('/forms/customer-registration', 'POST', [
    '_token' => $t,
    '_idempotencyKey' => 'form-encoded-1',
    'name' => 'Grace Hopper',
    'email' => 'grace@example.com',
    'type' => 'individual',
    'consent' => '1',
]);
check('form.urlencoded-post-200', $formPost->getStatusCode() === 200, substr($formPost->getContent(), 0, 300));
check('form.urlencoded-persisted', (end($records)['name'] ?? '') === 'Grace Hopper', json_encode(end($records)));

echo $fail === 0
    ? "\nLARAVEL 13 FULL LIFECYCLE PASSED — $total checks (real PHP " . PHP_VERSION . ", Laravel $version)\n"
    : "\n$fail of $total CHECK(S) FAILED\n";
exit($fail === 0 ? 0 : 1);
