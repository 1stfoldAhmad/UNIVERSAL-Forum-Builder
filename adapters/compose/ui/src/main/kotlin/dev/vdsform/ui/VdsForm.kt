package dev.vdsform.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.vdsform.FormController
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
        Button(onClick = { scope.launch { controller.submit() } }, modifier = Modifier.testTag("vds-submit")) { Text(submitLabel) }
    }
}

@Composable
private fun LayoutNode(c: FormController, node: Map<String, Any?>, version: () -> Int) {
    version()
    val type = node["type"] as? String ?: "section"
    if (type == "steps") { Steps(c, (node["children"] as? List<*>) ?: emptyList<Any?>()); return }
    if (type == "text") { Text(Validation.localize(node["text"], c.locale)); return }
    if (type == "divider") { HorizontalDivider(); return }
    Column {
        (node["title"] as? Any)?.let { Text(Validation.localize(it, c.locale), style = MaterialTheme.typography.titleMedium) }
        @Suppress("UNCHECKED_CAST")
        for (fid in (node["fieldRefs"] as? List<String> ?: emptyList())) {
            val f = field(c, fid) ?: continue
            FieldWidget(c, f, f["key"] as String)
        }
        @Suppress("UNCHECKED_CAST")
        for (child in (node["children"] as? List<Map<String, Any?>> ?: emptyList())) LayoutNode(c, child, version)
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
        "file", "image" -> OutlinedButton(onClick = {}, enabled = enabled, modifier = Modifier.testTag("vds-input-$path")) { Text("Choose file (upload provider)") }
        "signature" -> Text("Signature capture is not supported by the Compose renderer.")
        "integer", "decimal", "currency", "percentage", "duration" -> OutlinedTextField(value = value?.toString() ?: "", onValueChange = { s -> val v = if (s.isEmpty()) null else (if (type == "integer") s.toLongOrNull() else s.toDoubleOrNull()) ?: s; c.setFieldValue(path, v) }, enabled = enabled, modifier = Modifier.testTag("vds-input-$path"))
        else -> OutlinedTextField(value = value?.toString() ?: "", onValueChange = { c.setFieldValue(path, it) }, enabled = enabled, modifier = Modifier.testTag("vds-input-$path"))
    }
}
