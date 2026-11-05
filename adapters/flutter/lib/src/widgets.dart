/// Native Flutter UI for the VDS form renderer. Renders every supported field
/// type, groups, repeaters, multi-step, conditions/formulas (via the controller),
/// validation errors, localization and accessibility. Submission goes through
/// the controller's injected trusted transport.
library;

import 'package:flutter/material.dart';

import 'controller.dart';
import 'validation.dart';

class VdsForm extends StatefulWidget {
  final FormController controller;
  final String submitLabel;
  const VdsForm({super.key, required this.controller, this.submitLabel = 'Submit'});

  @override
  State<VdsForm> createState() => _VdsFormState();
}

class _VdsFormState extends State<VdsForm> {
  final Map<String, TextEditingController> _text = {};
  final Map<String, FocusNode> _focus = {};
  final Map<String, int> _tabIndex = {};

  FormController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.initialize();
    c.addListener(_onChanged);
  }

  void _onChanged() { if (mounted) setState(() {}); }

  @override
  void dispose() {
    c.removeListener(_onChanged);
    for (final t in _text.values) { t.dispose(); }
    for (final f in _focus.values) { f.dispose(); }
    super.dispose();
  }

  TextEditingController _textFor(String path, String value) {
    final t = _text.putIfAbsent(path, () => TextEditingController(text: value));
    final node = _focus.putIfAbsent(path, () => FocusNode());
    if (!node.hasFocus && t.text != value) t.text = value;
    return t;
  }

  @override
  Widget build(BuildContext context) {
    final ir = c.ir;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (c.statusMessage != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(c.statusMessage!, key: const Key('vds-status'),
                style: TextStyle(color: c.status == 'succeeded' ? Colors.green : Colors.red)),
          ),
        _layout((ir['layout'] as Map).cast<String, dynamic>()),
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('vds-submit'),
          onPressed: c.isSubmitting ? null : () => c.submit(),
          child: c.isSubmitting
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(widget.submitLabel),
        ),
      ]),
    );
  }

  /// Renders EVERY canonical layout node type (14 in vds.form 1.0.0):
  /// section, group, row, columns, tabs, tab, accordion, steps, step, fieldset,
  /// summary, repeater, divider, text. Unknown nodes render an explicit notice
  /// rather than being silently stacked as a plain column.
  Widget _layout(Map<String, dynamic> node) {
    final type = node['type'] as String? ?? 'section';
    final nodeId = node['id'] as String? ?? type;

    if (type == 'text') {
      return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(localize(node['text'], c.locale)));
    }
    if (type == 'divider') return const Divider();
    if (type == 'steps') return _steps((node['children'] as List? ?? []).cast<Map>());
    if (type == 'repeater') {
      final ref = node['repeaterRef'] as String?;
      final f = ref == null ? null : _field(ref);
      return f == null ? const SizedBox.shrink() : _fieldWidget(f, f['key'] as String);
    }
    if (type == 'summary') return _summary(node);
    if (type == 'accordion') {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final child in (node['children'] as List? ?? []))
          ExpansionTile(
            key: Key('vds-accordion-$nodeId-${(child as Map)['id'] ?? ''}'),
            title: Text(localize(child['title'], c.locale, fallback: 'Section')),
            children: [_layout(child.cast<String, dynamic>())],
          ),
      ]);
    }
    if (type == 'tabs') {
      final tabs = (node['children'] as List? ?? []).cast<Map>();
      if (tabs.isEmpty) return const SizedBox.shrink();
      final sel = (_tabIndex[nodeId] ?? 0).clamp(0, tabs.length - 1);
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            for (var i = 0; i < tabs.length; i++)
              Padding(
                padding: const EdgeInsets.only(right: 4),
                child: ChoiceChip(
                  key: Key('vds-tab-$nodeId-$i'),
                  label: Text(localize(tabs[i]['title'], c.locale, fallback: 'Tab ${i + 1}')),
                  selected: i == sel,
                  onSelected: (_) => setState(() => _tabIndex[nodeId] = i),
                ),
              ),
          ]),
        ),
        _layout(tabs[sel].cast<String, dynamic>()),
      ]);
    }

    final children = <Widget>[];
    for (final fid in (node['fieldRefs'] as List? ?? [])) {
      final f = _field(fid as String);
      if (f != null) children.add(_fieldWidget(f, f['key'] as String));
    }
    for (final child in (node['children'] as List? ?? [])) {
      children.add(_layout((child as Map).cast<String, dynamic>()));
    }
    final title = node['title'] != null ? localize(node['title'], c.locale) : null;
    final titleWidget = title == null
        ? null
        : Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(title, style: Theme.of(context).textTheme.titleMedium));

    if (type == 'row' || type == 'columns') {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (titleWidget != null) titleWidget,
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final w in children) Expanded(child: Padding(padding: const EdgeInsets.only(right: 8), child: w)),
          ]),
        ]),
      );
    }
    if (type == 'fieldset') {
      return Container(
        key: Key('vds-fieldset-$nodeId'),
        margin: const EdgeInsets.symmetric(vertical: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(border: Border.all(color: Colors.grey), borderRadius: BorderRadius.circular(8)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (titleWidget != null) titleWidget,
          ...children,
        ]),
      );
    }
    const known = {'section', 'group', 'step', 'tab'};
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (titleWidget != null) titleWidget,
      ...children,
      if (!known.contains(type))
        Text('Unsupported layout node: $type', key: Key('vds-unsupported-layout-$nodeId'), style: const TextStyle(color: Colors.orange)),
    ]);
  }

  Widget _summary(Map<String, dynamic> node) {
    final refs = (node['fieldRefs'] as List? ?? []).cast<String>();
    final ids = refs.isEmpty ? (c.ir['fields'] as List).map((f) => f['id'] as String).toList() : refs;
    return Card(
      key: Key('vds-summary-${node['id'] ?? 'root'}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (final id in ids)
            if (_field(id) != null && c.state.visibility[id] != false && _field(id)!['type'] != 'hidden')
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(children: [
                  Expanded(child: Text(localize(_field(id)!['label'], c.locale))),
                  Text('${c.fieldValue(_field(id)!['key'] as String) ?? '—'}', key: Key('vds-summary-value-$id')),
                ]),
              ),
        ]),
      ),
    );
  }

  Widget _steps(List<Map> steps) {
    final idx = c.stepIndex.clamp(0, steps.isEmpty ? 0 : steps.length - 1);
    final current = steps.isEmpty ? <String, dynamic>{} : steps[idx].cast<String, dynamic>();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      LinearProgressIndicator(value: steps.isEmpty ? 0 : (idx + 1) / steps.length),
      const SizedBox(height: 8),
      Text(localize(current['title'], c.locale, fallback: c.locale).isEmpty ? 'Step ${idx + 1}' : localize(current['title'], c.locale),
          style: Theme.of(context).textTheme.titleMedium),
      _layout({...current, 'type': 'section'}),
      Row(children: [
        TextButton(key: const Key('vds-step-prev'), onPressed: idx == 0 ? null : () => setState(() => c.stepIndex--), child: const Text('Back')),
        const Spacer(),
        FilledButton(key: const Key('vds-step-next'), onPressed: idx >= steps.length - 1 ? null : () => setState(() => c.stepIndex++), child: const Text('Next')),
      ]),
    ]);
  }

  Map<String, dynamic>? _field(String id) {
    for (final f in (c.ir['fields'] as List)) { if (f['id'] == id) return (f as Map).cast<String, dynamic>(); }
    return null;
  }

  Widget _fieldWidget(Map<String, dynamic> f, String path) {
    final id = f['id'] as String;
    final type = f['type'] as String;
    if (type == 'hidden') return const SizedBox.shrink();
    if (c.state.visibility[id] == false) return const SizedBox.shrink();
    if (type == 'repeater') return _repeater(f);
    if (type == 'group') {
      final kids = (c.ir['fields'] as List).where((x) => x['parentId'] == id).cast<Map>().toList();
      return Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(localize(f['label'], c.locale), style: Theme.of(context).textTheme.titleSmall),
        ...kids.map((k) => _fieldWidget(k.cast<String, dynamic>(), k['key'] as String)),
      ])));
    }
    final errors = c.errorsFor(path);
    final required = c.state.required[id] == true;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Semantics(label: localize(f['label'], c.locale), child: Text('${localize(f['label'], c.locale)}${required ? ' *' : ''}')),
        const SizedBox(height: 4),
        _control(f, path),
        ...errors.map((e) => Text(e['message'] as String, key: Key('vds-error-$path'), style: const TextStyle(color: Colors.red, fontSize: 12))),
      ]),
    );
  }

  Widget _repeater(Map<String, dynamic> f) {
    final id = f['id'] as String;
    final rows = c.repeaterRows[id] ?? [];
    final kids = (c.ir['fields'] as List).where((x) => x['parentId'] == id).cast<Map>().toList();
    return Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(localize(f['label'], c.locale), style: Theme.of(context).textTheme.titleSmall),
      ...rows.asMap().entries.map((entry) {
        final i = entry.key; final rowId = entry.value;
        return Card(key: Key('vds-row-$rowId'), child: Padding(padding: const EdgeInsets.all(8), child: Column(children: [
          ...kids.map((k) => _fieldWidget(k.cast<String, dynamic>(), (k['key'] as String).replaceAll('${f['key']}[]', '${f['key']}.$i'))),
          Align(alignment: Alignment.centerRight, child: TextButton(key: Key('vds-remove-$rowId'), onPressed: () => c.removeRepeaterItem(id, rowId), child: const Text('Remove'))),
        ])));
      }),
      Align(alignment: Alignment.centerLeft, child: TextButton(key: const Key('vds-add-row'), onPressed: () => c.addRepeaterItem(id), child: const Text('Add entry'))),
    ])));
  }

  Widget _control(Map<String, dynamic> f, String path) {
    final type = f['type'] as String;
    final value = c.fieldValue(path);
    final disabled = c.state.disabled[f['id']] == true;
    final readonly = c.state.readonly[f['id']] == true || f['computed'] == true;
    final opts = (f['options'] as List? ?? []).cast<Map>().toList();
    final enabled = !disabled && !readonly;

    switch (type) {
      case 'textarea':
        return TextField(key: Key('vds-input-$path'), controller: _textFor(path, value?.toString() ?? ''), enabled: enabled, maxLines: 4, onChanged: (v) => c.setFieldValue(path, v));
      case 'select':
        return DropdownButtonFormField<String>(key: Key('vds-input-$path'), initialValue: (value?.toString().isNotEmpty ?? false) ? value.toString() : null,
          items: opts.map((o) => DropdownMenuItem(value: o['value'].toString(), child: Text(localize(o['label'], c.locale)))).toList(),
          onChanged: enabled ? (v) => c.setFieldValue(path, v) : null);
      case 'multiselect':
        final sel = (value is List ? value : []).map((e) => e.toString()).toSet();
        return Column(children: opts.map((o) => CheckboxListTile(value: sel.contains(o['value'].toString()), title: Text(localize(o['label'], c.locale)),
          onChanged: enabled ? (v) { final s = {...sel}; if (v == true) { s.add(o['value'].toString()); } else { s.remove(o['value'].toString()); } c.setFieldValue(path, s.toList()); } : null)).toList());
      case 'radio':
        // Flutter >=3.32 manages radio group state with a RadioGroup ancestor;
        // per-tile groupValue/onChanged are deprecated.
        return RadioGroup<String>(
          groupValue: value?.toString(),
          // RadioGroup requires a non-null callback; the tiles carry `enabled`
          // and the handler is a no-op when the field is disabled/readonly.
          onChanged: (v) { if (enabled) c.setFieldValue(path, v); },
          child: Column(children: opts.map((o) => RadioListTile<String>(value: o['value'].toString(), enabled: enabled, title: Text(localize(o['label'], c.locale)))).toList()),
        );
      case 'checkbox': case 'switch': case 'consent':
        return SwitchListTile(key: Key('vds-input-$path'), value: value == true, title: Text(localize(f['label'], c.locale)), onChanged: enabled ? (v) => c.setFieldValue(path, v) : null);
      case 'rating':
        final max = (f['validation']?['max'] ?? 5) as int; final cur = value is num ? value.toInt() : 0;
        return Row(children: List.generate(max, (i) => IconButton(key: Key('vds-star-$path-${i + 1}'), icon: Icon(i < cur ? Icons.star : Icons.star_border), onPressed: enabled ? () => c.setFieldValue(path, i + 1) : null)));
      case 'range':
        final min = (f['validation']?['min'] ?? 0).toDouble(); final max = (f['validation']?['max'] ?? 100).toDouble();
        return Slider(key: Key('vds-input-$path'), value: (value is num ? value.toDouble() : min).clamp(min, max), min: min, max: max, onChanged: enabled ? (v) => c.setFieldValue(path, v) : null);
      case 'computed':
        return Text(value?.toString() ?? '—', key: Key('vds-computed-$path'), style: Theme.of(context).textTheme.titleMedium);
      case 'file': case 'image':
        return _fileControl(f, path, enabled);
      case 'barcode':
        if (c.barcode == null) {
          return Text('Barcode scanning requires a host scanner adapter.',
              key: Key('vds-input-$path'), style: const TextStyle(color: Colors.orange));
        }
        return OutlinedButton(
          key: Key('vds-input-$path'),
          onPressed: enabled
              ? () async {
                  final code = await c.barcode!.scan();
                  if (code != null && mounted) c.setFieldValue(path, code);
                }
              : null,
          child: Text(value == null ? 'Scan barcode' : '$value'),
        );
      case 'signature':
        return Text('Signature capture is not supported by the Flutter renderer.',
            key: Key('vds-input-$path'), style: const TextStyle(color: Colors.orange));
      case 'date': case 'time': case 'datetime':
        return _dateTimeControl(path, type, value, enabled);
      case 'color':
        return _colorControl(path, value, enabled);
      case 'integer': case 'decimal': case 'currency': case 'percentage': case 'duration':
        return TextField(key: Key('vds-input-$path'), controller: _textFor(path, value?.toString() ?? ''), enabled: enabled, keyboardType: TextInputType.number,
          onChanged: (v) => c.setFieldValue(path, v.isEmpty ? null : (type == 'integer' ? int.tryParse(v) : double.tryParse(v)) ?? v));
      default:
        return TextField(key: Key('vds-input-$path'), controller: _textFor(path, value?.toString() ?? ''), enabled: enabled,
          obscureText: type == 'password', keyboardType: type == 'email' ? TextInputType.emailAddress : TextInputType.text, onChanged: (v) => c.setFieldValue(path, v));
    }
  }

  // ------------------------------------------------------------ file/image

  Widget _fileControl(Map<String, dynamic> f, String path, bool enabled) {
    final st = c.uploadStateFor(path);
    final multiple = (f['validation']?['multiple'] == true) || f['valueType'] == 'asset[]';
    final value = c.fieldValue(path);
    final refs = <Map<String, dynamic>>[];
    if (value is List) {
      refs.addAll(value.whereType<Map>().map((e) => e.cast<String, dynamic>()));
    } else if (value is Map) {
      refs.add(value.cast<String, dynamic>());
    }
    final canPick = enabled && c.picker != null && c.uploads != null && !st.busy;
    return Column(key: Key('vds-input-$path'), crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        OutlinedButton(
          key: Key('vds-pick-$path'),
          onPressed: canPick ? () => c.pickAndUpload(path) : null,
          child: Text(multiple ? 'Choose files' : 'Choose file'),
        ),
        if (f['type'] == 'image' && c.camera != null)
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: OutlinedButton(
              key: Key('vds-camera-$path'),
              onPressed: canPick ? () => c.pickAndUpload(path, useCamera: true) : null,
              child: const Text('Camera'),
            ),
          ),
        if (st.busy)
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: TextButton(key: Key('vds-cancel-upload-$path'), onPressed: () => c.cancelUpload(path), child: const Text('Cancel')),
          ),
      ]),
      if (c.picker == null || c.uploads == null)
        const Text('File selection requires host picker and upload adapters.', style: TextStyle(color: Colors.orange, fontSize: 12)),
      if (st.busy)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: LinearProgressIndicator(key: Key('vds-upload-progress-$path'), value: st.fraction == 0 ? null : st.fraction),
        ),
      for (final r in refs)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(children: [
            Expanded(child: Text('${r['name']}', key: Key('vds-asset-${r['assetRef']}'))),
            TextButton(
              key: Key('vds-remove-asset-${r['assetRef']}'),
              onPressed: enabled
                  ? () {
                      if (multiple) {
                        c.setFieldValue(path, refs.where((x) => x['assetRef'] != r['assetRef']).toList());
                      } else {
                        c.setFieldValue(path, null);
                      }
                    }
                  : null,
              child: const Text('Remove'),
            ),
          ]),
        ),
      for (final fail in st.failures)
        Text('${fail.name}: ${fail.message} [${fail.code}]',
            key: Key('vds-upload-error-$path'), style: const TextStyle(color: Colors.red, fontSize: 12)),
    ]);
  }

  // ------------------------------------------------------- date/time/native

  Widget _dateTimeControl(String path, String type, Object? value, bool enabled) {
    final label = value == null || '$value'.isEmpty ? 'Select ${type}' : '$value';
    return OutlinedButton(
      key: Key('vds-input-$path'),
      onPressed: enabled
          ? () async {
              if (type == 'time') {
                final picked = await showTimePicker(context: context, initialTime: TimeOfDay.now());
                if (picked != null && mounted) {
                  c.setFieldValue(path, '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
                }
                return;
              }
              final picked = await showDatePicker(
                context: context,
                initialDate: DateTime.tryParse('$value') ?? DateTime.now(),
                firstDate: DateTime(1900),
                lastDate: DateTime(2100),
              );
              if (picked == null || !mounted) return;
              final date = '${picked.year.toString().padLeft(4, '0')}-${picked.month.toString().padLeft(2, '0')}-${picked.day.toString().padLeft(2, '0')}';
              if (type == 'date') { c.setFieldValue(path, date); return; }
              final time = await showTimePicker(context: context, initialTime: TimeOfDay.now());
              if (!mounted) return;
              final t = time ?? const TimeOfDay(hour: 0, minute: 0);
              c.setFieldValue(path, '${date}T${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:00');
            }
          : null,
      child: Text(label),
    );
  }

  // -------------------------------------------------------------- colour

  static const List<String> _palette = [
    '#000000', '#FFFFFF', '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899',
  ];

  Widget _colorControl(String path, Object? value, bool enabled) {
    final current = (value ?? '#000000').toString();
    return Column(key: Key('vds-input-$path'), crossAxisAlignment: CrossAxisAlignment.start, children: [
      Wrap(spacing: 6, children: [
        for (final hex in _palette)
          GestureDetector(
            key: Key('vds-color-$path-$hex'),
            onTap: enabled ? () => c.setFieldValue(path, hex) : null,
            child: Container(
              width: 28, height: 28,
              decoration: BoxDecoration(
                color: Color(int.parse('FF${hex.substring(1)}', radix: 16)),
                border: Border.all(color: current.toUpperCase() == hex ? Colors.blue : Colors.grey, width: current.toUpperCase() == hex ? 3 : 1),
                borderRadius: BorderRadius.circular(4),
              ),
            ),
          ),
      ]),
      const SizedBox(height: 4),
      Text(current, key: Key('vds-color-value-$path'), style: const TextStyle(fontSize: 12)),
    ]);
  }
}
