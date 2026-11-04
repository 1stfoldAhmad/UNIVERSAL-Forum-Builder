<?php
/**
 * VDS Universal Form Builder — Laravel/PHP server-rendered renderer.
 *
 * Framework-free core: renders the compiled FormIR to the shared VDS
 * server-rendered HTML contract (the same contract as @vds-form/node and
 * @vds-form/django) so one hydration client enhances all three. Reuses the
 * conformance-verified VdsForm expression/validation/payload engine. The Blade
 * directive, ServiceProvider and controller live alongside and only reference
 * Illuminate inside a host Laravel 13 app.
 */
declare(strict_types=1);

namespace VdsForm\Renderer;

use VdsForm\Expressions;
use VdsForm\Validation;

final class Renderer
{
    public const CSS = '.vds-form{max-width:640px;margin:0 auto;font-family:system-ui,sans-serif}.vds-field{margin-bottom:14px}.vds-label{display:block;font-weight:600;margin-bottom:4px}.vds-input{display:block;width:100%;padding:8px 10px;font-size:15px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}.vds-help{color:#555;font-size:13px;margin:3px 0}.vds-error{color:#c0392b;font-size:13px;margin:3px 0}.vds-success{color:#1e7e34}.vds-btn{background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}.vds-btn-secondary{background:#e9e9e9;color:#222}.vds-required{color:#c0392b}.vds-row{border:1px solid #e2e2e2;border-radius:8px;padding:12px;margin-bottom:10px}.vds-row-actions{display:flex;gap:8px}.vds-fieldset{border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:14px}.vds-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.vds-choice{display:block;padding:3px 0}.vds-star{cursor:pointer;font-size:22px}.vds-hidden{display:none}';

    public static function esc($value): string
    {
        return htmlspecialchars($value === null ? '' : (string)$value, ENT_QUOTES, 'UTF-8');
    }

    public static function localize($text, string $locale, string $fallback = 'en'): string
    {
        if ($text === null) return '';
        if (is_string($text)) return $text;
        if (is_array($text)) return $text[$locale] ?? $text[$fallback] ?? (string)(reset($text) ?: '');
        return (string)$text;
    }

    private static function idFor(string $path): string
    {
        return 'vds-' . preg_replace('/[^a-zA-Z0-9_-]/', '-', $path);
    }

    private static function setIn($root, string $path, $value)
    {
        $segments = explode('.', $path);
        $recur = function ($node, int $i) use (&$recur, $segments, $value) {
            if ($i === count($segments)) return $value;
            $seg = $segments[$i];
            if (preg_match('/^\d+$/', $seg)) {
                $arr = is_array($node) ? array_values($node) : [];
                $idx = (int)$seg;
                while (count($arr) <= $idx) $arr[] = null;
                $arr[$idx] = $recur($arr[$idx] ?? null, $i + 1);
                return $arr;
            }
            $obj = is_array($node) ? $node : [];
            $obj[$seg] = $recur($obj[$seg] ?? null, $i + 1);
            return $obj;
        };
        return $recur($root, 0);
    }

