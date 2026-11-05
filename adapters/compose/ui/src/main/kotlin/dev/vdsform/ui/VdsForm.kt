package dev.vdsform.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneOffset
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.vdsform.FormController
import dev.vdsform.PickedFile
import dev.vdsform.Validation
import kotlinx.coroutines.launch

/**
 * Native Jetpack Compose UI for the VDS form renderer. Renders every supported
 * field type, groups, repeaters, multi-step, conditions/formulas (via the
 * controller), validation errors, localization and accessibility. Submission
 * goes through the controller's injected trusted transport.
 */
@Composable
fun VdsForm(controller: FormController, submitLabel: String = "Submit") {
    var version by remember { mutableIntStateOf(0) }
    DisposableEffect(controller) {
        val l: () -> Unit = { version += 1 }
        controller.addListener(l)
        onDispose { controller.removeListener(l) }
    }
    LaunchedEffect(controller) { controller.initialize() }
    val scope = rememberCoroutineScope()
    val ir = controller.ir
    @Suppress("UNCHECKED_CAST")
    val layout = ir["layout"] as Map<String, Any?>

    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
        controller.statusMessage?.let {
            Text(it, modifier = Modifier.testTag("vds-status"), color = if (controller.status == "succeeded") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(12.dp))
        }
        LayoutNode(controller, layout) { version }
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { scope.launch { controller.submit() } },
            enabled = !controller.isSubmitting,
            modifier = Modifier.testTag("vds-submit"),
        ) {
            if (controller.isSubmitting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text(submitLabel)
        }
    }
}

@Composable
private fun LayoutNode(c: FormController, node: Map<String, Any?>, version: () -> Int) {
    version()
    val type = node["type"] as? String ?: "section"
    val nodeId = node["id"] as? String ?: type
    if (type == "steps") { Steps(c, (node["children"] as? List<*>) ?: emptyList<Any?>()); return }
    if (type == "text") { Text(Validation.localize(node["text"], c.locale)); return }
    if (type == "divider") { HorizontalDivider(); return }
    if (type == "repeater") {
        val ref = node["repeaterRef"] as? String
        val f = ref?.let { field(c, it) }
        if (f != null) FieldWidget(c, f, f["key"] as String)
        return
    }
    if (type == "summary") { Summary(c, node); return }

    @Suppress("UNCHECKED_CAST")
    val children = node["children"] as? List<Map<String, Any?>> ?: emptyList()

    if (type == "accordion") {
        Column {
            for (child in children) {
                var open by remember { mutableStateOf(false) }
                TextButton(onClick = { open = !open }, modifier = Modifier.testTag("vds-accordion-$nodeId-${child["id"] ?: ""}")) {
                    Text(Validation.localize(child["title"], c.locale))
                }
                if (open) LayoutNode(c, child, version)
            }
        }
        return
    }
    if (type == "tabs") {
        if (children.isEmpty()) return
        var sel by remember { mutableIntStateOf(0) }
        val idx = sel.coerceIn(0, children.size - 1)
        Column {
            Row {
                children.forEachIndexed { i, t ->
                    FilterChip(
                        selected = i == idx, onClick = { sel = i },
                        label = { Text(Validation.localize(t["title"], c.locale)) },
                        modifier = Modifier.testTag("vds-tab-$nodeId-$i"),
                    )
                }
            }
            LayoutNode(c, children[idx], version)
        }
        return
    }

    val body = @Composable {
        @Suppress("UNCHECKED_CAST")
        for (fid in (node["fieldRefs"] as? List<String> ?: emptyList())) {
            val f = field(c, fid) ?: continue
            FieldWidget(c, f, f["key"] as String)
        }
        for (child in children) LayoutNode(c, child, version)
    }

    when (type) {
        "row", "columns" -> Column {
            (node["title"] as? Any)?.let { Text(Validation.localize(it, c.locale), style = MaterialTheme.typography.titleMedium) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                @Suppress("UNCHECKED_CAST")
                val refs = (node["fieldRefs"] as? List<String> ?: emptyList())
                for (fid in refs) {
                    val f = field(c, fid) ?: continue
                    Box(Modifier.weight(1f)) { FieldWidget(c, f, f["key"] as String) }
                }
                for (child in children) Box(Modifier.weight(1f)) { LayoutNode(c, child, version) }
            }
        }
        "fieldset" -> Column(
            Modifier.padding(vertical = 8.dp).border(1.dp, Color.Gray, RoundedCornerShape(8.dp)).padding(12.dp).testTag("vds-fieldset-$nodeId")
        ) {
            (node["title"] as? Any)?.let { Text(Validation.localize(it, c.locale), style = MaterialTheme.typography.titleMedium) }
            body()
        }
        else -> Column {
            (node["title"] as? Any)?.let { Text(Validation.localize(it, c.locale), style = MaterialTheme.typography.titleMedium) }
            body()
            // Never silently stack an unknown node as if it were supported.
            if (type !in setOf("section", "group", "step", "tab")) {
                Text("Unsupported layout node: $type", color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("vds-unsupported-layout-$nodeId"))
            }
        }
    }
}

