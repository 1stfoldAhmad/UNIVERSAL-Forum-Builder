<?php
/**
 * Atomic idempotency storage for the trusted Laravel/PHP execution adapter.
 *
 * Mirrors execution-adapters/node/src/idempotency.ts and the Python
 * vds_form.idempotency module byte-for-byte so the canonical payload
 * fingerprint and scoped key are identical across languages:
 *
 * - Keys are scoped by tenant + user + form + operation (no cross-principal replay).
 * - Every claim carries a canonical SHA-256 payload fingerprint (no payload-swap).
 * - claim() is atomic: the in-memory store is single-process; the PDO store uses
 *   a UNIQUE primary key so concurrent requests cannot all execute.
 * - IdempotencyStore is an interface: hosts plug in a durable database-backed
 *   store. PdoIdempotencyStore is a durable reference (SQLite/MySQL/Postgres).
 *
 * Known PHP limitation: json_decode(..., true) cannot distinguish an empty JSON
 * object {} from an empty array []; both become []. Canonicalization treats an
 * empty PHP array as []. Fingerprints only need to be consistent per backend,
 * and the shared parity vectors avoid the ambiguous empty-object case.
 */
declare(strict_types=1);

namespace VdsForm;

final class Idempotency
{
    /** Canonical JSON: recursively sorted object keys, no whitespace, UTF-8. */
    public static function canonicalJson($value): string
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
        if ($value === null || !is_array($value)) {
            return json_encode($value, $flags);
        }
        if (array_is_list($value)) {
            return '[' . implode(',', array_map([self::class, 'canonicalJson'], $value)) . ']';
        }
        ksort($value, SORT_STRING);
        $parts = [];
        foreach ($value as $k => $v) {
            $parts[] = json_encode((string)$k, $flags) . ':' . self::canonicalJson($v);
        }
        return '{' . implode(',', $parts) . '}';
    }

    public static function payloadFingerprint($values): string
    {
        return hash('sha256', self::canonicalJson($values));
    }

    public static function scopedIdempotencyKey(?string $tenantId, ?string $userId, string $formId, string $operationRef, string $idempotencyKey): string
    {
        return hash('sha256', self::canonicalJson([$tenantId ?? '', $userId ?? '', $formId, $operationRef, $idempotencyKey]));
    }
}

interface IdempotencyStore
{
    /** Atomically claim a scoped key for a payload fingerprint. */
    public function claim(string $key, string $fingerprint): array;
    /** Record the successful result for a claimed key. */
    public function complete(string $key, array $result): void;
    /** Release an in-progress claim after a failed execution so retries can run. */
    public function release(string $key): void;
}

/** Single-process store. NOT durable across restarts; use PdoIdempotencyStore in production. */
final class InMemoryIdempotencyStore implements IdempotencyStore
{
    private array $records = [];

    public function claim(string $key, string $fingerprint): array
    {
        if (!isset($this->records[$key])) {
            $this->records[$key] = ['fingerprint' => $fingerprint, 'status' => 'in-progress'];
            return ['kind' => 'claimed'];
        }
        $rec = $this->records[$key];
        if ($rec['fingerprint'] !== $fingerprint) return ['kind' => 'conflict'];
        if ($rec['status'] === 'complete' && isset($rec['result'])) return ['kind' => 'replay', 'result' => $rec['result']];
        return ['kind' => 'in-progress'];
    }

    public function complete(string $key, array $result): void
    {
        if (isset($this->records[$key])) {
            $this->records[$key]['status'] = 'complete';
            $this->records[$key]['result'] = $result;
        }
    }

    public function release(string $key): void
    {
        if (isset($this->records[$key]) && $this->records[$key]['status'] === 'in-progress') {
            unset($this->records[$key]);
        }
    }
}

/**
 * Durable reference store backed by PDO (SQLite/MySQL/Postgres). The UNIQUE
 * primary key makes claim atomic across processes: the first INSERT wins, the
 * rest observe the existing row. Hosts may pass any PDO connection.
 */
final class PdoIdempotencyStore implements IdempotencyStore
{
    private \PDO $pdo;

    public function __construct(\PDO $pdo)
    {
        $this->pdo = $pdo;
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec(
            'CREATE TABLE IF NOT EXISTS vds_form_idempotency (
                idem_key VARCHAR(190) PRIMARY KEY,
                fingerprint VARCHAR(64) NOT NULL,
                status VARCHAR(16) NOT NULL,
                result_json TEXT NULL,
                created_at VARCHAR(40) NOT NULL
            )'
        );
    }

    public static function sqlite(string $path): self
    {
        return new self(new \PDO('sqlite:' . $path));
    }

    public function claim(string $key, string $fingerprint): array
    {
        try {
            $stmt = $this->pdo->prepare('INSERT INTO vds_form_idempotency (idem_key, fingerprint, status, created_at) VALUES (?, ?, ?, ?)');
            $stmt->execute([$key, $fingerprint, 'in-progress', gmdate('c')]);
            return ['kind' => 'claimed'];
        } catch (\PDOException $e) {
            // Unique violation (SQLite/MySQL 23000, Postgres 23505) → row exists.
            $sqlstate = $e->getCode();
            if ($sqlstate !== '23000' && $sqlstate !== '23505' && !str_contains(strtolower($e->getMessage()), 'unique')) {
                throw $e;
            }
            $stmt = $this->pdo->prepare('SELECT fingerprint, status, result_json FROM vds_form_idempotency WHERE idem_key = ?');
            $stmt->execute([$key]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            if ($row === false) return ['kind' => 'in-progress'];
            if ($row['fingerprint'] !== $fingerprint) return ['kind' => 'conflict'];
            if ($row['status'] === 'complete' && $row['result_json'] !== null) {
                return ['kind' => 'replay', 'result' => json_decode($row['result_json'], true)];
            }
            return ['kind' => 'in-progress'];
        }
    }

    public function complete(string $key, array $result): void
    {
        $stmt = $this->pdo->prepare('UPDATE vds_form_idempotency SET status = ?, result_json = ? WHERE idem_key = ?');
        $stmt->execute(['complete', json_encode($result), $key]);
    }

    public function release(string $key): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM vds_form_idempotency WHERE idem_key = ? AND status = ?');
        $stmt->execute([$key, 'in-progress']);
    }
}
