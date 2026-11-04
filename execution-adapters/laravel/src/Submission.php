<?php
/**
 * Trusted server-side submission handler — PHP port of execution-adapters/node
 * (mirrors the verified Python port). Re-validates and re-authorizes EVERY
 * submission; client-side hiding is never authorization. Operations resolve only
 * against a registered OperationRegistry; missing operations fail with
 * SUBMISSION_OPERATION_UNRESOLVED. Audit records value PATHS only, never values.
 *
 * Operates on the shared deterministic FormIR (compile once with the TS compiler:
 * `vds-form compile --json`). STATUS: implemented-not-verified (no PHP runtime).
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
    private array $idempotency;

    public function __construct(array $forms, OperationRegistry $operations, $rbac = null, ?callable $audit = null, ?array &$idempotencyStore = null)
    {
        $this->operations = $operations;
        $this->rbac = $rbac;
        $this->audit = $audit;
        $this->idempotency = $idempotencyStore ?? [];
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

    public function handle(array $request): array
    {
        $started = microtime(true);
        $ir = $this->irs[$request['formId']] ?? null;
        if ($ir === null) return ['status' => 'config-error', 'code' => 'SUBMISSION_OPERATION_UNRESOLVED', 'message' => "Form \"{$request['formId']}\" is not registered on this server."];
        $submission = $ir['submission'] ?? [];
        $operationRef = $request['operationRef'] ?? ($submission['operationRef'] ?? '');
        $reqValues = $request['values'] ?? [];

        $audit = function (array $result, array $issueCodes = []) use ($ir, $operationRef, $request, $reqValues): void {
            if (!$this->audit) return;
            ($this->audit)([
                'timestamp' => gmdate('c'), 'formId' => $ir['formId'], 'formVersion' => $ir['formVersion'],
                'operationRef' => $operationRef, 'correlationId' => $request['correlationId'] ?? '',
                'idempotencyKey' => $request['idempotencyKey'],
                'userId' => $request['auth']['userId'] ?? null, 'tenantId' => $request['auth']['tenantId'] ?? null,
                'outcome' => $result['status'], 'issueCodes' => $issueCodes,
                'valuePaths' => array_keys($reqValues),
            ]);
        };

        $cacheKey = $request['formId'] . '|' . $request['idempotencyKey'];
        if (isset($this->idempotency[$cacheKey])) { $cached = $this->idempotency[$cacheKey]; $audit($cached, ['IDEMPOTENT_REPLAY']); return $cached; }

        if (!empty($request['formVersion']) && $request['formVersion'] !== $ir['formVersion']) {
            $result = ['status' => 'server-validation-failed', 'issues' => [self::serverIssue('FORM_VERSION_MISMATCH', "Client form version {$request['formVersion']} != server {$ir['formVersion']}.")]];
            $audit($result, ['FORM_VERSION_MISMATCH']);
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
            $audit($result, array_map(fn($i) => $i['code'], $validation['issues']));
            return $result;
        }

        $security = $ir['security'] ?? [];
        $required = $security['submitPermissions'] ?? [];
        if ($required) {
            if ($this->rbac === null) {
                $result = ['status' => 'permission-denied', 'code' => 'RBAC_NOT_CONFIGURED', 'message' => 'Form declares submitPermissions but no RBAC evaluator is registered on the server.', 'requiredPermissions' => $required];
                $audit($result, ['RBAC_NOT_CONFIGURED']);
                return $result;
            }
            $decision = $this->rbac->evaluate($request['auth'] ?? null, $required);
            if (!$decision['allowed']) {
                $result = ['status' => 'permission-denied', 'code' => 'PERMISSION_DENIED', 'message' => 'Missing permissions: ' . implode(', ', $decision['missing']), 'requiredPermissions' => $decision['missing']];
                $audit($result, ['PERMISSION_DENIED']);
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
            $decision = $this->rbac ? $this->rbac->evaluate($request['auth'] ?? null, $writePerms) : ['allowed' => false, 'missing' => $writePerms];
            if (!$decision['allowed']) {
                $result = ['status' => 'permission-denied', 'code' => 'FIELD_WRITE_DENIED', 'message' => "Not permitted to write field \"{$field['key']}\".", 'requiredPermissions' => $decision['missing']];
                $audit($result, ['FIELD_WRITE_DENIED']);
                return $result;
            }
        }

        $handler = $this->operations->resolve($operationRef);
        if ($handler === null) {
            $result = ['status' => 'config-error', 'code' => 'SUBMISSION_OPERATION_UNRESOLVED', 'message' => "Operation \"$operationRef\" is not registered on this server."];
            $audit($result, ['SUBMISSION_OPERATION_UNRESOLVED']);
            return $result;
        }

        try {
            $data = $handler($reqValues, ['auth' => $request['auth'] ?? null, 'idempotencyKey' => $request['idempotencyKey'], 'correlationId' => $request['correlationId'] ?? '', 'formId' => $ir['formId']]);
            $result = ['status' => 'succeeded', 'operationRef' => $operationRef, 'data' => $data, 'idempotencyKey' => $request['idempotencyKey'], 'durationMs' => (int)((microtime(true) - $started) * 1000)];
        } catch (\Throwable $e) {
            $issues = property_exists($e, 'issues') ? $e->issues : null;
            $code = property_exists($e, 'code') ? $e->code : null;
            if ($issues) $result = ['status' => 'server-validation-failed', 'issues' => array_map(fn($i) => array_merge($i, ['source' => 'server']), $issues)];
            elseif ($code === 'PERMISSION_DENIED') $result = ['status' => 'permission-denied', 'code' => $code, 'message' => $e->getMessage() ?: 'Denied by operation.'];
            else $result = ['status' => 'business-rejected', 'code' => $code ?: 'OPERATION_FAILED', 'message' => $e->getMessage() ?: 'Operation failed.'];
        }

        if ($result['status'] === 'succeeded') $this->idempotency[$cacheKey] = $result;
        $audit($result, array_map(fn($i) => $i['code'], $result['issues'] ?? []));
        return $result;
    }
}