@Composable
private fun Summary(c: FormController, node: Map<String, Any?>) {
    @Suppress("UNCHECKED_CAST")
    val refs = node["fieldRefs"] as? List<String> ?: emptyList()
    @Suppress("UNCHECKED_CAST")
    val ids = if (refs.isEmpty()) (c.ir["fields"] as List<Map<String, Any?>>).map { it["id"] as String } else refs
    Column(Modifier.testTag("vds-summary-${node["id"] ?: "root"}")) {
        for (id in ids) {
            val f = field(c, id) ?: continue
            if (c.state.visibility[id] == false || f["type"] == "hidden") continue
            Row {
                Text(Validation.localize(f["label"], c.locale), Modifier.weight(1f))
                Text(c.fieldValue(f["key"] as String)?.toString() ?: "—", modifier = Modifier.testTag("vds-summary-value-$id"))
            }
        }
    }
}

@Composable
private fun Steps(c: FormController, steps: List<*>) {
    val idx = c.stepIndex.coerceIn(0, if (steps.isEmpty()) 0 else steps.size - 1)
    @Suppress("UNCHECKED_CAST")
    val current = if (steps.isEmpty()) emptyMap<String, Any?>() else steps[idx] as Map<String, Any?>
    Column {
        LinearProgressIndicator(progress = { if (steps.isEmpty()) 0f else (idx + 1f) / steps.size })
        Text(Validation.localize(current["title"], c.locale).ifEmpty { "Step ${idx + 1}" }, style = MaterialTheme.typography.titleMedium)
        LayoutNode(c, current + mapOf("type" to "section")) { 0 }
        Row {
            TextButton(onClick = { c.stepIndex-- }, enabled = idx > 0, modifier = Modifier.testTag("vds-step-prev")) { Text("Back") }
            Spacer(Modifier.weight(1f))
            Button(onClick = { c.stepIndex++ }, enabled = idx < steps.size - 1, modifier = Modifier.testTag("vds-step-next")) { Text("Next") }
        }
    }
}

@Suppress("UNCHECKED_CAST")
private fun field(c: FormController, id: String): Map<String, Any?>? =
    (c.ir["fields"] as List<Map<String, Any?>>).firstOrNull { it["id"] == id }

