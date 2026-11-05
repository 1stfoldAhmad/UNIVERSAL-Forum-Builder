/**
 * Canonical layout-node coverage for the React renderer (mission §4.7, §8).
 * Backs the `layoutStatus: supported` claims in REACT_CAPABILITY_MANIFEST.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import type { FormIR } from '@vds-form/types';
import { UniversalForm } from '../src/index';

const irOf = (): FormIR => {
  const def = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'layout-nodes.vds.json'), 'utf8'));
  const r = compileForm(def);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};

async function mount() {
  const controller = new FormController({ ir: irOf() });
  await controller.initialize();
  const utils = render(<UniversalForm controller={controller} />);
  return { controller, ...utils };
}

describe('React canonical layout nodes', () => {
  it('renders section, group, row, columns, fieldset, divider and text', async () => {
    await mount();
    expect(screen.getByTestId('layout-root')).toBeTruthy();
    expect(screen.getByTestId('layout-grp')).toBeTruthy();
    expect(screen.getByTestId('layout-rw').querySelector('div')?.style.display).toBe('grid');
    expect(screen.getByTestId('layout-cols').querySelector('div')?.style.display).toBe('grid');
    expect(screen.getByTestId('fieldset-fs').tagName).toBe('FIELDSET');
    expect(screen.getByText('Every canonical layout node appears below.')).toBeTruthy();
  });

  it('tabs switch panels and expose role=tab/tabpanel', async () => {
    await mount();
    const tablist = screen.getByTestId('tabs-tbs').querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    const tabB = screen.getByTestId('tab-tbs-1');
    expect(screen.queryByTestId('input-tabTwoNote')).toBeNull();
    fireEvent.click(tabB);
    expect(tabB.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('input-tabTwoNote')).toBeTruthy();
  });

  it('accordion panels expand and collapse', async () => {
    await mount();
    const toggle = screen.getByTestId('accordion-toggle-accPanel');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('input-accordionNote')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('input-accordionNote')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('input-accordionNote')).toBeNull();
  });

  it('repeater layout node renders the referenced repeater', async () => {
    await mount();
    expect(screen.getByTestId('repeater-contacts')).toBeTruthy();
  });

  it('steps and summary render, and summary shows current values', async () => {
    await mount();
    expect(screen.getByTestId('wizard')).toBeTruthy();
    // fullName is referenced by several layout nodes; drive the first control.
    fireEvent.change(screen.getAllByTestId('input-fullName')[0], { target: { value: 'Ada Lovelace' } });
    // Walk to the summary step (advancing is async: it validates first).
    fireEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => expect(screen.getByTestId('input-stepTwoNote')).toBeTruthy());
    fireEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => expect(screen.getByTestId('summary')).toBeTruthy());
    expect(screen.getByTestId('summary').textContent).toContain('Ada Lovelace');
  });
});
