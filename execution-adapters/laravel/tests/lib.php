<?php
/**
 * Shared test harness for the Laravel/PHP adapter runners. Framework-free: no
 * PHPUnit or Illuminate required, so the trusted handler, controller, security
 * boundary, and cross-language conformance can all be verified wherever PHP >=
 * 8.1 runs (including CI). Each runner requires this file and calls finish().
 */
declare(strict_types=1);

require_once __DIR__ . '/../src/Policy.php';
require_once __DIR__ . '/../src/Payload.php';


// Load Composer's autoloader when present so optional integrations (e.g. a real
// Illuminate\Http\Request in CI) are available. The core suites never require it.
$autoload = __DIR__ . '/../vendor/autoload.php';
if (file_exists($autoload)) require $autoload;

final class Runner
{
    public int $passed = 0;
    public int $failed = 0;
    public array $failures = [];

    public function check(string $id, bool $ok, string $detail = ''): void
    {
        if ($ok) { $this->passed++; }
        else { $this->failed++; $this->failures[] = "  FAIL $id" . ($detail !== '' ? "\n    $detail" : ''); }
    }

    public function eq(string $id, $expected, $actual): void
    {
        $ok = $expected === $actual;
        $this->check($id, $ok, $ok ? '' : 'expected ' . json_encode($expected) . ', got ' . json_encode($actual));
    }

    public function finish(string $suite): int
    {
        $total = $this->passed + $this->failed;
        echo "$suite: {$this->passed}/$total passed, {$this->failed} failed.\n";
        foreach ($this->failures as $f) fwrite(STDERR, $f . "\n");
        return $this->failed === 0 ? 0 : 1;
    }
}

function load_ir(string $name): array
{
    return json_decode(file_get_contents(__DIR__ . '/fixtures/ir/' . $name), true, 512, JSON_THROW_ON_ERROR);
}

function load_shared(string $name): array
{
    $base = getenv('VDS_CONFORMANCE_FIXTURES') ?: __DIR__ . '/../../../packages/form-conformance/fixtures';
    return json_decode(file_get_contents($base . '/' . $name), true, 512, JSON_THROW_ON_ERROR);
}

function auth_ctx(string $userId, array $perms, ?string $tenant = 't1'): array
{
    return ['userId' => $userId, 'tenantId' => $tenant, 'roles' => [], 'permissions' => $perms];
}

/** A gated copy of the contact IR (requires contact:create to submit). */
function gated_contact_ir(): array
{
    $ir = load_ir('contact.ir.json');
    $ir['security']['submitPermissions'] = ['contact:create'];
    return $ir;
}

const VALID_CONTACT = ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'message' => 'Hello from the Laravel adapter.'];

function contact_request(array $over = []): array
{
    return array_merge(['formId' => 'contact', 'values' => VALID_CONTACT, 'idempotencyKey' => 'k', 'correlationId' => 'c'], $over);
}

/**
 * Build a handler with a counting contact operation and a privileged decoy
 * operation. Returns [handler, ArrayObject $calls]; the ArrayObject is shared by
 * handle so the call log propagates (PHP list-destructuring copies by value, so
 * a plain array returned by reference would NOT propagate). Read via
 * $calls->getArrayCopy().
 */
function make_security_handler(?object $store = null, ?array $allowed = null, ?array $ir = null): array
{
    $calls = new \ArrayObject();
    $ops = new \VdsForm\OperationRegistry();
    $ops->register('test:contact.create', function ($p, $c) use ($calls) { $calls->append('contact.create'); return ['id' => 'rec-' . count($calls)]; });
    $ops->register('test:admin.wipe', function ($p, $c) use ($calls) { $calls->append('admin.wipe'); return ['wiped' => true]; });
    $handler = new \VdsForm\TrustedSubmissionHandler(
        ['contact' => $ir ?? load_ir('contact.ir.json')],
        $ops, new \VdsForm\SimpleRbacEvaluator(), null, $store, $allowed
    );
    return [$handler, $calls];
}
