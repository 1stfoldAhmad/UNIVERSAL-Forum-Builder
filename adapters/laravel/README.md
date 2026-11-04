# @vds-form/laravel — Laravel 13 server-rendered renderer

Renders the compiled **FormIR** to the shared VDS server-rendered HTML contract
(the same contract as `@vds-form/node` and `@vds-form/django`), so one hydration
client (`@vds-form/node/client`) enhances all three targets.

## Support

- All canonical field types except `signature` (capability manifest).
- Groups, repeaters (concrete row paths), multi-step layout.
- Server-side defaults, **formulas** (row-scoped + global) and effective state
  via the conformance-verified `VdsForm` expression engine.
- Localization, accessibility, validation error display.
- No-JS urlencoded POST (dot-path names → typed nested values) and JSON POST.
- Submission through `VdsForm\TrustedSubmissionHandler` with a **server-derived**
  principal (`$request->user()` / verified claims). `auth` in body → 400.

## Layout

- `src/Renderer.php` — framework-free HTML renderer + render state + POST parsing.
- `src/RenderController.php` — framework-agnostic `process()` + Laravel `show()`/`submit()`.
- `src/VdsFormRendererServiceProvider.php` — singleton + `@vdsForm` Blade directive.
- `src/Capabilities.php` — capability manifest.
- `resources/views/form.blade.php` — Blade partial.

## Host wiring (Laravel 13, PHP ^8.3)

```php
$ops = new \VdsForm\OperationRegistry();
$ops->register('database:customer.create', $realHandler);
$handler = new \VdsForm\TrustedSubmissionHandler(['customer-registration' => $ir], $ops, $rbac);
$registry = ['customer-registration' => $ir];

Route::get('/forms/{formId}', fn ($id, Request $req) =>
    app(\VdsForm\Renderer\RenderController::class)->show($req, $id, $handler, $registry));
Route::post('/forms/{formId}', fn ($id, Request $req) =>
    app(\VdsForm\Renderer\RenderController::class)->submit($req, $id, $handler, $registry));
```

Register `VdsForm\Renderer\VdsFormRendererServiceProvider` (auto-discovered). The
renderer depends on the `vds/form-laravel` execution adapter.

## Verification

- Framework-free core: `php tests/run-renderer.php` (PHP >= 8.1). Local convenience:
  `node adapters/laravel/tests/run-wasm.mjs` (PHP-WASM 8.2, GPL tool not committed).
- **Laravel 13 integration is verified in CI on real PHP 8.3 + `laravel/framework ^13`**
  (the sandbox cannot install PHP/Composer). See `.github/workflows/ci.yml`.