    /** Defaults + repeater rows + formulas (fixed point) + effective state. */
    public static function prepareRenderState(array $ir, array $values = []): array
    {
        foreach ($ir['fields'] as $f) {
            if (!empty($f['parentId']) || !empty($f['repeaterId'])) continue;
            if (array_key_exists('defaultValue', $f) && Expressions::getPath($values, $f['key']) === null) {
                $values = self::setIn($values, $f['key'], $f['defaultValue']);
            }
        }
        $repeaterRows = [];
        foreach ($ir['fields'] as $f) {
            if ($f['type'] !== 'repeater') continue;
            $rows = Expressions::getPath($values, $f['key']);
            $rows = is_array($rows) ? array_values($rows) : [];
            $min = (int)($f['validation']['minItems'] ?? $f['minItems'] ?? 0);
            while (count($rows) < $min) $rows[] = [];
            $values = self::setIn($values, $f['key'], $rows);
            $repeaterRows[$f['id']] = range(0, max(count($rows) - 1, 0));
            if (count($rows) === 0) $repeaterRows[$f['id']] = [];
        }
        $formulas = $ir['formulas'] ?? [];
        for ($pass = 0; $pass <= count($formulas); $pass++) {
            $changed = false;
            foreach ($formulas as $formula) {
                $target = $formula['target'];
                if (str_contains($target, '[]')) {
                    $repKey = rtrim(explode('[]', $target, 2)[0], '.');
                    $rows = Expressions::getPath($values, $repKey);
                    $n = is_array($rows) ? count($rows) : 0;
                    for ($i = 0; $i < $n; $i++) {
                        $concrete = preg_replace('/\[\]/', '.' . $i, $target, 1);
                        $r = Expressions::evaluate($formula['expr'], ['values' => $values, 'rowPrefix' => "$repKey.$i", 'rowIndex' => $i, 'context' => [], 'sources' => []]);
                        if ($r['ok'] && Expressions::getPath($values, $concrete) !== $r['value']) {
                            $values = self::setIn($values, $concrete, $r['value']);
                            $changed = true;
                        }
                    }
                } else {
                    $r = Expressions::evaluate($formula['expr'], ['values' => $values, 'context' => [], 'sources' => []]);
                    if ($r['ok'] && Expressions::getPath($values, $target) !== $r['value']) {
                        $values = self::setIn($values, $target, $r['value']);
                        $changed = true;
                    }
                }
            }
            if (!$changed) break;
        }
        [$state, ] = Validation::computeEffectiveState($ir, $values);
        return ['values' => $values, 'state' => $state, 'repeaterRows' => $repeaterRows];
    }

    private static function errorsFor(array $ctx, string $path): array
    {
        return array_values(array_filter($ctx['issues'], fn($i) => ($i['path'] ?? '') === $path && ($i['severity'] ?? '') === 'error'));
    }

