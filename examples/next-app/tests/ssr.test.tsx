/**
 * Server-side rendering of the Next.js client boundary (mission §8).
 * Runs in the NODE environment: there is no window/document, so any accidental
 * browser-API usage during SSR fails this test.
 */
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import type { FormIR } from '@vds-form/types';
import { FormClient } from '../app/FormClient';

const ir = (): FormIR => {
  const def = JSON.parse(readFileSync(join(__dirname, '..', '..', 'forms', 'contact.vds.json'), 'utf8'));
  const r = compileForm(def);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};

describe('Next.js example — SSR', () => {
  it('has no browser globals in this environment', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('renders the form to HTML on the server without browser APIs', () => {
    const html = renderToString(<FormClient ir={ir()} />);
    expect(html).toContain('data-testid="universal-form"');
    expect(html).toContain('data-testid="input-name"');
    expect(html).toContain('data-testid="input-email"');
    expect(html).toContain('Full name');
  });

  it('serializes FormIR to plain JSON that round-trips exactly', () => {
    const compiled = ir();
    const roundTripped = JSON.parse(JSON.stringify(compiled));
    expect(roundTripped).toEqual(compiled);
    // No functions or undefined leak across the boundary.
    expect(JSON.stringify(compiled)).not.toContain('undefined');
  });

  it('server and client render the same initial markup (hydration-safe)', () => {
    const a = renderToString(<FormClient ir={ir()} />);
    const b = renderToString(<FormClient ir={JSON.parse(JSON.stringify(ir()))} />);
    expect(a).toBe(b);
  });

  it('does not leak the trusted handler or operation registry into the client module', () => {
    const source = readFileSync(join(__dirname, '..', 'app', 'FormClient.tsx'), 'utf8');
    expect(source).toContain("'use client'");
    expect(source).not.toContain('TrustedSubmissionHandler');
    expect(source).not.toContain('OperationRegistry');
    expect(source).not.toContain('execution-node');
  });
});
