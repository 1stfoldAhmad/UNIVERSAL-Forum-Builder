<?php
/**
 * Thin Laravel integration for the trusted submission handler.
 *
 * Laravel is NOT required to run the framework-free core (Expressions,
 * Validation, Payload, Submission, Idempotency) or the test runners. The
 * controller's process() method is framework-agnostic and unit-tested directly;
 * submit() only references Illuminate types at runtime inside a host Laravel app.
 *
 * SECURITY (audit P0): identity and permissions are derived EXCLUSIVELY from the
 * server-side authenticated principal ($request->user()) or a host-supplied
 * authResolver that reads validated token claims. The request body is NEVER a
 * source of authorization: any body containing an "auth" key is rejected with
 * 400 AUTH_IN_BODY_FORBIDDEN. Unauthenticated requests carry auth=null and the
 * handler's fail-closed RBAC denies any permission-gated form.
 *
 * Host wiring (routes/web.php or api.php):
 *   $ops = new \VdsForm\OperationRegistry();
 *   $ops->register('database:contact.create', $realHandler);
 *   $handler = new \VdsForm\TrustedSubmissionHandler(['contact' => $compiledIr], $ops, $rbac);
 *   Route::post('/api/forms/submit', [\VdsForm\LaravelController::class, 'submit'])
 *        ->defaults('handler', $handler);
 *
 * For token-based hosts, inject a resolver that reads VERIFIED claims:
 *   new \VdsForm\LaravelController(null, fn($request) => $claims
 *       ? \VdsForm\auth_context_from_claims($claims) : null);
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

    /** @var callable|null */
    private $respond;
    /** @var callable|null */
    private $authResolver;
    private bool $allowAnonymous;

    public function __construct(?callable $respond = null, ?callable $authResolver = null, bool $allowAnonymous = true)
    {
        $this->respond = $respond;
        $this->authResolver = $authResolver;
        $this->allowAnonymous = $allowAnonymous;
    }

    /**
     * Framework-agnostic core. Returns [httpStatus, resultBody]. $user is the
     * server-side authenticated principal (or null). $authResolver, when given,
     * is the ONLY other source of auth and must read verified claims.
     */
    public function process(array $body, $user, $handler, ?callable $authResolver = null, bool $allowAnonymous = true): array
    {
        // P0: the body must never carry authorization. Reject any such attempt.
        if (array_key_exists('auth', $body)) {
            return [400, ['status' => 'config-error', 'code' => 'AUTH_IN_BODY_FORBIDDEN', 'message' => 'Authorization must not be supplied in the request body.']];
        }

        $auth = null;
        if ($authResolver !== null) {
            $auth = $authResolver();
        } elseif ($user !== null) {
            $auth = self::authFromUser($user);
        }
        if ($auth === null && !$allowAnonymous) {
            return [401, ['status' => 'permission-denied', 'code' => 'AUTH_REQUIRED', 'message' => 'Authentication is required to submit this form.']];
        }

        $result = $handler->handle([
            'formId' => $body['formId'] ?? '',
            'formVersion' => $body['formVersion'] ?? null,
            'values' => $body['values'] ?? [],
            'operationRef' => $body['operationRef'] ?? null,
            'idempotencyKey' => $body['idempotencyKey'] ?? '',
            'correlationId' => $body['correlationId'] ?? '',
        ], $auth);
        return [self::STATUS_CODE[$result['status']] ?? 200, $result];
    }

    /**
     * Derive an auth context from Laravel's authenticated principal. userId comes
     * from getAuthIdentifier(); permissions default to [] (fail-closed). Hosts
     * with VDS permission strings should supply an authResolver instead.
     */
    public static function authFromUser($user): ?array
    {
        if ($user === null) return null;
        $id = method_exists($user, 'getAuthIdentifier') ? $user->getAuthIdentifier() : null;
        if ($id === null) return null;
        return ['userId' => (string)$id, 'tenantId' => null, 'roles' => [], 'permissions' => []];
    }

    /**
     * Laravel entry point. $request is Illuminate\Http\Request; the handler is
     * resolved from the argument or route defaults. The responder is injectable
     * so this method is testable without a full Laravel application.
     */
    public function submit($request, $handler = null)
    {
        $handler = $handler ?? $request->route('handler');
        $body = json_decode($request->getContent() ?: '{}', true);
        if (!is_array($body)) {
            return $this->respondWith(400, ['status' => 'config-error', 'code' => 'INVALID_JSON', 'message' => 'Request body must be JSON.']);
        }
        $resolver = $this->authResolver !== null ? fn() => ($this->authResolver)($request) : null;
        [$status, $resultBody] = $this->process($body, $request->user(), $handler, $resolver, $this->allowAnonymous);
        return $this->respondWith($status, $resultBody);
    }

    private function respondWith(int $status, array $body)
    {
        if ($this->respond !== null) return ($this->respond)($body, $status);
        return response()->json($body, $status);
    }
}

/** Map verified token claims to an auth context (host authentication middleware). */
function auth_context_from_claims(array $claims): array
{
    return [
        'userId' => $claims['sub'] ?? null,
        'tenantId' => $claims['tenant_id'] ?? null,
        'roles' => $claims['roles'] ?? [],
        'permissions' => $claims['permissions'] ?? [],
        'sessionId' => $claims['sid'] ?? null,
    ];
}
