<?php
/**
 * Trusted server-side submission handler — PHP port of execution-adapters/node
 * (mirrors the verified Python port). Re-validates and re-authorizes EVERY
 * submission; client-side hiding is never authorization. Operations resolve only
 * against a registered OperationRegistry; missing operations fail with
 * SUBMISSION_OPERATION_UNRESOLVED. Audit records value PATHS only, never values.
 *
 * SECURITY BOUNDARY (audit P0/P1), identical to the Node and Django adapters:
 * - $auth is a SEPARATE, server-derived argument, never read from the client
 *   request payload. The Laravel controller derives it from $request->user() /
 *   validated token claims — never from the body.
 * - The executed operation is bound to the compiled FormIR (and an optional
 *   server-side allowlist); a client cannot select or override it.
 * - Idempotency is checked only AFTER authentication, authorization and version
 *   checks; keys are scoped by tenant+user+form+operation and carry a canonical
 *   payload fingerprint; claims are atomic. See Idempotency.php.
 *
 * Operates on the shared deterministic FormIR (compile once with the TS compiler:
 * `vds-form compile --json`).
 */
declare(strict_types=1);

namespace VdsForm;

final class OperationRegistry
{
    private array $handlers = [];

    public function register(string $operationRef, callable $handler): void
    {
        if (isset($this->handlers[$operationRef])) throw new \RuntimeException("OPERATION_DUPLICATE: $operationRef");
        $this->handlers[$operationRef] = $handler;
    }
    public function has(string $operationRef): bool { return isset($this->handlers[$operationRef]); }
    public function resolve(string $operationRef): ?callable { return $this->handlers[$operationRef] ?? null; }
    public function refs(): array { $r = array_keys($this->handlers); sort($r); return $r; }
}

final class SimpleRbacEvaluator
{
    public function evaluate(?array $auth, array $required): array
    {
        $granted = $auth['permissions'] ?? [];
        if (in_array('*', $granted, true)) return ['allowed' => true, 'missing' => []];
        $missing = array_values(array_filter($required, fn($p) => !in_array($p, $granted, true)));
        return ['allowed' => count($missing) === 0, 'missing' => $missing];
    }
}

final class TrustedSubmissionHandler
{
    private array $irs = [];
    private OperationRegistry $operations;
    private $rbac;
    private $audit;
    private IdempotencyStore $idempotency;
    private ?array $allowedOperations;

    public function __construct(array $forms, OperationRegistry $operations, $rbac = null, ?callable $audit = null, ?IdempotencyStore $idempotencyStore = null, ?array $allowedOperations = null)
    {
        $this->operations = $operations;
        $this->rbac = $rbac;
        $this->audit = $audit;
        $this->idempotency = $idempotencyStore ?? new InMemoryIdempotencyStore();
        $this->allowedOperations = $allowedOperations;
        foreach ($forms as $formId => $ir) {
            if (!isset($ir['irVersion'])) throw new \RuntimeException("FORM_IR_REQUIRED ($formId): register a compiled FormIR (vds-form compile --json).");
            $this->irs[$formId] = $ir;
        }
    }

    public function supportsOperation(string $operationRef): bool { return $this->operations->has($operationRef); }

    private static function setIn($root, string $path, $value)
    {
        $segments = explode('.', $path);
        $recur = function ($node, int $i) use (&$recur, $segments, $value) {
            if ($i === count($segments)) return $value;
            $seg = $segments[$i];
            if (preg_match('/^\d+$/', $seg)) {
                $arr = is_array($node) && array_is_list($node) ? $node : [];
                $idx = (int)$seg;
                while (count($arr) <= $idx) $arr[] = null;
                $arr[$idx] = $recur($arr[$idx] ?? null, $i + 1);
                return $arr;
            }
            $obj = is_array($node) && !array_is_list($node) ? $node : [];
            $obj[$seg] = $recur($obj[$seg] ?? null, $i + 1);
            return $obj;
        };
        return $recur($root, 0);
    }

    private static function serverIssue(string $code, string $message, string $path = ''): array
    {
        return ['code' => $code, 'message' => $message, 'path' => $path, 'severity' => 'error', 'source' => 'server'];
    }

