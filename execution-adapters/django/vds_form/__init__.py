"""VDS Universal Form Builder — Django/Python execution adapter.

Exposes the vds.expr/1 engine (cross-language conformance-verified), a trusted
submission handler (server re-validation, RBAC, idempotency, redacted audit),
and a thin Django view integration. The core logic is framework-free so it can
be conformance-tested without a Django project.
"""
from .expressions import evaluate, evaluate_boolean, get_path, deep_equal, OPERATORS, OPERATOR_ARITY

__all__ = ["evaluate", "evaluate_boolean", "get_path", "deep_equal", "OPERATORS", "OPERATOR_ARITY"]
__version__ = "1.0.0"
