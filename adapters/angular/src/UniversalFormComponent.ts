import {
  Component, EventEmitter, Input, OnChanges, OnDestroy, Output, signal, type SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { uploadAssetBatch, type FormController } from '@vds-form/runtime';
import type { FormSnapshot, LayoutNode, LocalizedText, NormalizedField, FieldOption, SubmissionResult, UploadedAssetRef } from '@vds-form/types';
import { localize } from '@vds-form/validation';

@Component({
  selector: 'vds-universal-form',
  standalone: true,
  imports: [CommonModule],
  template: `
<form novalidate (submit)="onSubmit($event)" data-testid="universal-form"
      style="max-width:640px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif;">
  <h2 style="margin-top:0;">{{ controller.ir.formId }}</h2>

  <ng-container *ngTemplateOutlet="nodes; context: { $implicit: [controller.ir.layout] }"></ng-container>

  <div *ngIf="errorIssues().length && (snap()?.state === 'invalid' || snap()?.submission?.status === 'failed')"
       role="alert" data-testid="error-summary"
       style="background:#fdecea;border-radius:8px;padding:12px;margin-bottom:12px;">
    <strong style="color:#c0392b;">{{ errorIssues().length }} problems to fix:</strong>
    <ul style="margin:6px 0 0;padding-left:18px;">
      <li *ngFor="let i of errorIssues().slice(0, 8)" style="color:#c0392b;font-size:13px;">{{ i.message }} ({{ i.path }})</li>
    </ul>
  </div>

  <div aria-live="polite">
    <p *ngIf="snap()?.submission?.result?.status === 'succeeded'" data-testid="submit-success"
       style="color:#1b5e20;font-weight:600;background:#e8f5e9;padding:12px;border-radius:8px;">Submitted successfully.</p>
    <p *ngIf="snap()?.submission?.result?.status === 'queued-offline'" data-testid="submit-queued"
       style="color:#8d6e00;background:#fff8e1;padding:12px;border-radius:8px;">Saved offline — not yet submitted to the server.</p>
    <p *ngIf="isFailedResult()" role="alert" data-testid="submit-error"
       style="color:#c0392b;background:#fdecea;padding:12px;border-radius:8px;">Submission failed: {{ resultMessage() }}</p>
  </div>

  <button type="button" data-testid="submit-button" (click)="onSubmit()"
          [disabled]="submitting() || snap()?.state === 'submitting'" [attr.aria-busy]="submitting()"
          style="background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;">
    {{ submitting() || snap()?.state === 'submitting' ? 'Submitting…' : (submitLabel || 'Submit') }}
  </button>
</form>

<!-- Recursive layout nodes -->
<ng-template #nodes let-nodeList>
  <ng-container *ngFor="let node of nodeList">
    <ng-container [ngSwitch]="node.type">
      <div *ngSwitchCase="'steps'" data-testid="wizard">
        <h3 style="margin:0 0 12px;">{{ stepTitle() }}</h3>
        <ng-container *ngIf="currentStep()?.type === 'summary'; else stepBody">
          <dl data-testid="summary">
            <div *ngFor="let f of summaryFields()" style="display:flex;justify-content:space-between;padding:4px 0;">
              <dt style="color:#555;">{{ loc(f.label) }}</dt>
              <dd style="margin:0;font-weight:600;">{{ displayValue(f.key) }}</dd>
            </div>
          </dl>
        </ng-container>
        <ng-template #stepBody>
          <ng-container *ngTemplateOutlet="nodes; context: { $implicit: [currentStep()] }"></ng-container>
        </ng-template>
        <div style="display:flex;justify-content:space-between;margin-top:10px;">
          <button type="button" data-testid="wizard-back" [disabled]="stepIndex() === 0" (click)="stepBack()"
                  style="background:#e9e9e9;color:#222;border:none;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer;">Back</button>
          <button *ngIf="!isLastStep()" type="button" data-testid="wizard-next" (click)="stepNext()"
                  style="background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer;">Next</button>
        </div>
      </div>
      <hr *ngSwitchCase="'divider'" style="border:none;border-top:1px solid #e0e0e0;margin:14px 0;" />
      <p *ngSwitchCase="'text'" style="color:#444;">{{ node.text ? loc(node.text) : '' }}</p>
      <ng-container *ngSwitchCase="'repeater'">
        <ng-container *ngTemplateOutlet="field; context: { $implicit: fieldById(node.repeaterRef), path: fieldById(node.repeaterRef)?.key }"></ng-container>
      </ng-container>
      <div *ngSwitchCase="'tabs'" [attr.data-testid]="node.id ? 'tabs-' + node.id : 'tabs'">
        <div role="tablist" style="display:flex;gap:4px;margin-bottom:10px;">
          <button *ngFor="let t of node.children || []; let i = index" type="button" role="tab"
                  [attr.aria-selected]="i === tabIndexFor(node)"
                  [attr.data-testid]="'tab-' + (node.id || 'root') + '-' + i"
                  (click)="selectTab(node, i)"
                  [style.background]="i === tabIndexFor(node) ? '#eef2ff' : '#fff'"
                  [style.font-weight]="i === tabIndexFor(node) ? 600 : 400"
                  style="padding:6px 12px;border:1px solid #ccc;border-radius:6px;">
            {{ t.title ? loc(t.title) : 'Tab ' + (i + 1) }}
          </button>
        </div>
        <div role="tabpanel">
          <ng-container *ngTemplateOutlet="nodes; context: { $implicit: [activeTab(node)] }"></ng-container>
        </div>
      </div>
      <div *ngSwitchCase="'accordion'" [attr.data-testid]="node.id ? 'accordion-' + node.id : 'accordion'">
        <div *ngFor="let child of node.children || []; let i = index" style="border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;">
          <button type="button" [attr.aria-expanded]="panelOpen(node, child, i)"
                  [attr.data-testid]="'accordion-toggle-' + (child.id || i)"
                  (click)="togglePanel(node, child, i)"
                  style="width:100%;text-align:left;padding:8px 12px;background:#fafafa;border:none;cursor:pointer;">
            {{ child.title ? loc(child.title) : 'Section ' + (i + 1) }}
          </button>
          <div *ngIf="panelOpen(node, child, i)" style="padding:12px;">
            <ng-container *ngTemplateOutlet="nodes; context: { $implicit: [child] }"></ng-container>
          </div>
        </div>
      </div>
      <fieldset *ngSwitchCase="'fieldset'" [attr.data-testid]="node.id ? 'fieldset-' + node.id : 'fieldset'"
                style="border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:16px;">
        <legend *ngIf="node.title">{{ loc(node.title) }}</legend>
        <ng-container *ngFor="let ref of node.fieldRefs || []">
          <ng-container *ngTemplateOutlet="field; context: { $implicit: fieldById(ref), path: fieldById(ref)?.key }"></ng-container>
        </ng-container>
        <ng-container *ngTemplateOutlet="nodes; context: { $implicit: node.children || [] }"></ng-container>
      </fieldset>
      <dl *ngSwitchCase="'summary'" [attr.data-testid]="node.id ? 'summary-' + node.id : 'summary'">
        <div *ngFor="let f of summaryFieldsFor(node)" style="display:flex;justify-content:space-between;padding:4px 0;">
          <dt style="color:#555;">{{ loc(f.label) }}</dt>
          <dd style="margin:0;font-weight:600;" [attr.data-testid]="'summary-value-' + f.id">{{ displayValue(f.key) }}</dd>
        </div>
      </dl>
      <section *ngSwitchDefault [attr.data-testid]="node.id ? 'layout-' + node.id : null" [style.margin-bottom.px]="16"
               [style.display]="isRowNode(node) ? 'grid' : null"
               [style.grid-template-columns]="isRowNode(node) ? gridColumns(node) : null"
               [style.gap.px]="isRowNode(node) ? 12 : null">
        <h3 *ngIf="node.title" style="margin:0 0 10px;">{{ loc(node.title) }}</h3>
        <p *ngIf="!isKnownLayout(node)" role="note" [attr.data-testid]="'unsupported-layout-' + (node.id || 'root')" style="color:#8d6e00;">
          Unsupported layout node: {{ node.type }}
        </p>
        <ng-container *ngFor="let ref of node.fieldRefs || []">
          <ng-container *ngTemplateOutlet="field; context: { $implicit: fieldById(ref), path: fieldById(ref)?.key }"></ng-container>
        </ng-container>
        <ng-container *ngTemplateOutlet="nodes; context: { $implicit: node.children || [] }"></ng-container>
      </section>
    </ng-container>
  </ng-container>
</ng-template>

<!-- Recursive field -->
<ng-template #field let-f let-path="path">
  <ng-container *ngIf="f && visible(f)">
    <ng-container [ngSwitch]="f.type">
      <fieldset *ngSwitchCase="'group'" [attr.data-testid]="'group-' + f.id"
                style="border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:14px;">
        <legend style="font-weight:700;padding:0 6px;">{{ loc(f.label) }}</legend>
        <ng-container *ngFor="let c of childFields(f.id)">
          <ng-container *ngTemplateOutlet="field; context: { $implicit: c, path: c.key }"></ng-container>
        </ng-container>
      </fieldset>

      <fieldset *ngSwitchCase="'repeater'" [attr.data-testid]="'repeater-' + f.id"
                style="border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:14px;">
        <legend style="font-weight:700;padding:0 6px;">{{ loc(f.label) }}</legend>
        <div *ngFor="let rowId of repeaterRows(f.id); let idx = index" [attr.data-testid]="'row-' + f.id + '-' + rowId"
             style="border:1px solid #eee;border-radius:6px;padding:12px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <strong style="font-size:13px;color:#666;">Entry {{ idx + 1 }}</strong>
            <button type="button" [attr.data-testid]="'remove-' + rowId" [disabled]="repeaterRows(f.id).length <= (f.validation.minItems || 0)"
                    (click)="controller.removeRepeaterItem(f.id, rowId)"
                    style="background:#e9e9e9;color:#c0392b;border:none;border-radius:6px;padding:2px 8px;cursor:pointer;">✕</button>
          </div>
          <ng-container *ngFor="let c of childFields(f.id)">
            <ng-container *ngTemplateOutlet="field; context: { $implicit: c, path: rowPath(c.key, f.key, idx) }"></ng-container>
          </ng-container>
        </div>
        <button type="button" [attr.data-testid]="'add-' + f.id" (click)="controller.addRepeaterItem(f.id)"
                style="background:#e9e9e9;color:#222;border:none;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer;">+ Add entry</button>
      </fieldset>

      <div *ngSwitchDefault [attr.data-testid]="'field-' + path" style="margin-bottom:14px;">
        <label [attr.for]="'input-' + path" style="display:block;font-weight:600;margin-bottom:4px;font-size:14px;">
          {{ loc(f.label) }}<span *ngIf="required(path)" aria-hidden="true" style="color:#c0392b;"> *</span>
        </label>
        <ng-container [ngSwitch]="f.type">
          <textarea *ngSwitchCase="'textarea'" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                    [value]="strValue(path)" [readOnly]="readonly(path)" [disabled]="disabled(path)" [rows]="f.ui.rows || 4"
                    [attr.aria-invalid]="hasError(path) || null" (input)="set(path, $any($event.target).value)" (blur)="controller.blur(path)"
                    style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;"></textarea>

          <select *ngSwitchCase="'select'" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                  [value]="strValue(path)" [disabled]="disabled(path)" (change)="set(path, $any($event.target).value)"
                  style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;">
            <option value="">Select…</option>
            <option *ngFor="let o of options(f.id)" [value]="o.value" [selected]="strValue(path) === (o.value + '')">{{ loc(o.label) }}</option>
          </select>

          <select *ngSwitchCase="'multiselect'" [id]="'input-' + path" [attr.data-testid]="'input-' + path" multiple
                  [disabled]="disabled(path)" (change)="setMulti(path, $event)"
                  style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;min-height:90px;">
            <option *ngFor="let o of options(f.id)" [value]="o.value" [selected]="isSelected(path, o.value)">{{ loc(o.label) }}</option>
          </select>

          <div *ngSwitchCase="'radio'" role="radiogroup">
            <label *ngFor="let o of options(f.id)" style="display:block;padding:3px 0;font-weight:400;">
              <input type="radio" [name]="'radio-' + path" [value]="o.value" [checked]="value(path) === o.value"
                     [disabled]="disabled(path)" [attr.data-testid]="'radio-' + path + '-' + o.value" (change)="set(path, o.value)" />
              {{ loc(o.label) }}
            </label>
          </div>

          <input *ngSwitchCase="'checkbox'" type="checkbox" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [checked]="value(path) === true" [disabled]="disabled(path) || readonly(path)" (change)="set(path, $any($event.target).checked)" />
          <input *ngSwitchCase="'switch'" type="checkbox" role="switch" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [checked]="value(path) === true" [disabled]="disabled(path) || readonly(path)" (change)="set(path, $any($event.target).checked)" />
          <input *ngSwitchCase="'consent'" type="checkbox" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [checked]="value(path) === true" [disabled]="disabled(path) || readonly(path)" (change)="set(path, $any($event.target).checked)" />

          <div *ngSwitchCase="'rating'" role="radiogroup">
            <button *ngFor="let n of ratingRange(f)" type="button" [attr.data-testid]="'rating-' + path + '-' + n"
                    [attr.aria-label]="n + ' of ' + (f.validation.max || 5)" (click)="set(path, n)"
                    [style.color]="n <= numValue(path) ? '#f5a623' : '#ccc'"
                    style="background:none;border:none;font-size:24px;cursor:pointer;">★</button>
          </div>

          <input *ngSwitchCase="'range'" type="range" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [min]="f.validation.min || 0" [max]="f.validation.max || 100" [value]="numValue(path)"
                 [disabled]="disabled(path)" (input)="set(path, +$any($event.target).value)" />

          <div *ngSwitchCase="'file'" [attr.data-testid]="'dropzone-' + path"
               (dragover)="$event.preventDefault()" (drop)="onDrop(path, f, $event)"
               style="border:2px dashed #bbb;border-radius:8px;padding:14px;background:#fafafa;">
            <input type="file" [id]="'input-' + path" [attr.data-testid]="'file-input-' + path" style="display:none;"
                   [accept]="(f.validation.accept || []).join(',')" [multiple]="f.validation.multiple"
                   (change)="onPick(path, f, $event)" />
            <button type="button" [attr.data-testid]="'pick-' + path" (click)="triggerPick(path)"
                    style="background:#e9e9e9;color:#222;border:none;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer;">Choose file</button>
            <p *ngIf="assetNames(path)" [attr.data-testid]="'asset-' + path" style="color:#555;font-size:13px;">{{ assetNames(path) }} ✓ uploaded</p>
            <p *ngIf="uploadError(path)" role="alert" [attr.data-testid]="'upload-error-' + path" style="color:#c0392b;font-size:13px;">{{ uploadError(path) }}</p>
          </div>
          <div *ngSwitchCase="'image'" [attr.data-testid]="'dropzone-' + path"
               (dragover)="$event.preventDefault()" (drop)="onDrop(path, f, $event)"
               style="border:2px dashed #bbb;border-radius:8px;padding:14px;background:#fafafa;">
            <input type="file" [id]="'input-' + path" [attr.data-testid]="'file-input-' + path" style="display:none;"
                   [accept]="(f.validation.accept || []).join(',')" [multiple]="f.validation.multiple"
                   (change)="onPick(path, f, $event)" />
            <button type="button" [attr.data-testid]="'pick-' + path" (click)="triggerPick(path)"
                    style="background:#e9e9e9;color:#222;border:none;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer;">Choose image</button>
            <p *ngIf="assetNames(path)" [attr.data-testid]="'asset-' + path" style="color:#555;font-size:13px;">{{ assetNames(path) }} ✓ uploaded</p>
            <p *ngIf="uploadError(path)" role="alert" [attr.data-testid]="'upload-error-' + path" style="color:#c0392b;font-size:13px;">{{ uploadError(path) }}</p>
          </div>

          <output *ngSwitchCase="'computed'" [id]="'input-' + path" [attr.data-testid]="'computed-' + path"
                  style="display:block;width:100%;padding:8px 10px;background:#f4f6f8;border-radius:6px;font-weight:600;box-sizing:border-box;">{{ computedDisplay(path) }}</output>

          <input *ngSwitchCase="'date'" type="date" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [value]="strValue(path)" [readOnly]="readonly(path)" [disabled]="disabled(path)"
                 (input)="set(path, $any($event.target).value)" (blur)="controller.blur(path)"
                 style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;" />
          <input *ngSwitchCase="'time'" type="time" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [value]="strValue(path)" [readOnly]="readonly(path)" [disabled]="disabled(path)"
                 (input)="set(path, $any($event.target).value)" (blur)="controller.blur(path)"
                 style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;" />
          <input *ngSwitchCase="'datetime'" type="datetime-local" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [value]="strValue(path)" [readOnly]="readonly(path)" [disabled]="disabled(path)"
                 (input)="set(path, $any($event.target).value)" (blur)="controller.blur(path)"
                 style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;" />
          <input *ngSwitchCase="'color'" type="color" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [value]="strValue(path) || '#000000'" [disabled]="disabled(path)" (input)="set(path, $any($event.target).value)"
                 style="display:block;width:100%;height:40px;padding:2px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;" />

          <input *ngSwitchDefault [type]="htmlType(f)" [id]="'input-' + path" [attr.data-testid]="'input-' + path"
                 [value]="strValue(path)" [readOnly]="readonly(path)" [disabled]="disabled(path)"
                 [attr.aria-invalid]="hasError(path) || null" [attr.aria-required]="required(path) || null"
                 [min]="f.validation.min" [max]="f.validation.max"
                 (input)="onInput(path, f, $event)" (blur)="controller.blur(path)"
                 style="display:block;width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box;" />
        </ng-container>
        <p *ngIf="showError(path)" role="alert" [attr.data-testid]="'error-' + path" style="color:#c0392b;font-size:13px;margin-top:3px;">{{ firstError(path) }}</p>
      </div>
    </ng-container>
  </ng-container>
</ng-template>
  `,
})
export class UniversalFormComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) controller!: FormController;
  @Input() locale?: string;
  @Input() submitLabel?: string;
  @Output() submitted = new EventEmitter<SubmissionResult>();

  snap = signal<FormSnapshot | null>(null);
  stepIndex = signal(0);
  submitting = signal(false);
  private unsub?: () => void;
  private uploadErrors = signal<Record<string, string>>({});
  private fieldMap = new Map<string, NormalizedField>();

  ngOnChanges(_changes: SimpleChanges): void {
    this.unsub?.();
    this.fieldMap = new Map(this.controller.ir.fields.map((f) => [f.id, f]));
    this.snap.set(this.controller.getSnapshot());
    this.unsub = this.controller.subscribe((s) => this.snap.set(s));
  }

  ngOnDestroy(): void {
    this.unsub?.();
    for (const ac of this.uploadBatches.values()) ac.abort();
    this.uploadBatches.clear();
    this.uploadIds.clear();
  }

  loc(text: LocalizedText | undefined): string {
    return localize(text, this.locale ?? this.controller.ir.localization.defaultLocale);
  }
  fieldById(id: string | undefined): NormalizedField | undefined { return id ? this.fieldMap.get(id) : undefined; }
  childFields(parentId: string): NormalizedField[] { return this.controller.ir.fields.filter((f) => f.parentId === parentId); }
  repeaterRows(fieldId: string): string[] { return this.snap()?.repeaterRows[fieldId] ?? []; }
  rowPath(childKey: string, repeaterKey: string, idx: number): string { return childKey.replace(`${repeaterKey}[]`, `${repeaterKey}.${idx}`); }
  options(fieldId: string): FieldOption[] { return this.controller.getOptions(fieldId); }

  visible(f: NormalizedField): boolean { return this.snap()?.visibility[f.id] !== false && f.type !== 'hidden'; }
  value(path: string): unknown { return this.controller.getFieldValue(path); }
  strValue(path: string): string { const v = this.value(path); return v === null || v === undefined ? '' : String(v); }
  numValue(path: string): number { const v = this.value(path); return typeof v === 'number' ? v : 0; }
  computedDisplay(path: string): string {
    const v = this.value(path);
    if (v === null || v === undefined) return '—';
    return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
  }
  displayValue(path: string): string { const v = this.value(path); return v === null || v === undefined ? '—' : String(v); }
  required(path: string): boolean { return (this.controller.fieldSlice(path) as { required: boolean }).required; }
  disabled(path: string): boolean { return (this.controller.fieldSlice(path) as { disabled: boolean }).disabled; }
  readonly(path: string): boolean { return (this.controller.fieldSlice(path) as { readonly: boolean }).readonly; }
  hasError(path: string): boolean { return (this.controller.fieldSlice(path) as { issues: unknown[] }).issues.length > 0; }
  firstError(path: string): string {
    const issues = (this.controller.fieldSlice(path) as { issues: Array<{ message: string; severity: string }> }).issues;
    return issues.find((i) => i.severity === 'error')?.message ?? '';
  }
  showError(path: string): boolean {
    const slice = this.controller.fieldSlice(path) as { touched: boolean; issues: Array<{ severity: string }> };
    const submitted = this.snap()?.submission?.status !== 'idle';
    return Boolean(slice.issues.find((i) => i.severity === 'error')) && (slice.touched || submitted);
  }
  errorIssues(): Array<{ message: string; path: string }> { return (this.snap()?.issues ?? []).filter((i) => i.severity === 'error'); }

  set(path: string, v: unknown): void { this.controller.setFieldValue(path, v); }
  onInput(path: string, f: NormalizedField, e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.set(path, this.htmlType(f) === 'number' ? (v === '' ? null : Number(v)) : v);
  }
  setMulti(path: string, e: Event): void {
    this.set(path, Array.from((e.target as HTMLSelectElement).selectedOptions).map((o) => o.value));
  }
  isSelected(path: string, optionValue: unknown): boolean {
    const v = this.value(path);
    return Array.isArray(v) && v.map(String).includes(String(optionValue));
  }
  ratingRange(f: NormalizedField): number[] { const max = f.validation.max ?? 5; return Array.from({ length: max }, (_, i) => i + 1); }
  htmlType(f: NormalizedField): string {
    if (f.type === 'email') return 'email';
    if (f.type === 'password') return 'password';
    if (f.type === 'url') return 'url';
    if (f.type === 'phone') return 'tel';
    if (['integer', 'decimal', 'currency', 'percentage', 'duration'].includes(f.type)) return 'number';
    return 'text';
  }

  // ---- uploads ----
  uploadError(path: string): string { return this.uploadErrors()[path] ?? ''; }
  assetNames(path: string): string {
    const v = this.value(path) as UploadedAssetRef | UploadedAssetRef[] | null;
    if (!v) return '';
    return Array.isArray(v) ? v.map((a) => a.name).join(', ') : v.name;
  }
  triggerPick(path: string): void {
    const el = document.getElementById(`input-${path}`) as HTMLInputElement | null;
    el?.click();
  }
  onPick(path: string, f: NormalizedField, e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files) void this.upload(path, f, files, 'picker');
    input.value = '';
  }
  onDrop(path: string, f: NormalizedField, e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer?.files) void this.upload(path, f, e.dataTransfer.files, 'drag-drop');
  }

  /** In-flight upload batches, aborted on destroy so late results cannot commit. */
  private uploadBatches = new Map<string, AbortController>();
  private uploadIds = new Map<string, Set<string>>();

  private async upload(path: string, f: NormalizedField, files: FileList, source: 'picker' | 'drag-drop'): Promise<void> {
    if (this.uploadBatches.has(path)) return; // ignore re-entrant interaction
    const ac = new AbortController();
    this.uploadBatches.set(path, ac);
    this.uploadErrors.update((m) => { const n = { ...m }; delete n[path]; return n; });
    // Shared semantics: commit after EVERY success so a later failure keeps earlier assets.
    const result = await uploadAssetBatch({
      files: Array.from(files).map((x) => ({ name: x.name, size: x.size, type: x.type, lastModified: x.lastModified })),
      provider: this.controller.uploadProvider,
      constraints: { accept: f.validation.accept, maxSizeBytes: f.validation.maxSizeBytes },
      multiple: f.validation.multiple,
      source,
      currentValue: this.value(path),
      readValue: () => this.value(path),
      seenIdentities: (this.uploadIds.get(path) ?? (() => { const s = new Set<string>(); this.uploadIds.set(path, s); return s; })()),
      auth: this.controller.auth,
      signal: ac.signal,
      commit: (v) => this.set(path, v),
    });
    if (this.uploadBatches.get(path) !== ac) return;
    this.uploadBatches.delete(path);
    if (result.failures.length) {
      this.uploadErrors.update((m) => ({
        ...m,
        [path]: result.failures.map((x) => `${x.name ? `${x.name}: ` : ''}${x.message} [${x.code}]`).join(' '),
      }));
    }
  }

  cancelUpload(path: string): void {
    this.uploadBatches.get(path)?.abort();
    this.uploadBatches.delete(path);
  }

  // ---- wizard ----
  private steps(): LayoutNode[] {
    const walk = (n: LayoutNode): LayoutNode[] => n.type === 'steps' ? (n.children ?? []).filter((c) => c.type === 'step' || c.type === 'summary') : (n.children ?? []).flatMap(walk);
    return walk(this.controller.ir.layout);
  }
  /** Layout state for tabs / accordion (canonical layout nodes). */
  private tabSelection = signal<Record<string, number>>({});
  private openPanels = signal<Record<string, boolean>>({});

  private nodeKey(node: LayoutNode): string { return node.id ?? `${node.type}`; }
  isRowNode(node: LayoutNode): boolean { return node.type === 'row' || node.type === 'columns'; }
  isKnownLayout(node: LayoutNode): boolean {
    return ['section', 'group', 'step', 'tab', 'row', 'columns'].includes(node.type);
  }
  gridColumns(node: LayoutNode): string {
    const n = Math.max(1, (node.fieldRefs?.length ?? 0) + (node.children?.length ?? 0));
    return `repeat(${n},1fr)`;
  }
  tabIndexFor(node: LayoutNode): number {
    const tabs = node.children ?? [];
    return Math.min(Math.max(this.tabSelection()[this.nodeKey(node)] ?? 0, 0), Math.max(0, tabs.length - 1));
  }
  activeTab(node: LayoutNode): LayoutNode {
    const tabs = node.children ?? [];
    return tabs[this.tabIndexFor(node)] ?? { type: 'section' };
  }
  selectTab(node: LayoutNode, i: number): void {
    this.tabSelection.set({ ...this.tabSelection(), [this.nodeKey(node)]: i });
  }
  private panelKey(node: LayoutNode, child: LayoutNode, i: number): string {
    return `${this.nodeKey(node)}-${child.id ?? i}`;
  }
  panelOpen(node: LayoutNode, child: LayoutNode, i: number): boolean {
    return this.openPanels()[this.panelKey(node, child, i)] ?? false;
  }
  togglePanel(node: LayoutNode, child: LayoutNode, i: number): void {
    const k = this.panelKey(node, child, i);
    this.openPanels.set({ ...this.openPanels(), [k]: !this.panelOpen(node, child, i) });
  }
  summaryFieldsFor(node: LayoutNode): NormalizedField[] {
    const ids = node.fieldRefs ?? [];
    const snap = this.snap();
    const list = ids.length
      ? ids.map((id) => this.fieldById(id)).filter((f): f is NormalizedField => !!f)
      : this.controller.ir.fields.filter((f) => !f.parentId && !['group', 'repeater'].includes(f.type));
    return list.filter((f) => (snap?.visibility[f.id] ?? true) && f.type !== 'hidden');
  }

  currentStep(): LayoutNode | undefined { const s = this.steps(); return s[Math.min(this.stepIndex(), s.length - 1)]; }
  isLastStep(): boolean { return this.stepIndex() >= this.steps().length - 1; }
  stepTitle(): string { const c = this.currentStep(); return c?.title ? this.loc(c.title) : `Step ${this.stepIndex() + 1}`; }
  summaryFields(): NormalizedField[] { return this.controller.ir.fields.filter((f) => !f.parentId && !['group', 'repeater'].includes(f.type) && this.snap()?.visibility[f.id] !== false); }
  stepBack(): void { this.stepIndex.set(Math.max(0, this.stepIndex() - 1)); }
  async stepNext(): Promise<void> {
    const collect = (n: LayoutNode | undefined): string[] => n ? [...(n.fieldRefs ?? []), ...(n.children ?? []).flatMap(collect)] : [];
    const ids = collect(this.currentStep());
    for (const id of ids) { const f = this.fieldMap.get(id); if (f) this.controller.blur(f.key); }
    const result = await this.controller.validate();
    const errs = result.issues.some((i) => { const f = this.controller.ir.fields.find((x) => i.path === x.key || i.path.startsWith(`${x.key}.`)); return f && ids.includes(f.id) && i.severity === 'error'; });
    if (!errs) this.stepIndex.set(this.stepIndex() + 1);
  }

  // ---- submit ----
  isFailedResult(): boolean {
    const r = this.snap()?.submission?.result;
    return Boolean(r && !['succeeded', 'queued-offline', 'validation-failed'].includes(r.status));
  }
  resultMessage(): string {
    const r = this.snap()?.submission?.result as { message?: string; status?: string } | undefined;
    return r?.message ?? r?.status ?? '';
  }
  async onSubmit(e?: Event): Promise<void> {
    e?.preventDefault();
    this.submitting.set(true);
    try { this.submitted.emit(await this.controller.submit()); } finally { this.submitting.set(false); }
  }
}