    private static function control(array $field, string $path, array $ctx): string
    {
        $value = Expressions::getPath($ctx['values'], $path);
        $fid = self::idFor($path);
        $state = $ctx['state'];
        $disabled = $state['disabled'][$field['id']] ?? false;
        $readonly = ($state['readonly'][$field['id']] ?? false) || ($field['computed'] ?? false);
        $required = $state['required'][$field['id']] ?? false;
        $common = 'id="' . self::esc($fid) . '" name="' . self::esc($path) . '" data-vds-input="' . self::esc($path) . '"';
        if ($disabled) $common .= ' disabled';
        if ($readonly) $common .= ' readonly';
        if ($required) $common .= ' required aria-required="true"';
        $v = $field['validation'] ?? [];
        $s = $value === null ? '' : (string)$value;
        $t = $field['type'];
        if ($t === 'textarea') return "<textarea $common class=\"vds-input\" rows=\"" . ($field['ui']['rows'] ?? 4) . '">' . self::esc($s) . '</textarea>';
        if ($t === 'select' || $t === 'multiselect') {
            $opts = $field['options'] ?? [];
            $sel = is_array($value) ? array_map('strval', $value) : [];
            $multi = $t === 'multiselect' ? ' multiple size="4"' : '';
            $head = $t === 'multiselect' ? '' : '<option value="">Select…</option>';
            $body = '';
            foreach ($opts as $o) {
                if (!is_array($o)) continue;
                $selected = $t === 'multiselect' ? in_array((string)$o['value'], $sel, true) : ((string)$o['value'] === $s);
                $body .= '<option value="' . self::esc($o['value']) . '"' . ($selected ? ' selected' : '') . '>' . self::esc(self::localize($o['label'] ?? null, $ctx['locale'])) . '</option>';
            }
            return "<select $common class=\"vds-input\"$multi>$head$body</select>";
        }
        if ($t === 'radio') {
            $inner = '';
            foreach (($field['options'] ?? []) as $o) {
                if (!is_array($o)) continue;
                $inner .= '<label class="vds-choice"><input type="radio" name="' . self::esc($path) . '" data-vds-input="' . self::esc($path) . '" value="' . self::esc($o['value']) . '"' . (((string)$o['value'] === $s) ? ' checked' : '') . ($disabled ? ' disabled' : '') . '> ' . self::esc(self::localize($o['label'] ?? null, $ctx['locale'])) . '</label>';
            }
            return '<div class="vds-radios" role="radiogroup">' . $inner . '</div>';
        }
        if ($t === 'checkbox' || $t === 'switch' || $t === 'consent') {
            $role = $t === 'switch' ? 'switch' : 'checkbox';
            return "<input type=\"checkbox\" $common class=\"vds-checkbox\" role=\"$role\"" . ($value === true ? ' checked' : '') . ' value="true">';
        }
        if ($t === 'rating') {
            $mx = (int)($v['max'] ?? 5); $cur = is_numeric($value) ? $value : 0; $inner = '';
            for ($n = 1; $n <= $mx; $n++) {
                $inner .= '<label class="vds-star"><input type="radio" name="' . self::esc($path) . '" data-vds-input="' . self::esc($path) . '" value="' . $n . '"' . ($n == $cur ? ' checked' : '') . '> <span aria-hidden="true">' . ($n <= $cur ? '★' : '☆') . '</span></label>';
            }
            return '<div class="vds-rating" role="radiogroup">' . $inner . '</div>';
        }
        if ($t === 'range') {
            $mn = $v['min'] ?? 0; $mx = $v['max'] ?? 100;
            return "<input type=\"range\" $common class=\"vds-range\" min=\"$mn\" max=\"$mx\" value=\"" . (is_numeric($value) ? $value : $mn) . '"><output class="vds-range-out">' . self::esc($s !== '' ? $s : $mn) . '</output>';
        }
        if ($t === 'file' || $t === 'image') {
            $accept = !empty($v['accept']) ? ' accept="' . self::esc(implode(',', $v['accept'])) . '"' : '';
            $multiple = !empty($v['multiple']) ? ' multiple' : '';
            return "<input type=\"file\" $common class=\"vds-file\"$accept$multiple><p class=\"vds-help vds-upload-note\">Files upload through the registered upload provider when JavaScript is enabled.</p>";
        }
        if ($t === 'signature') return '<div class="vds-unsupported" role="note">Signature capture is not supported by the Laravel renderer.</div>';
        if ($t === 'computed') return "<output $common class=\"vds-computed\" data-computed=\"" . self::esc($path) . '">' . self::esc($s !== '' ? $s : '—') . '</output>';
        if ($t === 'hidden') return "<input type=\"hidden\" $common value=\"" . self::esc($s) . '">';
        if ($t === 'date' || $t === 'time' || $t === 'datetime') {
            $it = $t === 'datetime' ? 'datetime-local' : $t;
            return "<input type=\"$it\" $common class=\"vds-input\" value=\"" . self::esc($s) . '">';
        }
        if ($t === 'color') return "<input type=\"color\" $common class=\"vds-color\" value=\"" . self::esc($s !== '' ? $s : '#000000') . '">';
        if (in_array($t, ['integer', 'decimal', 'currency', 'percentage', 'duration'], true)) {
            $step = $t === 'integer' ? '1' : 'any';
            $mn = isset($v['min']) ? ' min="' . $v['min'] . '"' : '';
            $mx = isset($v['max']) ? ' max="' . $v['max'] . '"' : '';
            return "<input type=\"number\" $common class=\"vds-input\" step=\"$step\"$mn$mx value=\"" . self::esc($s) . '">';
        }
        if (in_array($t, ['email', 'password', 'url', 'phone'], true)) {
            $it = $t === 'phone' ? 'tel' : $t;
            return "<input type=\"$it\" $common class=\"vds-input\" value=\"" . self::esc($s) . '">';
        }
        $ml = isset($v['maxLength']) ? ' maxlength="' . $v['maxLength'] . '"' : '';
        return "<input type=\"text\" $common class=\"vds-input\" value=\"" . self::esc($s) . "\"$ml>";
    }

