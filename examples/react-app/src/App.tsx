import React, { useEffect, useMemo, useState } from 'react';
import { createForm, type FormController, type Diagnostic } from '@vds-form/core';
import { UniversalForm, useFormSnapshot, REACT_CAPABILITY_MANIFEST } from '@vds-form/react';
import { DEMO_FORMS, type DemoForm } from './forms';
import { createDemoEnvironment, type DemoEnvironment } from './demoEnvironment';

const panel: React.CSSProperties = { background: '#fff', border: '1px solid #e3e3e3', borderRadius: 10, padding: 16 };
const pre: React.CSSProperties = { background: '#0d1117', color: '#c9d1d9', padding: 12, borderRadius: 8, fontSize: 12, overflow: 'auto', maxHeight: 320, margin: 0 };
const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  background: active ? '#1f6feb' : '#eef1f4', color: active ? '#fff' : '#333',
});

function Inspector({ controller, env }: { controller: FormController; env: DemoEnvironment }) {
  const snap = useFormSnapshot(controller);
  const [tab, setTab] = useState<'values' | 'submission' | 'state' | 'capabilities'>('values');
  const [records, setRecords] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      const n = ['contacts', 'customers', 'invoices', 'kycSubmissions', 'applications', 'profiles', 'addresses', 'surveys', 'purchases']
        .reduce((acc, t) => acc + env.store.list(t).length, 0);
      setRecords(n);
    }, 400);
    return () => clearInterval(id);
  }, [env]);

  return (
    <div style={panel} data-testid="inspector">
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['values', 'submission', 'state', 'capabilities'] as const).map((t) => (
          <button key={t} style={tabBtn(tab === t)} onClick={() => setTab(t)} data-testid={`tab-${t}`}>{t}</button>
        ))}
      </div>
      {tab === 'values' && <pre style={pre} data-testid="live-values">{JSON.stringify(snap.values, null, 2)}</pre>}
      {tab === 'submission' && (
        <div>
          <p style={{ fontSize: 13, color: '#555' }}>Records persisted by registered TEST executors: <strong data-testid="record-count">{records}</strong></p>
          <pre style={pre} data-testid="submission-result">{JSON.stringify(snap.submission, null, 2)}</pre>
        </div>
      )}
      {tab === 'state' && (
        <pre style={pre} data-testid="form-state">{JSON.stringify({
          state: snap.state,
          dirtyPaths: snap.dirtyPaths,
          visibility: snap.visibility,
          issues: snap.issues,
          asyncValidation: snap.asyncValidation,
          dataSources: snap.dataSources,
          repeaterRows: snap.repeaterRows,
        }, null, 2)}</pre>
      )}
      {tab === 'capabilities' && <pre style={pre} data-testid="capabilities">{JSON.stringify(REACT_CAPABILITY_MANIFEST, null, 2)}</pre>}
    </div>
  );
}

function FormRunner({ form, env }: { form: DemoForm; env: DemoEnvironment }) {
  const [controller, setController] = useState<FormController | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [lastResult, setLastResult] = useState<string>('');

  useEffect(() => {
    let active = true;
    let created: FormController | null = null;
    setController(null);
    setDiagnostics([]);
    const result = createForm({
      document: form.document,
      target: REACT_CAPABILITY_MANIFEST,
      executors: env.executors,
      dataProviders: env.dataProviders,
      uploadProvider: env.uploadProvider,
      rbac: env.rbac,
      auth: env.auth,
      drafts: env.drafts,
      offlineQueue: env.offlineQueue,
    });
    if (!result.ok) { setDiagnostics(result.diagnostics); return; }
    setDiagnostics(result.warnings);
    created = result.controller;
    void created.initialize().then(() => { if (active) setController(created); });
    return () => { active = false; created?.dispose(); };
  }, [form, env]);

  if (diagnostics.some((d) => d.severity === 'error')) {
    return <div style={panel}><h3>Compile diagnostics</h3><pre style={pre}>{JSON.stringify(diagnostics, null, 2)}</pre></div>;
  }
  if (!controller) return <div style={panel} data-testid="loading">Compiling + initializing runtime…</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
      <div style={panel}>
        <UniversalForm controller={controller} onSubmitted={(r) => setLastResult(r.status)} />
        {lastResult ? <p style={{ fontSize: 12, color: '#888', textAlign: 'center' }}>last submission status: <code>{lastResult}</code></p> : null}
      </div>
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ ...panel, background: '#f0f6ff', borderColor: '#cfe0ff' }}>
          <strong style={{ fontSize: 14 }}>Pipeline proven live</strong>
          <p style={{ fontSize: 13, color: '#445', margin: '6px 0 0' }}>
            JSON → JSON-Schema → Compiler → FormIR → Headless Runtime → React renderer → registered executor.
            All providers are explicitly-named <em>TEST</em> adapters (in-memory), not production VDS integrations.
          </p>
        </div>
        <Inspector controller={controller} env={env} />
      </div>
    </div>
  );
}

export default function App() {
  const env = useMemo(() => createDemoEnvironment(), []);
  const [selected, setSelected] = useState(DEMO_FORMS[0].id);
  const form = DEMO_FORMS.find((f) => f.id === selected)!;

  return (
    <div style={{ minHeight: '100vh', background: '#f6f8fa', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ background: '#0d1117', color: '#fff', padding: '18px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>VDS Universal Form Builder — Live Preview</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#9da7b3' }}>
          One canonical JSON standard · spec 1.0.0 · React renderer · {DEMO_FORMS.length} example forms
        </p>
      </header>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: 24 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {DEMO_FORMS.map((f) => (
            <button key={f.id} onClick={() => setSelected(f.id)} data-testid={`pick-form-${f.id}`}
              style={{ ...tabBtn(selected === f.id), padding: '8px 14px' }}>{f.title}</button>
          ))}
        </div>
        <p style={{ fontSize: 13, color: '#666', marginTop: 0 }}>{form.blurb}</p>
        <FormRunner key={form.id} form={form} env={env} />
      </div>
    </div>
  );
}
