<?php
/**
 * Laravel renderer controller. The process() core is framework-agnostic and
 * unit-tested directly; show()/submit() reference Illuminate only inside a host
 * Laravel 13 app. Identity is SERVER-DERIVED (request->user() / verified claims);
 * the body is never a source of authorization (auth in body → 400).
 */
declare(strict_types=1);

namespace VdsForm\Renderer;

use VdsForm\Payload;
use VdsForm\Validation;

final class RenderController
{
    private const STATUS_CODE = [
        'succeeded' => 200, 'server-validation-failed' => 422, 'permission-denied' => 403,
        'business-rejected' => 409, 'config-error' => 500,
    ];

    /** @var callable|null */
    private $authResolver;

    public function __construct(?callable $authResolver = null)
    {
        $this->authResolver = $authResolver;
    }

    /**
     * Framework-agnostic core. Returns [httpStatus, contentType, body].
     * $input: json(bool), values(array), post(array name→list), idempotencyKey,
     * correlationId, format, accept, auth(forbidden). $user is the server principal.
     */
    public function process(string $method, array $ir, array $input, $user, $handler, array $opts = []): array
    {
        $formId = $ir['formId'];
        $action = ($opts['basePath'] ?? '/forms') . '/' . $formId;
        $wantsJson = ($input['format'] ?? '') === 'json'
            || str_contains($input['accept'] ?? '', 'application/json')
            || !empty($input['json']);

        if ($method === 'GET') {
            return [200, 'text/html', Renderer::renderPage($ir, array_merge($opts, ['action' => $action]))];
        }
        if ($method !== 'POST') return [405, 'text/plain', 'Method not allowed'];
        if (array_key_exists('auth', $input)) {
            return [400, 'application/json', json_encode(['status' => 'config-error', 'code' => 'AUTH_IN_BODY_FORBIDDEN', 'message' => 'Authorization must not be supplied in the request body.'])];
        }

        $auth = $this->authResolver !== null ? ($this->authResolver)() : self::authFromUser($user);
        if (!empty($input['json'])) {
            $values = $input['values'] ?? [];
            $idem = $input['idempotencyKey'] ?? '';
        } else {
            $values = Renderer::parseFormValues($ir, $input['post'] ?? [], $opts['csrfParam'] ?? '_token');
            $idem = $input['post']['_idempotencyKey'][0] ?? '';
        }
        if (!$idem) $idem = 'laravel-' . bin2hex(random_bytes(8));

        $submission = $ir['submission'] ?? [];
        if ($submission) {
            [$state, ] = Validation::computeEffectiveState($ir, $values);
            [$payload, $issues] = Payload::build($ir, $values, $state, $submission);
            $errors = array_values(array_filter($issues, fn($i) => ($i['severity'] ?? '') === 'error'));
            $result = $errors
                ? ['status' => 'server-validation-failed', 'issues' => $errors]
                : $handler->handle(['formId' => $formId, 'values' => $payload, 'idempotencyKey' => $idem, 'correlationId' => $input['correlationId'] ?? ''], $auth);
        } else {
            $result = $handler->handle(['formId' => $formId, 'values' => $values, 'idempotencyKey' => $idem, 'correlationId' => $input['correlationId'] ?? ''], $auth);
        }

        $status = self::STATUS_CODE[$result['status']] ?? 200;
        if ($wantsJson) return [$status, 'application/json', json_encode($result)];
        if ($result['status'] === 'succeeded') {
            $page = Renderer::renderPage($ir, array_merge($opts, ['values' => $values, 'action' => $action]));
            return [200, 'text/html', preg_replace('/<form/', '<p class="vds-success" role="status" data-vds-status>Submitted successfully.</p><form', $page, 1)];
        }
        $issues = $result['status'] === 'server-validation-failed' ? ($result['issues'] ?? []) : [];
        if (!$issues) return [$status, 'text/html', '<p class="vds-error" role="alert">' . Renderer::esc($result['message'] ?? $result['status']) . '</p>'];
        return [$status, 'text/html', Renderer::renderPage($ir, array_merge($opts, ['values' => $values, 'issues' => $issues, 'action' => $action]))];
    }

    public static function authFromUser($user): ?array
    {
        if ($user === null) return null;
        $id = method_exists($user, 'getAuthIdentifier') ? $user->getAuthIdentifier() : null;
        if ($id === null) return null;
        $perms = method_exists($user, 'getPermissions') ? $user->getPermissions() : [];
        return ['userId' => (string)$id, 'tenantId' => null, 'roles' => [], 'permissions' => $perms];
    }

    /** Laravel entry points (host app). $registry maps formId → compiled IR. */
    public function show($request, string $formId, $handler, array $registry, array $opts = [])
    {
        $ir = $registry[$formId] ?? null;
        if (!$ir) return response()->json(['status' => 'config-error', 'code' => 'FORM_NOT_FOUND'], 404);
        [$status, $type, $body] = $this->process('GET', $ir, ['accept' => $request->header('Accept', ''), 'format' => $request->query('format', '')], $request->user(), $handler, $opts);
        return response($body, $status)->header('Content-Type', $type);
    }

    public function submit($request, string $formId, $handler, array $registry, array $opts = [])
    {
        $ir = $registry[$formId] ?? null;
        if (!$ir) return response()->json(['status' => 'config-error', 'code' => 'FORM_NOT_FOUND'], 404);
        $isJson = str_contains($request->header('Content-Type', ''), 'application/json');
        $input = [
            'accept' => $request->header('Accept', ''), 'format' => $request->query('format', ''),
            'correlationId' => $request->header('X-Correlation-Id', ''), 'json' => $isJson,
        ];
        if ($isJson) {
            $body = json_decode($request->getContent() ?: '{}', true);
            if (!is_array($body)) return response()->json(['status' => 'config-error', 'code' => 'INVALID_JSON'], 400);
            if (array_key_exists('auth', $body)) return response()->json(['status' => 'config-error', 'code' => 'AUTH_IN_BODY_FORBIDDEN'], 400);
            $input['values'] = $body['values'] ?? [];
            $input['idempotencyKey'] = $body['idempotencyKey'] ?? $request->header('Idempotency-Key', '');
        } else {
            $input['post'] = $request->post();
        }
        [$status, $type, $body] = $this->process('POST', $ir, $input, $request->user(), $handler, $opts);
        return response($body, $status)->header('Content-Type', $type);
    }
}
