/** Canonical layout-node coverage for the Angular renderer (mission §4.7, §8). */
import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import type { FormIR } from '@vds-form/types';
import { UniversalFormComponent } from '../src/index';

const irOf = (): FormIR => {
  const def = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'layout-nodes.vds.json'), 'utf8'));
  const r = compileForm(def);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};
const tick = () => new Promise((r) => setTimeout(r, 20));

async function mount() {
  const controller = new FormController({ ir: irOf() });
  await controller.initialize();
  await TestBed.configureTestingModule({ imports: [UniversalFormComponent] }).compileComponents();
  const fixture = TestBed.createComponent(UniversalFormComponent);
  fixture.componentRef.setInput('controller', controller);
  fixture.detectChanges();
  await tick();
  fixture.detectChanges();
  return { controller, fixture, el: fixture.nativeElement as HTMLElement };
}
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Angular canonical layout nodes', () => {
  it('renders section, group, row, columns, fieldset, divider and text', async () => {
    const { el } = await mount();
    expect(q(el, 'layout-grp')).toBeTruthy();
    expect(q(el, 'layout-rw')?.style.display).toBe('grid');
    expect(q(el, 'layout-cols')?.style.display).toBe('grid');
    expect(q(el, 'fieldset-fs')?.tagName).toBe('FIELDSET');
    expect(el.textContent).toContain('Every canonical layout node appears below.');
  });

  it('tabs switch panels', async () => {
    const { el, fixture } = await mount();
    expect(q(el, 'tabs-tbs')).toBeTruthy();
    expect(q(el, 'input-tabTwoNote')).toBeNull();
    q(el, 'tab-tbs-1')!.click();
    fixture.detectChanges();
    await tick();
    fixture.detectChanges();
    expect(q(el, 'tab-tbs-1')!.getAttribute('aria-selected')).toBe('true');
    expect(q(el, 'input-tabTwoNote')).toBeTruthy();
  });

  it('accordion panels expand and collapse', async () => {
    const { el, fixture } = await mount();
    expect(q(el, 'accordion-toggle-accPanel')!.getAttribute('aria-expanded')).toBe('false');
    q(el, 'accordion-toggle-accPanel')!.click();
    fixture.detectChanges();
    expect(q(el, 'input-accordionNote')).toBeTruthy();
    q(el, 'accordion-toggle-accPanel')!.click();
    fixture.detectChanges();
    expect(q(el, 'input-accordionNote')).toBeNull();
  });

  it('repeater layout node renders the referenced repeater', async () => {
    const { el } = await mount();
    expect(q(el, 'repeater-contacts')).toBeTruthy();
  });

  it('steps render and summary reflects values', async () => {
    const { el, fixture } = await mount();
    expect(q(el, 'wizard')).toBeTruthy();
    const input = el.querySelector('[data-testid="input-fullName"]') as HTMLInputElement;
    input.value = 'Ada Lovelace';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    q(el, 'wizard-next')!.click();
    fixture.detectChanges();
    await tick();
    fixture.detectChanges();
    q(el, 'wizard-next')!.click();
    fixture.detectChanges();
    await tick();
    fixture.detectChanges();
    expect(q(el, 'summary')?.textContent).toContain('Ada Lovelace');
  });
});
