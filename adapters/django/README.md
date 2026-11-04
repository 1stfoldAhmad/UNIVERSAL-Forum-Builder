# @vds-form/django — Django server-rendered renderer

Renders the compiled **FormIR** to the shared VDS server-rendered HTML contract
(the same contract produced by `@vds-form/node` and `@vds-form/laravel`), so a
single hydration client (`@vds-form/node/client`) enhances all three targets.

## What it supports

- All canonical field types except `signature` (declared in the capability manifest).
- Groups, repeaters (concrete row paths), multi-step layout.
- Server-side defaults, **formulas** (row-scoped and global) and effective state
  computed with the conformance-verified `vds_form` expression engine.
- Localization, accessibility attributes, and validation error display.
- **No-JS** urlencoded POST (dot-path names → typed nested values) and JSON POST.
- Submission through the trusted `vds_form.submission.TrustedSubmissionHandler`
  with a **server-derived** principal (`request.user` / verified claims). The
  request body is never a source of authorization (`auth` in body → 400).

## Layout

- `vds_form_renderer/state.py` — render state (defaults, repeater rows, formulas).
- `vds_form_renderer/html.py` — framework-free HTML renderer (`render_form`, `render_page`).
- `vds_form_renderer/parse.py` — no-JS POST parsing.
- `vds_form_renderer/views.py` — `create_form_view(handler, irs, auth_resolver=…)`.
- `vds_form_renderer/templatetags/vds_form.py` — `{% render_vds_form ir %}`.
- `vds_form_renderer/capabilities.py` — capability manifest.

## Host wiring

```python
from vds_form.submission import TrustedSubmissionHandler, OperationRegistry, SimpleRbacEvaluator
from vds_form_renderer.views import create_form_view

ops = OperationRegistry()
ops.register("database:customer.create", real_create_customer)  # real VDS operation
handler = TrustedSubmissionHandler(forms={"customer-registration": compiled_ir},
                                   operations=ops, rbac=SimpleRbacEvaluator())
# urls.py
urlpatterns = [path("forms/<str:form_id>", create_form_view(handler, {"customer-registration": compiled_ir}))]
```

Compile forms once with the TS compiler (`vds-form compile --json`) and register
the resulting IR. The renderer depends on the `vds_form` execution adapter
(`execution-adapters/django`), which must be importable on `sys.path`.

## Tests

```bash
cd adapters/django && python -m pytest -q
```
