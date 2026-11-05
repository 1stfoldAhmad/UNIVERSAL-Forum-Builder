// @vitest-environment jsdom
/**
 * Hydration of the server-rendered markup (mission §8). Asserts React reports no
 * hydration mismatch and that the hydrated form is interactive.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act } from 'react';
import { compileForm } from '@vds-form/compiler';
import type { FormIR } from '@vds-form/types';
import { FormClient } from '../app/FormClient';

const ir = (): FormIR => {
  const def = JSON.parse(readFileSync(join(__dirname, '..', '..', 'forms', 'contact.vds.json'), 'utf8'));
  const r = compileForm(def);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};

describe('Next.js example — hydration', () => {
  it('hydrates server markup without a mismatch and stays interactive', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });

    const html = renderToString(<FormClient ir={ir()} />);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <FormClient ir={ir()} />);
    });

    const hydrationErrors = errors.filter((e) => /hydrat|did not match|server HTML/i.test(JSON.stringify(e)));
    expect(hydrationErrors, JSON.stringify(hydrationErrors)).toEqual([]);

    const input = container.querySelector('[data-testid="input-name"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      input.value = 'Ada Lovelace';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('Ada Lovelace');

    spy.mockRestore();
    container.remove();
  });
});