    private static function renderField(array $field, string $path, array $ctx): string
    {
        if ($field['type'] === 'hidden') return self::control($field, $path, $ctx);
        $visible = $ctx['state']['visibility'][$field['id']] ?? true;
        if (!$visible) return '<div class="vds-field vds-hidden" data-field-id="' . self::esc($field['id']) . '" data-path="' . self::esc($path) . '" data-visible="false" hidden></div>';
        $fid = self::idFor($path);
        $required = $ctx['state']['required'][$field['id']] ?? false;
        $label = self::localize($field['label'] ?? null, $ctx['locale']);
        $desc = !empty($field['description']) ? '<p class="vds-help" id="' . self::esc($fid) . '-help">' . self::esc(self::localize($field['description'], $ctx['locale'])) . '</p>' : '';
        $errs = '';
        foreach (self::errorsFor($ctx, $path) as $e) $errs .= '<p class="vds-error" role="alert" data-error-for="' . self::esc($path) . '">' . self::esc($e['message']) . '</p>';
        $star = $required ? ' <span class="vds-required" aria-hidden="true">*</span>' : '';
        return '<div class="vds-field" data-field-id="' . self::esc($field['id']) . '" data-path="' . self::esc($path) . '" data-type="' . self::esc($field['type']) . '" data-visible="true">'
            . '<label class="vds-label" id="' . self::esc($fid) . '-label" for="' . self::esc($fid) . '">' . self::esc($label) . $star . '</label>' . $desc
            . '<div class="vds-control">' . self::control($field, $path, $ctx) . '</div><div id="' . self::esc($fid) . '-error">' . $errs . '</div></div>';
    }

    private static function renderRepeater(array $field, array $ctx): string
    {
        $rows = $ctx['repeaterRows'][$field['id']] ?? [];
        $children = array_values(array_filter($ctx['ir']['fields'], fn($f) => ($f['parentId'] ?? null) === $field['id']));
        $rowHtml = '';
        foreach ($rows as $i) {
            $inner = '';
            foreach ($children as $c) $inner .= self::renderField($c, str_replace($field['key'] . '[]', $field['key'] . '.' . $i, $c['key']), $ctx);
            $rowHtml .= '<div class="vds-row" data-row-id="row-' . $i . '" data-row-index="' . $i . '">' . $inner
                . '<div class="vds-row-actions"><button type="button" class="vds-btn vds-btn-secondary" data-action="remove-row" data-repeater="' . self::esc($field['id']) . '" data-row-id="row-' . $i . '">Remove</button></div></div>';
        }
        $errs = '';
        foreach (self::errorsFor($ctx, $field['key']) as $e) $errs .= '<p class="vds-error" role="alert">' . self::esc($e['message']) . '</p>';
        return '<div class="vds-repeater" data-repeater="' . self::esc($field['id']) . '" data-path="' . self::esc($field['key']) . '">'
            . '<fieldset class="vds-fieldset"><legend class="vds-legend">' . self::esc(self::localize($field['label'] ?? null, $ctx['locale'])) . '</legend>'
            . '<div data-rows="' . self::esc($field['id']) . '">' . $rowHtml . '</div>' . $errs
            . '<button type="button" class="vds-btn vds-btn-secondary" data-action="add-row" data-repeater="' . self::esc($field['id']) . '">Add entry</button></fieldset></div>';
    }