@Composable
private fun FieldWidget(c: FormController, f: Map<String, Any?>, path: String) {
    val id = f["id"] as String
    val type = f["type"] as String
    if (type == "hidden" || c.state.visibility[id] == false) return
    if (type == "repeater") { Repeater(c, f); return }
    if (type == "group") {
        @Suppress("UNCHECKED_CAST")
        val kids = (c.ir["fields"] as List<Map<String, Any?>>).filter { it["parentId"] == id }
        Card(Modifier.padding(vertical = 6.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(Validation.localize(f["label"], c.locale), style = MaterialTheme.typography.titleSmall)
                for (k in kids) FieldWidget(c, k, k["key"] as String)
            }
        }
        return
    }
    val errors = c.errorsFor(path)
    val required = c.state.required[id] == true
    Column(Modifier.padding(bottom = 12.dp)) {
        Text(Validation.localize(f["label"], c.locale) + if (required) " *" else "")
        Spacer(Modifier.height(4.dp))
        Control(c, f, path)
        for (e in errors) Text(e["message"] as String, modifier = Modifier.testTag("vds-error-$path"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun Repeater(c: FormController, f: Map<String, Any?>) {
    val id = f["id"] as String
    val rows = c.repeaterRows[id] ?: emptyList<String>()
    @Suppress("UNCHECKED_CAST")
    val kids = (c.ir["fields"] as List<Map<String, Any?>>).filter { it["parentId"] == id }
    Card(Modifier.padding(vertical = 6.dp)) {
        Column(Modifier.padding(12.dp)) {
            Text(Validation.localize(f["label"], c.locale), style = MaterialTheme.typography.titleSmall)
            rows.forEachIndexed { i, rowId ->
                Card(Modifier.padding(vertical = 4.dp).testTag("vds-row-$rowId")) {
                    Column(Modifier.padding(8.dp)) {
                        for (k in kids) FieldWidget(c, k, (k["key"] as String).replace("${f["key"]}[]", "${f["key"]}.$i"))
                        TextButton(onClick = { c.removeRepeaterItem(id, rowId) }, modifier = Modifier.testTag("vds-remove-$rowId")) { Text("Remove") }
                    }
                }
            }
            TextButton(onClick = { c.addRepeaterItem(id) }, modifier = Modifier.testTag("vds-add-row")) { Text("Add entry") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Control(c: FormController, f: Map<String, Any?>, path: String) {
    val type = f["type"] as String
    val fid = f["id"] as String
    val value = c.fieldValue(path)
    val enabled = c.state.disabled[fid] != true && c.state.readonly[fid] != true && f["computed"] != true
    @Suppress("UNCHECKED_CAST")
    val opts = (f["options"] as? List<Map<String, Any?>> ?: emptyList())
    val validation = (f["validation"] as? Map<*, *>) ?: emptyMap<String, Any?>()

    when (type) {
        "textarea" -> OutlinedTextField(value = value?.toString() ?: "", onValueChange = { c.setFieldValue(path, it) }, enabled = enabled, minLines = 3, modifier = Modifier.testTag("vds-input-$path"))
        "select" -> {
            var expanded by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }) {
                OutlinedTextField(value = value?.toString() ?: "", onValueChange = {}, readOnly = true, enabled = enabled, modifier = Modifier.menuAnchor().testTag("vds-input-$path"))
                ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    for (o in opts) DropdownMenuItem(text = { Text(Validation.localize(o["label"], c.locale)) }, onClick = { c.setFieldValue(path, o["value"]); expanded = false })
                }
            }
        }
        "radio" -> Column { for (o in opts) Row { RadioButton(selected = value?.toString() == o["value"].toString(), onClick = { if (enabled) c.setFieldValue(path, o["value"]) }, enabled = enabled); Text(Validation.localize(o["label"], c.locale)) } }
        "checkbox", "switch", "consent" -> Switch(checked = value == true, onCheckedChange = { c.setFieldValue(path, it) }, enabled = enabled, modifier = Modifier.testTag("vds-input-$path"))
        "rating" -> {
            val max = (validation["max"] as? Number)?.toInt() ?: 5
            val cur = (value as? Number)?.toInt() ?: 0
            Row { for (n in 1..max) TextButton(onClick = { if (enabled) c.setFieldValue(path, n) }, modifier = Modifier.testTag("vds-star-$path-$n")) { Text(if (n <= cur) "★" else "☆") } }
        }
        "range" -> {
            val min = (validation["min"] as? Number)?.toFloat() ?: 0f
            val max = (validation["max"] as? Number)?.toFloat() ?: 100f
            Slider(value = (value as? Number)?.toFloat()?.coerceIn(min, max) ?: min, onValueChange = { c.setFieldValue(path, it) }, valueRange = min..max, enabled = enabled, modifier = Modifier.testTag("vds-input-$path"))
        }
        "computed" -> Text(value?.toString() ?: "—", modifier = Modifier.testTag("vds-computed-$path"), style = MaterialTheme.typography.titleMedium)
        "multiselect" -> {
            val sel = (value as? List<*>)?.map { it.toString() }?.toSet() ?: emptySet()
            Column(Modifier.testTag("vds-input-$path")) {
                for (o in opts) {
                    val v = o["value"].toString()
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Checkbox(
                            checked = sel.contains(v), enabled = enabled,
                            onCheckedChange = { on ->
                                val next = sel.toMutableSet()
                                if (on) next.add(v) else next.remove(v)
                                c.setFieldValue(path, next.toList())
                            },
                            modifier = Modifier.testTag("vds-option-$path-$v"),
                        )
                        Text(Validation.localize(o["label"], c.locale))
                    }
                }
            }
        }
        "date", "time", "datetime" -> DateTimeControl(c, path, type, value, enabled)
        "color" -> ColorControl(c, path, value, enabled)
        "barcode" -> {
            if (c.barcode == null) {
                Text("Barcode scanning requires a host scanner adapter.", color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("vds-input-$path"))
            } else {
                val scope = rememberCoroutineScope()
                OutlinedButton(
                    onClick = { scope.launch { c.barcode?.scan()?.let { c.setFieldValue(path, it) } } },
                    enabled = enabled, modifier = Modifier.testTag("vds-input-$path"),
                ) { Text(value?.toString() ?: "Scan barcode") }
            }
        }
        "file", "image" -> FileControl(c, f, path, enabled)
        "signature" -> Text("Signature capture is not supported by the Compose renderer.", color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("vds-input-$path"))
        "integer", "decimal", "currency", "percentage", "duration" -> OutlinedTextField(value = value?.toString() ?: "", onValueChange = { s -> val v = if (s.isEmpty()) null else (if (type == "integer") s.toLongOrNull() else s.toDoubleOrNull()) ?: s; c.setFieldValue(path, v) }, enabled = enabled, modifier = Modifier.testTag("vds-input-$path"))
        else -> OutlinedTextField(value = value?.toString() ?: "", onValueChange = { c.setFieldValue(path, it) }, enabled = enabled, modifier = Modifier.testTag("vds-input-$path"))
    }
}

// ---------------------------------------------------------------- file/image

@Composable
private fun FileControl(c: FormController, f: Map<String, Any?>, path: String, enabled: Boolean) {
    val st = c.uploadStateFor(path)
    val v = (f["validation"] as? Map<*, *>) ?: emptyMap<String, Any?>()
    val multiple = v["multiple"] == true || f["valueType"] == "asset[]"
    val scope = rememberCoroutineScope()
    val value = c.fieldValue(path)
    @Suppress("UNCHECKED_CAST")
    val refs: List<Map<String, Any?>> = when (value) {
        is List<*> -> value.filterIsInstance<Map<String, Any?>>()
        is Map<*, *> -> listOf(value as Map<String, Any?>)
        else -> emptyList()
    }
    val canPick = enabled && c.picker != null && c.uploads != null && !st.busy

    Column(Modifier.testTag("vds-input-$path")) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { scope.launch { c.pickAndUpload(path) } }, enabled = canPick, modifier = Modifier.testTag("vds-pick-$path")) {
                Text(if (multiple) "Choose files" else "Choose file")
            }
            if (f["type"] == "image" && c.camera != null) {
                OutlinedButton(onClick = { scope.launch { c.pickAndUpload(path, useCamera = true) } }, enabled = canPick, modifier = Modifier.testTag("vds-camera-$path")) { Text("Camera") }
            }
            if (st.busy) {
                TextButton(onClick = { c.cancelUpload(path) }, modifier = Modifier.testTag("vds-cancel-upload-$path")) { Text("Cancel") }
            }
        }
        if (c.picker == null || c.uploads == null) {
            Text("File selection requires host picker and upload adapters.", color = MaterialTheme.colorScheme.error)
        }
        if (st.busy) {
            LinearProgressIndicator(progress = { st.fraction.toFloat() }, modifier = Modifier.testTag("vds-upload-progress-$path"))
        }
        for (r in refs) {
            val ref = r["assetRef"]?.toString() ?: ""
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(r["name"]?.toString() ?: "", Modifier.weight(1f).testTag("vds-asset-$ref"))
                TextButton(
                    onClick = {
                        if (multiple) c.setFieldValue(path, refs.filter { it["assetRef"]?.toString() != ref })
                        else c.setFieldValue(path, null)
                    },
                    enabled = enabled, modifier = Modifier.testTag("vds-remove-asset-$ref"),
                ) { Text("Remove") }
            }
        }
        for (fail in st.failures) {
            Text("${fail.name}: ${fail.message} [${fail.code}]", color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("vds-upload-error-$path"))
        }
    }
}

