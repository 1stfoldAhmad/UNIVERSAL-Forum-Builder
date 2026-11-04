/** Cross-language idempotency parity: the TS adapter must reproduce the shared
 * canonical-JSON / fingerprint / scoped-key vectors byte-for-byte. Python and
 * PHP run the same fixture in their own suites. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, payloadFingerprint, scopedIdempotencyKey } from '../src/idempotency';

const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'form-conformance', 'fixtures', 'idempotency.json'), 'utf8'));

describe('idempotency cross-language parity', () => {
  it('canonicalJson matches the shared vectors', () => {
    for (const c of fixture.canonical) expect(canonicalJson(c.input)).toBe(c.expected);
  });
  it('payloadFingerprint matches the shared vectors', () => {
    for (const c of fixture.fingerprint) expect(payloadFingerprint(c.input)).toBe(c.expected);
  });
  it('scopedIdempotencyKey matches the shared vectors', () => {
    for (const c of fixture.scopedKey) expect(scopedIdempotencyKey(c.input)).toBe(c.expected);
  });
});