    private static function renderLayout(array $node, array $ctx, array &$stepIndex): string
    {
        $title = !empty($node['title']) ? '<h3 class="vds-section-title">' . self::esc(self::localize($node['title'], $ctx['locale'])) . '</h3>' : '';
        $fields = '';
        foreach (($node['fieldRefs'] ?? []) as $fid) {
            $f = null;
            foreach ($ctx['ir']['fields'] as $x) if ($x['id'] === $fid) { $f = $x; break; }
            if (!$f) continue;
            if ($f['type'] === 'repeater') $fields .= self::renderRepeater($f, $ctx);
            elseif ($f['type'] === 'group') {
                $inner = '';
                foreach ($ctx['ir']['fields'] as $c) if (($c['parentId'] ?? null) === $f['id']) $inner .= self::renderField($c, $c['key'], $ctx);
                $fields .= '<fieldset class="vds-fieldset" data-field-id="' . self::esc($f['id']) . '"><legend class="vds-legend">' . self::esc(self::localize($f['label'] ?? null, $ctx['locale'])) . '</legend>' . $inner . '</fieldset>';
            } else $fields .= self::renderField($f, $f['key'], $ctx);
        }
        $children = '';
        foreach (($node['children'] ?? []) as $c) $children .= self::renderLayout($c, $ctx, $stepIndex);
        $nt = $node['type'] ?? 'section';
        if ($nt === 'steps') return '<div class="vds-wizard" data-wizard>' . $children . '</div>';
        if ($nt === 'step' || $nt === 'summary') {
            $idx = $stepIndex[0]++; $hidden = $idx > 0 ? ' hidden' : '';
            $legend = self::esc(self::localize($node['title'] ?? null, $ctx['locale']) ?: ('Step ' . ($idx + 1)));
            return '<fieldset class="vds-step" data-step="' . $idx . '"' . $hidden . '><legend class="vds-legend">' . $legend . '</legend>' . $fields . $children
                . '<div class="vds-step-actions"><button type="button" class="vds-btn vds-btn-secondary" data-action="step-prev">Back</button>'
                . '<button type="button" class="vds-btn" data-action="step-next">Next</button></div></fieldset>';
        }
        if ($nt === 'repeater') {
            $f = null;
            foreach ($ctx['ir']['fields'] as $x) if ($x['id'] === ($node['repeaterRef'] ?? null)) { $f = $x; break; }
            return $f ? self::renderRepeater($f, $ctx) : $fields . $children;
        }
        if ($nt === 'text') return '<p class="vds-text">' . self::esc(self::localize($node['text'] ?? null, $ctx['locale'])) . '</p>' . $fields . $children;
        if ($nt === 'divider') return '<hr class="vds-divider">';
        if ($nt === 'fieldset') return '<fieldset class="vds-fieldset"><legend class="vds-legend">' . self::esc(self::localize($node['title'] ?? null, $ctx['locale'])) . '</legend>' . $fields . $children . '</fieldset>';
        return '<section class="vds-section" data-layout="' . self::esc($nt) . '">' . $title . $fields . $children . '</section>';
    }

    public static function renderForm(array $ir, array $opts = []): string
    {
        $prepared = self::prepareRenderState($ir, $opts['values'] ?? []);
        $locale = $opts['locale'] ?? ($ir['localization']['defaultLocale'] ?? 'en');
        $ctx = ['ir' => $ir, 'values' => $prepared['values'], 'state' => $prepared['state'],
                'repeaterRows' => $prepared['repeaterRows'], 'locale' => $locale, 'issues' => $opts['issues'] ?? []];
        $stepIndex = [0];
        $body = self::renderLayout($ir['layout'], $ctx, $stepIndex);
        $hidden = '';
        foreach (($opts['hiddenInputs'] ?? []) as $k => $v) $hidden .= '<input type="hidden" name="' . self::esc($k) . '" value="' . self::esc($v) . '">';
        $csrf = !empty($opts['csrfToken']) ? '<input type="hidden" name="' . self::esc($opts['csrfParam'] ?? '_token') . '" value="' . self::esc($opts['csrfToken']) . '">' : '';
        $hydration = '';
        if (($opts['hydrate'] ?? true) !== false) {
            $irJson = str_replace('<', '\\u003c', json_encode($ir, JSON_UNESCAPED_UNICODE));
            $valuesJson = str_replace('<', '\\u003c', json_encode($prepared['values'], JSON_UNESCAPED_UNICODE));
            $hydration = '<script type="application/json" data-vds-ir>' . $irJson . '</script><script type="application/json" data-vds-values>' . $valuesJson . '</script>';
        }
        $submit = self::esc($opts['submitLabel'] ?? 'Submit');
        return '<form class="vds-form" data-vds-form="' . self::esc($ir['formId']) . '" action="' . self::esc($opts['action'] ?? '') . '" method="post" novalidate>'
            . $csrf . $hidden . $body . '<div class="vds-actions"><button type="submit" class="vds-btn" data-action="submit">' . $submit . '</button></div>' . $hydration . '</form>';
    }