    /**
     * Handle a submission. $auth is the SERVER-DERIVED principal; it must never
     * be taken from the client request body.
     */
    public function handle(array $request, ?array $auth = null): array
    {
        $started = microtime(true);
        $ir = $this->irs[$request['formId']] ?? null;
        if ($ir === null) return ['status' => 'config-error', 'code' => 'SUBMISSION_OPERATION_UNRESOLVED', 'message' => "Form \"{$request['formId']}\" is not registered on this server."];
        $submission = $ir['submission'] ?? [];
        $reqValues = $request['values'] ?? [];

        $audit = function (array $result, string $operationRef, array $issueCodes = []) use ($ir, $request, $reqValues, $auth): void {
            if (!$this->audit) return;
            ($this->audit)([
                'timestamp' => gmdate('c'), 'formId' => $ir['formId'], 'formVersion' => $ir['formVersion'],
                'operationRef' => $operationRef, 'correlationId' => $request['correlationId'] ?? '',
                'idempotencyKey' => $request['idempotencyKey'],
                'userId' => $auth['userId'] ?? null, 'tenantId' => $auth['tenantId'] ?? null,
                'outcome' => $result['status'], 'issueCodes' => $issueCodes,
                'valuePaths' => array_keys($reqValues),
            ]);
        };

        // Operation binding: from the compiled FormIR, never from the client.
        $operationRef = $submission['operationRef'] ?? '';
        if (array_key_exists('operationRef', $request) && $request['operationRef'] !== null && $request['operationRef'] !== $operationRef) {
            $result = ['status' => 'permission-denied', 'code' => 'OPERATION_OVERRIDE_FORBIDDEN', 'message' => 'The requested operation does not match the operation configured for this form.'];
            $audit($result, $operationRef, ['OPERATION_OVERRIDE_FORBIDDEN']);
            return $result;
        }
        if ($this->allowedOperations !== null && !in_array($operationRef, $this->allowedOperations, true)) {
            $result = ['status' => 'permission-denied', 'code' => 'OPERATION_NOT_ALLOWED', 'message' => "Operation \"$operationRef\" is not in the server allowlist."];
            $audit($result, $operationRef, ['OPERATION_NOT_ALLOWED']);
            return $result;
        }

        if (!empty($request['formVersion']) && $request['formVersion'] !== $ir['formVersion']) {
            $result = ['status' => 'server-validation-failed', 'issues' => [self::serverIssue('FORM_VERSION_MISMATCH', "Client form version {$request['formVersion']} != server {$ir['formVersion']}.")]];
            $audit($result, $operationRef, ['FORM_VERSION_MISMATCH']);
            return $result;
        }

        $mapping = $submission['inputMapping'] ?? null;
        if ($mapping) {
            $values = [];
            foreach ($mapping as $param => $sourcePath) {
                if (array_key_exists($param, $reqValues)) $values = self::setIn($values, $sourcePath, $reqValues[$param]);
            }
        } else {
            $values = $reqValues;
        }

        [$state, ] = Validation::computeEffectiveState($ir, $values);
        $validation = Validation::validateValues($ir, $values, $state, 'submit');
        if (!$validation['valid']) {
            $issues = array_map(fn($i) => array_merge($i, ['source' => 'server']), $validation['issues']);
            $result = ['status' => 'server-validation-failed', 'issues' => $issues];
            $audit($result, $operationRef, array_map(fn($i) => $i['code'], $validation['issues']));
            return $result;
        }

        $security = $ir['security'] ?? [];
        $required = $security['submitPermissions'] ?? [];
        if ($required) {
            if ($this->rbac === null) {
                $result = ['status' => 'permission-denied', 'code' => 'RBAC_NOT_CONFIGURED', 'message' => 'Form declares submitPermissions but no RBAC evaluator is registered on the server.', 'requiredPermissions' => $required];
                $audit($result, $operationRef, ['RBAC_NOT_CONFIGURED']);
                return $result;
            }
            $decision = $this->rbac->evaluate($auth, $required);
            if (!$decision['allowed']) {
                $result = ['status' => 'permission-denied', 'code' => 'PERMISSION_DENIED', 'message' => 'Missing permissions: ' . implode(', ', $decision['missing']), 'requiredPermissions' => $decision['missing']];
                $audit($result, $operationRef, ['PERMISSION_DENIED']);
                return $result;
            }
        }

        foreach ($security['fieldAccess'] ?? [] as $fieldId => $access) {
            $writePerms = $access['write'] ?? [];
            if (!$writePerms) continue;
            $field = null;
            foreach ($ir['fields'] as $f) if ($f['id'] === $fieldId) { $field = $f; break; }
            if (!$field) continue;
            $provided = Expressions::getPath($values, $field['key']);
            if ($provided === null) continue;
            $decision = $this->rbac ? $this->rbac->evaluate($auth, $writePerms) : ['allowed' => false, 'missing' => $writePerms];
            if (!$decision['allowed']) {
                $result = ['status' => 'permission-denied', 'code' => 'FIELD_WRITE_DENIED', 'message' => "Not permitted to write field \"{$field['key']}\".", 'requiredPermissions' => $decision['missing']];
                $audit($result, $operationRef, ['FIELD_WRITE_DENIED']);
                return $result;
            }
        }

        $handler = $this->operations->resolve($operationRef);
        if ($handler === null) {
            $result = ['status' => 'config-error', 'code' => 'SUBMISSION_OPERATION_UNRESOLVED', 'message' => "Operation \"$operationRef\" is not registered on this server."];
            $audit($result, $operationRef, ['SUBMISSION_OPERATION_UNRESOLVED']);
            return $result;
        }

        // Idempotency AFTER auth/authz/version. Scoped key + fingerprint + atomic claim.
        $scopeKey = Idempotency::scopedIdempotencyKey($auth['tenantId'] ?? null, $auth['userId'] ?? null, $ir['formId'], $operationRef, $request['idempotencyKey']);
        $fingerprint = Idempotency::payloadFingerprint($reqValues);
        $claim = $this->idempotency->claim($scopeKey, $fingerprint);
        if ($claim['kind'] === 'replay') { $audit($claim['result'], $operationRef, ['IDEMPOTENT_REPLAY']); return $claim['result']; }
        if ($claim['kind'] === 'conflict') {
            $result = ['status' => 'business-rejected', 'code' => 'IDEMPOTENCY_KEY_CONFLICT', 'message' => 'This idempotency key was already used with a different payload.'];
            $audit($result, $operationRef, ['IDEMPOTENCY_KEY_CONFLICT']);
            return $result;
        }
        if ($claim['kind'] === 'in-progress') {
            $result = ['status' => 'business-rejected', 'code' => 'IDEMPOTENCY_IN_PROGRESS', 'message' => 'A submission with this idempotency key is already in progress.'];
            $audit($result, $operationRef, ['IDEMPOTENCY_IN_PROGRESS']);
            return $result;
        }

        try {
            $data = $handler($reqValues, ['auth' => $auth, 'idempotencyKey' => $request['idempotencyKey'], 'correlationId' => $request['correlationId'] ?? '', 'formId' => $ir['formId']]);
            $result = ['status' => 'succeeded', 'operationRef' => $operationRef, 'data' => $data, 'idempotencyKey' => $request['idempotencyKey'], 'durationMs' => (int)((microtime(true) - $started) * 1000)];
        } catch (\Throwable $e) {
            // Read only PUBLIC custom properties. Standard Exception::$code is
            // protected (accessing it throws), so property_exists() alone is unsafe.
            $readPublic = static function (\Throwable $ex, string $prop) {
                if (!property_exists($ex, $prop)) return null;
                $ref = new \ReflectionProperty($ex, $prop);
                return $ref->isPublic() ? $ref->getValue($ex) : null;
            };
            $issues = $readPublic($e, 'issues');
            $code = $readPublic($e, 'code');
            if ($issues) $result = ['status' => 'server-validation-failed', 'issues' => array_map(fn($i) => array_merge($i, ['source' => 'server']), $issues)];
            elseif ($code === 'PERMISSION_DENIED') $result = ['status' => 'permission-denied', 'code' => $code, 'message' => $e->getMessage() ?: 'Denied by operation.'];
            else $result = ['status' => 'business-rejected', 'code' => $code ?: 'OPERATION_FAILED', 'message' => $e->getMessage() ?: 'Operation failed.'];
        }

        if ($result['status'] === 'succeeded') $this->idempotency->complete($scopeKey, $result);
        else $this->idempotency->release($scopeKey);
        $audit($result, $operationRef, array_map(fn($i) => $i['code'], $result['issues'] ?? []));
        return $result;
    }
}
