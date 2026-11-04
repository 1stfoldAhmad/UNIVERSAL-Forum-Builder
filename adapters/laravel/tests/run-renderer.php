<?php
/**
 * Framework-free renderer suite for the Laravel/PHP target. Runs wherever PHP
 * >= 8.1 runs (native CI PHP 8.3 for Laravel 13, or local PHP-WASM 8.2). Reuses
 * the conformance-verified VdsForm engine and the shared IR fixtures.
 */
declare(strict_types=1);

$exec = __DIR__ . '/../../../execution-adapters/laravel';
require_once $exec . '/src/Expressions.php';
require_once $exec . '/src/Validation.php';
require_once $exec . '/src/Policy.php';
require_once $exec . '/src/Payload.php';
require_once $exec . '/src/Idempotency.php';
require_once $exec . '/src/Submission.php';
require_once $exec . '/tests/lib.php';
require_once __DIR__ . '/../src/Renderer.php';
require_once __DIR__ . '/../src/RenderController.php';
require_once __DIR__ . '/../src/Capabilities.php';

use VdsForm\Renderer\Renderer;
use VdsForm\Renderer\RenderController;
use VdsForm\Renderer\Capabilities;
use VdsForm\OperationRegistry;
use VdsForm\TrustedSubmissionHandler;
use VdsForm\SimpleRbacEvaluator;

$r = new Runner();

$registration = load_ir('customer-registration.ir.json');
$invoice = load_ir('invoice.ir.json');

// --- SSR rendering ---
$html = Renderer::renderForm($registration, ['action' => '/forms/customer-registration']);
$r->check('render.form-id', str_contains($html, 'data-vds-form="customer-registration"'));
$r->check('render.name', str_contains($html, 'name="customer.name"'));
$r->check('render.email-type', str_contains($html, 'type="email"'));
foreach ($registration['fields'] as $f) {
    if (empty($f['parentId']) && $f['type'] !== 'hidden') {
        $r->check('render.field.' . $f['id'], str_contains($html, 'data-field-id="' . $f['id'] . '"'));
    }
}

$values = ['items' => [['description' => 'A', 'qty' => 2, 'price' => 5], ['description' => 'B', 'qty' => 3, 'price' => 4]]];
$invHtml = Renderer::renderForm($invoice, ['values' => $values]);
$r->check('render.repeater', str_contains($invHtml, 'data-repeater="items"'));
$r->check('render.row0', str_contains($invHtml, 'data-row-index="0"'));
$r->check('render.row1', str_contains($invHtml, 'data-row-index="1"'));
$r->check('render.row-path', str_contains($invHtml, 'name="items.0.qty"'));
$r->check('render.computed', str_contains($invHtml, 'data-computed="total"'));
$state = Renderer::prepareRenderState($invoice, $values);
$r->check('state.lineTotal', $state['values']['items'][0]['lineTotal'] == 10);
$r->check('state.subtotal', $state['values']['subtotal'] == 22);

$loc = $registration;
$loc['fields'][1]['label'] = ['fr' => 'Nom <script>', 'en' => 'Name'];
$loc['fields'][1]['defaultValue'] = '<b>x</b>';
$locHtml = Renderer::renderForm($loc, ['locale' => 'fr']);
$r->check('render.localize', str_contains($locHtml, 'Nom &lt;script&gt;'));
$r->check('render.escape', str_contains($locHtml, '&lt;b&gt;x&lt;/b&gt;'));

// --- no-JS parsing ---
$parsed = Renderer::parseFormValues($registration, [
    'customer.name' => ['Ada'], 'customer.email' => ['ada@example.com'],
    'customer.type' => ['individual'], 'customer.consent' => ['true'], '_token' => ['tok'],
]);
$r->eq('parse.name', 'Ada', $parsed['customer']['name']);
$r->eq('parse.consent', true, $parsed['customer']['consent']);
$r->check('parse.csrf-stripped', !array_key_exists('_token', $parsed));

// --- controller ---
$records = [];
$ops = new OperationRegistry();
$ops->register('test:customer.create', function ($payload) use (&$records) { $records[] = $payload; return ['id' => 'C1']; });
$handler = new TrustedSubmissionHandler(['customer-registration' => $registration], $ops, new SimpleRbacEvaluator());
$valid = ['customer' => ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'type' => 'individual', 'consent' => true]];

$ctrl = new RenderController(fn() => ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => ['customer:create']]);
[$status, $type, $body] = $ctrl->process('GET', $registration, [], null, $handler);
$r->eq('ctrl.get.status', 200, $status);
$r->check('ctrl.get.html', str_contains($body, '<!doctype html>'));

[$status, , $body] = $ctrl->process('POST', $registration, ['json' => true, 'values' => $valid, 'idempotencyKey' => 'k1', 'format' => 'json'], null, $handler);
$r->eq('ctrl.post.status', 200, $status);
$r->eq('ctrl.post.result', 'succeeded', json_decode($body, true)['status']);
$r->eq('ctrl.post.record', 1, count($records));

[$status, , $body] = $ctrl->process('POST', $registration, ['post' => ['customer.name' => ['Ada']]], null, $handler);
$r->eq('ctrl.validation.status', 422, $status);
$r->check('ctrl.validation.errors', str_contains($body, 'data-error-for'));
$r->eq('ctrl.validation.no-record', 1, count($records));

$denied = new RenderController(fn() => ['userId' => 'u1', 'tenantId' => 't1', 'roles' => [], 'permissions' => []]);
[$status, , $body] = $denied->process('POST', $registration, ['json' => true, 'values' => $valid, 'idempotencyKey' => 'k2', 'format' => 'json'], null, $handler);
$r->eq('ctrl.denied.status', 403, $status);
$r->eq('ctrl.denied.no-record', 1, count($records));

[$status, , $body] = $denied->process('POST', $registration, ['json' => true, 'values' => $valid, 'auth' => ['permissions' => ['*']]], null, $handler);
$r->eq('ctrl.auth-in-body.status', 400, $status);
$r->eq('ctrl.auth-in-body.code', 'AUTH_IN_BODY_FORBIDDEN', json_decode($body, true)['code']);

// --- capabilities ---
$manifest = Capabilities::manifest();
$r->eq('caps.target', 'laravel', $manifest['target']);
$r->check('caps.text', isset($manifest['fieldTypes']['text']));
$r->check('caps.no-signature', !isset($manifest['fieldTypes']['signature']));
$r->eq('caps.multistep', true, $manifest['features']['multiStep']);

exit($r->finish('Laravel renderer (framework-free)'));
