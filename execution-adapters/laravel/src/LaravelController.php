<?php
/**
 * Thin Laravel integration for the trusted submission handler.
 *
 * Laravel is NOT required to run the framework-free core (Expressions,
 * Validation, Payload, Submission) or the conformance runner. This controller
 * only references Illuminate types at runtime inside a host Laravel app.
 *
 * Host wiring (routes/web.php or api.php):
 *   $ops = new \VdsForm\OperationRegistry();
 *   $ops->register('database:contact.create', $realHandler);
 *   $handler = new \VdsForm\TrustedSubmissionHandler(['contact' => $compiledIr], $ops, $rbac);
 *   Route::post('/api/forms/submit', [\VdsForm\LaravelController::class, 'submit'])
 *        ->defaults('handler', $handler);
 *
 * STATUS: implemented-not-verified in sandbox (no PHP/Laravel runtime).
 */
declare(strict_types=1);

namespace VdsForm;

final class LaravelController
{
    private const STATUS_CODE = [
        'succeeded' => 200,
        'server-validation-failed' => 422,
        'permission-denied' => 403,
        'business-rejected' => 409,
        'config-error' => 500,
    ];

    /**
     * @param mixed $request Illuminate\Http\Request (host app)
     * @param mixed $handler TrustedSubmissionHandler resolved from route defaults/container
     * @return mixed Illuminate\Http\JsonResponse
     */
    public function submit($request, $handler = null)
    {
        $handler = $handler ?? $request->route('handler');
        $body = json_decode($request->getContent() ?: '{}', true);
        if (!is_array($body)) {
            return response()->json(['status' => 'config-error', 'code' => 'INVALID_JSON', 'message' => 'Request body must be JSON.'], 400);
        }

        $auth = $body['auth'] ?? null;
        if ($auth === null && $request->user()) {
            $auth = ['userId' => (string)$request->user()->getAuthIdentifier(), 'permissions' => []];
        }

        $result = $handler->handle([
            'formId' => $body['formId'] ?? '',
            'formVersion' => $body['formVersion'] ?? null,
            'values' => $body['values'] ?? [],
            'operationRef' => $body['operationRef'] ?? null,
            'auth' => $auth,
            'idempotencyKey' => $body['idempotencyKey'] ?? ($request->header('Idempotency-Key') ?? ''),
            'correlationId' => $body['correlationId'] ?? ($request->header('X-Correlation-Id') ?? ''),
        ]);
        return response()->json($result, self::STATUS_CODE[$result['status']] ?? 200);
    }
}