// ---------------------------------------------------------- date/time/native

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateTimeControl(c: FormController, path: String, type: String, value: Any?, enabled: Boolean) {
    var showDate by remember { mutableStateOf(false) }
    var showTime by remember { mutableStateOf(false) }
    var pendingDate by remember { mutableStateOf<String?>(null) }
    val label = value?.toString()?.takeIf { it.isNotEmpty() } ?: "Select $type"

    OutlinedButton(
        onClick = { if (type == "time") showTime = true else showDate = true },
        enabled = enabled, modifier = Modifier.testTag("vds-input-$path"),
    ) { Text(label) }

    if (showDate) {
        val pickerState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showDate = false },
            confirmButton = {
                TextButton(onClick = {
                    val millis = pickerState.selectedDateMillis
                    if (millis != null) {
                        val d = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
                        val iso = d.toString()
                        if (type == "date") c.setFieldValue(path, iso) else { pendingDate = iso; showTime = true }
                    }
                    showDate = false
                }, modifier = Modifier.testTag("vds-date-confirm-$path")) { Text("OK") }
            },
        ) { DatePicker(state = pickerState) }
    }
    if (showTime) {
        val timeState = rememberTimePickerState()
        DatePickerDialog(
            onDismissRequest = { showTime = false },
            confirmButton = {
                TextButton(onClick = {
                    val t = "%02d:%02d".format(timeState.hour, timeState.minute)
                    if (type == "time") c.setFieldValue(path, t)
                    else c.setFieldValue(path, "${pendingDate ?: LocalDate.now()}T$t:00")
                    pendingDate = null; showTime = false
                }, modifier = Modifier.testTag("vds-time-confirm-$path")) { Text("OK") }
            },
        ) { TimePicker(state = timeState) }
    }
}

// -------------------------------------------------------------------- colour

private val VDS_PALETTE = listOf("#000000", "#FFFFFF", "#EF4444", "#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899")

private fun parseHex(hex: String): Color {
    val n = hex.removePrefix("#").toLongOrNull(16) ?: 0L
    return Color(((n shr 16) and 0xFF).toInt(), ((n shr 8) and 0xFF).toInt(), (n and 0xFF).toInt())
}

@Composable
private fun ColorControl(c: FormController, path: String, value: Any?, enabled: Boolean) {
    val current = (value?.toString() ?: "#000000").uppercase()
    Column(Modifier.testTag("vds-input-$path")) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (hex in VDS_PALETTE) {
                Box(
                    Modifier.size(28.dp).clip(RoundedCornerShape(4.dp)).background(parseHex(hex))
                        .border(if (current == hex) 3.dp else 1.dp, if (current == hex) Color.Blue else Color.Gray, RoundedCornerShape(4.dp))
                        .clickable(enabled = enabled) { c.setFieldValue(path, hex) }
                        .testTag("vds-color-$path-$hex")
                )
            }
        }
        Text(current, modifier = Modifier.testTag("vds-color-value-$path"))
    }
}
