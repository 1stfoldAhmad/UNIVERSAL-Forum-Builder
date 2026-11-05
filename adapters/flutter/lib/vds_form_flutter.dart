/// VDS Universal Form Builder — Flutter renderer.
///
/// A faithful Dart port of the vds.expr/1 engine + validation + headless
/// controller, with a native Material UI. Operates on the compiled FormIR and
/// submits through an injected trusted transport (never executes operations
/// locally). Verified against the shared cross-language conformance fixtures.
library vds_form_flutter;

export 'src/assets.dart';
export 'src/expr.dart';
export 'src/validation.dart';
export 'src/controller.dart';
export 'src/widgets.dart';
export 'src/capabilities.dart';
