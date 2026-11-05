/// Native Flutter UI for the VDS form renderer. Renders every supported field
/// type, groups, repeaters, multi-step, conditions/formulas (via the controller),
/// validation errors, localization and accessibility. Submission goes through
/// the controller's injected trusted transport.
library;

import 'package:flutter/material.dart';

import 'controller.dart';
import 'expr.dart';
import 'validation.dart';

class VdsForm extends StatefulWidget {
  final FormController controller;
  final String submitLabel;
  const VdsForm({
    super.key,
    required this.controller,
    this.submitLabel = 'Submit',
  });

  @override
  State<VdsForm> createState() => _VdsFormState();
}

class _VdsFormState extends State<VdsForm> {
  final Map<String, TextEditingController> _text = {};
  final Map<String, FocusNode> _focus = {};

  FormController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.initialize();
    c.addListener(_onChanged);
  }

  void _onChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    c.removeListener(_onChanged);
    for (final t in _text.values) {
      t.dispose();
    }
    for (final f in _focus.values) {
      f.dispose();
    }
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (c.statusMessage != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                c.statusMessage!,
                key: const Key('vds-status'),
                style: TextStyle(
                  color: c.status == 'succeeded' ? Colors.green : Colors.red,
                ),
              ),
            ),
          _layout((ir['layout'] as Map).cast<String, dynamic>()),
          const SizedBox(height: 16),
          FilledButton(
            key: const Key('vds-submit'),
            onPressed: c.status == 'submitting' ? null : c.submit,
            child: Text(widget.submitLabel),
          ),
        ],
      ),
    );
  }

  Widget _layout(Map<String, dynamic> node) {
    final children = <Widget>[];
    for (final fid in (node['fieldRefs'] as List? ?? [])) {
      final f = _field(fid as String);
      if (f != null) children.add(_fieldWidget(f, f['key'] as String));
    }
    for (final child in (node['children'] as List? ?? [])) {
      children.add(_layout((child as Map).cast<String, dynamic>()));
    }
    final type = node['type'] as String? ?? 'section';
    if (type == 'steps')
      return _steps((node['children'] as List? ?? []).cast<Map>());
    if (type == 'text')
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(localize(node['text'], c.locale)),
      );
    if (type == 'divider') return const Divider();
    final title = node['title'] != null
        ? localize(node['title'], c.locale)
        : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(title, style: Theme.of(context).textTheme.titleMedium),
          ),
        ...children,
      ],
    );
  }

  Widget _steps(List<Map> steps) {
    final idx = c.stepIndex.clamp(0, steps.isEmpty ? 0 : steps.length - 1);
    final current = steps.isEmpty
        ? <String, dynamic>{}
        : steps[idx].cast<String, dynamic>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LinearProgressIndicator(
          value: steps.isEmpty ? 0 : (idx + 1) / steps.length,
        ),
        const SizedBox(height: 8),
        Text(
          localize(current['title'], c.locale, fallback: c.locale).isEmpty
              ? 'Step ${idx + 1}'
              : localize(current['title'], c.locale),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        _layout({...current, 'type': 'section'}),
        Row(
          children: [
            TextButton(
              key: const Key('vds-step-prev'),
              onPressed: idx == 0 ? null : () => setState(() => c.stepIndex--),
              child: const Text('Back'),
            ),
            const Spacer(),
            FilledButton(
              key: const Key('vds-step-next'),
              onPressed: idx >= steps.length - 1
                  ? null
                  : () => setState(() => c.stepIndex++),
              child: const Text('Next'),
            ),
          ],
        ),
      ],
    );
  }

  Map<String, dynamic>? _field(String id) {
    for (final f in (c.ir['fields'] as List)) {
      if (f['id'] == id) return (f as Map).cast<String, dynamic>();
    }
    return null;
  }

  Widget _fieldWidget(Map<String, dynamic> f, String path) {
    final id = f['id'] as String;
    final type = f['type'] as String;
    if (type == 'hidden') return const SizedBox.shrink();
    if (c.state.visibility[id] == false) return const SizedBox.shrink();
    if (type == 'repeater') return _repeater(f);
    if (type == 'group') {
      final kids = (c.ir['fields'] as List)
          .where((x) => x['parentId'] == id)
          .cast<Map>()
          .toList();
      return Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                localize(f['label'], c.locale),
                style: Theme.of(context).textTheme.titleSmall,
              ),
              ...kids.map(
                (k) =>
                    _fieldWidget(k.cast<String, dynamic>(), k['key'] as String),
              ),
            ],
          ),
        ),
      );
    }
    final errors = c.errorsFor(path);
    final required = c.state.required[id] == true;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            label: localize(f['label'], c.locale),
            child: Text(
              '${localize(f['label'], c.locale)}${required ? ' *' : ''}',
            ),
          ),
          const SizedBox(height: 4),
          _control(f, path),
          ...errors.map(
            (e) => Text(
              e['message'] as String,
              key: Key('vds-error-$path'),
              style: const TextStyle(color: Colors.red, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _repeater(Map<String, dynamic> f) {
    final id = f['id'] as String;
    final rows = c.repeaterRows[id] ?? [];
    final kids = (c.ir['fields'] as List)
        .where((x) => x['parentId'] == id)
        .cast<Map>()
        .toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              localize(f['label'], c.locale),
              style: Theme.of(context).textTheme.titleSmall,
            ),
            ...rows.asMap().entries.map((entry) {
              final i = entry.key;
              final rowId = entry.value;
              return Card(
                key: Key('vds-row-$rowId'),
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Column(
                    children: [
                      ...kids.map(
                        (k) => _fieldWidget(
                          k.cast<String, dynamic>(),
                          (k['key'] as String).replaceAll(
                            '${f['key']}[]',
                            '${f['key']}.$i',
                          ),
                        ),
                      ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(
                          key: Key('vds-remove-$rowId'),
                          onPressed: () => c.removeRepeaterItem(id, rowId),
                          child: const Text('Remove'),
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: const Key('vds-add-row'),
                onPressed: () => c.addRepeaterItem(id),
                child: const Text('Add entry'),
              ),
            ),
          ],
        ),
      ),
    );
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
        return TextField(
          key: Key('vds-input-$path'),
          controller: _textFor(path, value?.toString() ?? ''),
          enabled: enabled,
          maxLines: 4,
          onChanged: (v) => c.setFieldValue(path, v),
        );
      case 'select':
        return DropdownButtonFormField<String>(
          key: Key('vds-input-$path'),
          value: (value?.toString().isNotEmpty ?? false)
              ? value.toString()
              : null,
          items: opts
              .map(
                (o) => DropdownMenuItem(
                  value: o['value'].toString(),
                  child: Text(localize(o['label'], c.locale)),
                ),
              )
              .toList(),
          onChanged: enabled ? (v) => c.setFieldValue(path, v) : null,
        );
      case 'multiselect':
        final sel = (value is List ? value : [])
            .map((e) => e.toString())
            .toSet();
        return Column(
          children: opts
              .map(
                (o) => CheckboxListTile(
                  value: sel.contains(o['value'].toString()),
                  title: Text(localize(o['label'], c.locale)),
                  onChanged: enabled
                      ? (v) {
                          final s = {...sel};
                          if (v == true) {
                            s.add(o['value'].toString());
                          } else {
                            s.remove(o['value'].toString());
                          }
                          c.setFieldValue(path, s.toList());
                        }
                      : null,
                ),
              )
              .toList(),
        );
      case 'radio':
        return Column(
          children: opts
              .map(
                (o) => RadioListTile<String>(
                  value: o['value'].toString(),
                  groupValue: value?.toString(),
                  title: Text(localize(o['label'], c.locale)),
                  onChanged: enabled ? (v) => c.setFieldValue(path, v) : null,
                ),
              )
              .toList(),
        );
      case 'checkbox':
      case 'switch':
      case 'consent':
        return SwitchListTile(
          key: Key('vds-input-$path'),
          value: value == true,
          title: Text(localize(f['label'], c.locale)),
          onChanged: enabled ? (v) => c.setFieldValue(path, v) : null,
        );
      case 'rating':
        final max = (f['validation']?['max'] ?? 5) as int;
        final cur = value is num ? value.toInt() : 0;
        return Row(
          children: List.generate(
            max,
            (i) => IconButton(
              key: Key('vds-star-$path-${i + 1}'),
              icon: Icon(i < cur ? Icons.star : Icons.star_border),
              onPressed: enabled ? () => c.setFieldValue(path, i + 1) : null,
            ),
          ),
        );
      case 'range':
        final min = (f['validation']?['min'] ?? 0).toDouble();
        final max = (f['validation']?['max'] ?? 100).toDouble();
        return Slider(
          key: Key('vds-input-$path'),
          value: (value is num ? value.toDouble() : min).clamp(min, max),
          min: min,
          max: max,
          onChanged: enabled ? (v) => c.setFieldValue(path, v) : null,
        );
      case 'computed':
        return Text(
          value?.toString() ?? '—',
          key: Key('vds-computed-$path'),
          style: Theme.of(context).textTheme.titleMedium,
        );
      case 'file':
      case 'image':
        return OutlinedButton(
          key: Key('vds-input-$path'),
          onPressed: enabled ? () {} : null,
          child: const Text('Choose file (upload provider)'),
        );
      case 'signature':
        return const Text(
          'Signature capture is not supported by the Flutter renderer.',
        );
      case 'date':
      case 'time':
      case 'datetime':
        return TextField(
          key: Key('vds-input-$path'),
          controller: _textFor(path, value?.toString() ?? ''),
          enabled: enabled,
          decoration: InputDecoration(hintText: type),
          onChanged: (v) => c.setFieldValue(path, v),
        );
      case 'color':
        return TextField(
          key: Key('vds-input-$path'),
          controller: _textFor(path, value?.toString() ?? '#000000'),
          enabled: enabled,
          onChanged: (v) => c.setFieldValue(path, v),
        );
      case 'integer':
      case 'decimal':
      case 'currency':
      case 'percentage':
      case 'duration':
        return TextField(
          key: Key('vds-input-$path'),
          controller: _textFor(path, value?.toString() ?? ''),
          enabled: enabled,
          keyboardType: TextInputType.number,
          onChanged: (v) => c.setFieldValue(
            path,
            v.isEmpty
                ? null
                : (type == 'integer' ? int.tryParse(v) : double.tryParse(v)) ??
                      v,
          ),
        );
      default:
        return TextField(
          key: Key('vds-input-$path'),
          controller: _textFor(path, value?.toString() ?? ''),
          enabled: enabled,
          obscureText: type == 'password',
          keyboardType: type == 'email'
              ? TextInputType.emailAddress
              : TextInputType.text,
          onChanged: (v) => c.setFieldValue(path, v),
        );
    }
  }
}
