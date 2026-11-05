/** Canonical layout-node coverage for the Vue renderer (mission §4.7, §8). */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileForm } from '@vds-form/compiler';
import { FormController } from '@vds-form/runtime';
import type { FormIR } from '@vds-form/types';
import { VUniversalForm } from '../src/index';

const irOf = (): FormIR => {
  const def = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'examples', 'forms', 'layout-nodes.vds.json'), 'utf8'));
  const r = compileForm(def);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.ir;
};
const tick = () => new Promise((r) => setTimeout(r, 20));

async function mountForm() {
  const controller = new FormController({ ir: irOf() });
  await controller.initialize();
  const wrapper = mount(VUniversalForm, { props: { controller } });
  await tick();
  return { controller, wrapper };
}
const q = (w: any, id: string) => w.find(`[data-testid="${id}"]`);

describe('Vue canonical layout nodes', () => {
  it('renders section, group, row, columns, fieldset, divider and text', async () => {
    const { wrapper } = await mountForm();
    expect(q(wrapper, 'layout-root').exists()).toBe(true);
    expect(q(wrapper, 'layout-grp').exists()).toBe(true);
    expect(q(wrapper, 'layout-rw').attributes('style')).toContain('grid');
    expect(q(wrapper, 'layout-cols').attributes('style')).toContain('grid');
    expect(q(wrapper, 'fieldset-fs').element.tagName).toBe('FIELDSET');
    expect(wrapper.text()).toContain('Every canonical layout node appears below.');
  });

  it('tabs switch panels', async () => {
    const { wrapper } = await mountForm();
    expect(q(wrapper, 'tabs-tbs').exists()).toBe(true);
    expect(q(wrapper, 'input-tabTwoNote').exists()).toBe(false);
    await q(wrapper, 'tab-tbs-1').trigger('click');
    await tick();
    expect(q(wrapper, 'tab-tbs-1').attributes('aria-selected')).toBe('true');
    expect(q(wrapper, 'input-tabTwoNote').exists()).toBe(true);
  });

  it('accordion panels expand and collapse', async () => {
    const { wrapper } = await mountForm();
    const toggle = q(wrapper, 'accordion-toggle-accPanel');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    await tick();
    expect(q(wrapper, 'input-accordionNote').exists()).toBe(true);
    await q(wrapper, 'accordion-toggle-accPanel').trigger('click');
    await tick();
    expect(q(wrapper, 'input-accordionNote').exists()).toBe(false);
  });

  it('repeater layout node renders the referenced repeater', async () => {
    const { wrapper } = await mountForm();
    expect(q(wrapper, 'repeater-contacts').exists()).toBe(true);
  });

  it('steps and summary render with current values', async () => {
    const { wrapper } = await mountForm();
    expect(q(wrapper, 'wizard').exists()).toBe(true);
    await wrapper.findAll('[data-testid="input-fullName"]')[0].setValue('Ada Lovelace');
    await q(wrapper, 'wizard-next').trigger('click');
    await tick();
    await q(wrapper, 'wizard-next').trigger('click');
    await tick();
    expect(q(wrapper, 'summary').text()).toContain('Ada Lovelace');
  });
});