    public static function renderPage(array $ir, array $opts = []): string
    {
        $locale = $opts['locale'] ?? ($ir['localization']['defaultLocale'] ?? 'en');
        $title = self::esc($opts['title'] ?? $ir['formId']);
        $script = !empty($opts['clientScript']) ? '<script type="module" src="' . self::esc($opts['clientScript']) . '"></script>' : '';
        return '<!doctype html><html lang="' . self::esc($locale) . '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            . '<title>' . $title . '</title><style>' . self::CSS . '</style></head><body>' . self::renderForm($ir, $opts) . $script . '</body></html>';
    }

    /** Parse no-JS POST data (dot-path names → list of raw values) into typed values. */
    public static function parseFormValues(array $ir, array $data, string $csrfParam = '_token'): array
    {
        $skeleton = [];
        foreach ($ir['fields'] as $f) {
            if ($f['type'] !== 'repeater') continue;
            $max = -1;
            foreach (array_keys($data) as $name) {
                if (str_starts_with($name, $f['key'] . '.')) {
                    $head = explode('.', substr($name, strlen($f['key']) + 1))[0];
                    if (preg_match('/^\d+$/', $head)) $max = max($max, (int)$head);
                }
            }
            if ($max >= 0) $skeleton = self::setIn($skeleton, $f['key'], array_fill(0, $max + 1, []));
        }
        $instances = Validation::expandFieldInstances($ir, $skeleton);
        $byPath = [];
        foreach ($instances as $inst) $byPath[$inst['concreteKey']] = $inst['field'];
        $values = [];
        foreach ($data as $name => $raw) {
            if ($name === $csrfParam || str_starts_with((string)$name, '_')) continue;
            $raw = is_array($raw) ? array_values($raw) : [$raw];
            $field = $byPath[$name] ?? null;
            $vt = $field['valueType'] ?? null;
            $isMulti = $field && (in_array($vt, ['string[]', 'number[]'], true) || $field['type'] === 'multiselect');
            $value = $isMulti ? $raw : ($raw[count($raw) - 1] ?? '');
            $values = self::setIn($values, (string)$name, self::coerce($field, $value));
        }
        foreach ($instances as $inst) {
            $f = $inst['field'];
            if (in_array($f['type'], ['checkbox', 'switch', 'consent'], true) && !array_key_exists($inst['concreteKey'], $data)) {
                $values = self::setIn($values, $inst['concreteKey'], false);
            }
        }
        return $values;
    }

    private static function coerce(?array $field, $value)
    {
        $vt = $field['valueType'] ?? null;
        $ft = $field['type'] ?? null;
        if (is_array($value)) {
            if ($vt === 'number[]') return array_map(fn($x) => $x === '' ? null : (float)$x, $value);
            return $value;
        }
        if (in_array($ft, ['checkbox', 'switch', 'consent'], true)) return in_array($value, ['true', 'on', '1'], true);
        if ($value === '') return null;
        if ($vt === 'integer') return preg_match('/^-?\d+$/', (string)$value) ? (int)$value : $value;
        if ($vt === 'number') return is_numeric($value) ? (float)$value : $value;
        if ($vt === 'boolean') return in_array($value, ['true', 'on', '1'], true);
        return $value;
    }
}
