"""
vds.expr/1 expression engine — Python port.

This is a faithful, deterministic port of the TypeScript reference engine
(packages/form-expressions). It executes the SAME canonical AST with the SAME
semantics and is verified against the SAME shared conformance fixtures
(packages/form-conformance/fixtures/expressions.json). No eval/exec of arbitrary
code: a closed, typed operator set with budgets. Errors are returned as values
({"ok": False, "code", "message"}), never raised across boundaries.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

# ---------------- limits ----------------
DEFAULT_LIMITS = {
    "maxNodes": 5000,
    "maxDepth": 64,
    "maxCollectionItems": 10000,
    "maxStringLength": 1_000_000,
}

FORBIDDEN_SEGMENTS = {"__proto__", "constructor", "prototype"}
REF_RE = re.compile(r"^(field|context|item|parent|source):([A-Za-z_][A-Za-z0-9_.\-*\[\]]*)$|^index$")


def ok(value: Any) -> Dict[str, Any]:
    return {"ok": True, "value": value}


def err(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "code": code, "message": message}


def norm(v: Any) -> Any:
    # Python has no `undefined`; JSON null and missing both map to None.
    return None if v is None else v


def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_str(v: Any) -> bool:
    return isinstance(v, str)


def is_bool(v: Any) -> bool:
    return isinstance(v, bool)


# ---------------- path helpers ----------------
def is_safe_path(path: str) -> bool:
    return all(seg.replace("[]", "") not in FORBIDDEN_SEGMENTS for seg in path.split("."))


def get_path(root: Any, path: str) -> Any:
    if not is_safe_path(path):
        return None
    segments = path.split(".")
    current: List[Any] = [root]
    for seg in segments:
        nxt: List[Any] = []
        for node in current:
            if node is None:
                nxt.append(None)
                continue
            if seg == "*":
                if isinstance(node, list):
                    nxt.extend(node)
                else:
                    nxt.append(None)
            elif re.fullmatch(r"\d+", seg) and isinstance(node, list):
                idx = int(seg)
                nxt.append(node[idx] if idx < len(node) else None)
            else:
                if not isinstance(node, dict):
                    nxt.append(None)
                    continue
                nxt.append(node.get(seg))
        current = nxt
    return current if "*" in segments else (current[0] if current else None)


def parse_ref(ref: str) -> Optional[Tuple[str, str]]:
    if ref == "index":
        return ("index", "")
    m = REF_RE.match(ref)
    if not m:
        return None
    kind, path = m.group(1), m.group(2)
    if kind is None:  # matched the `index` alternative
        return ("index", "")
    if any(seg in FORBIDDEN_SEGMENTS for seg in path.split(".")):
        return None
    return (kind, path)


def deep_equal(a: Any, b: Any) -> bool:
    a, b = norm(a), norm(b)
    if a is None or b is None:
        return a is None and b is None
    if is_bool(a) or is_bool(b):
        return is_bool(a) and is_bool(b) and a == b
    if is_num(a) and is_num(b):
        return a == b
    if is_str(a) and is_str(b):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(deep_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return len(a) == len(b) and all(k in b and deep_equal(a[k], b[k]) for k in a)
    return False


def measure_expr(expr: Dict[str, Any]) -> Tuple[int, int]:
    nodes = 0
    max_depth = 0

    def walk(e: Dict[str, Any], d: int) -> None:
        nonlocal nodes, max_depth
        nodes += 1
        max_depth = max(max_depth, d)
        if "op" in e:
            for a in e.get("args", []):
                walk(a, d + 1)

    walk(expr, 1)
    return nodes, max_depth


# ---------------- numeric helpers ----------------
def round_half_away(x: float, digits: int) -> float:
    if not math.isfinite(x):
        return x
    factor = 10 ** digits
    scaled = float(f"{abs(x) * factor:.15g}")  # 15-significant-digit correction
    rounded = math.floor(scaled + 0.5)
    sign = -1 if x < 0 else 1
    return sign * rounded / factor


def finite(v: float) -> Dict[str, Any]:
    return ok(v) if math.isfinite(v) else err("EXPR_OVERFLOW", "Numeric result is not finite.")


def iso_date(v: Any) -> Optional[int]:
    if not is_str(v):
        return None
    if not re.match(r"^\d{4}-\d{2}-\d{2}(T.*)?$", v):
        return None
    s = f"{v}T00:00:00Z" if len(v) == 10 else v
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (ValueError, OverflowError):
        return None


def numbers(args: List[Any], skip_null: bool = False):
    list_ = args
    if len(args) == 1 and isinstance(args[0], list):
        list_ = args[0]
    out: List[float] = []
    for v in list_:
        n = norm(v)
        if n is None and skip_null:
            continue
        if not is_num(n):
            return err("EXPR_TYPE_ERROR", f"Arithmetic expects finite numbers, got {'null' if n is None else type(n).__name__}.")
        out.append(n)
    return {"ok": True, "value": out}


# ---------------- operators ----------------
def _cmp(fn: Callable[[Any, Any], bool]) -> Callable:
    def impl(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
        a, b = norm(args[0]), norm(args[1])
        if is_num(a) and is_num(b):
            return ok(fn(a, b))
        if is_str(a) and is_str(b):
            return ok(fn(a, b))
        return err("EXPR_TYPE_ERROR", "Comparison expects two numbers or two strings.")
    return impl


def _concat(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    out = ""
    for a in args:
        v = norm(a)
        if v is None:
            continue
        if not (is_str(v) or is_num(v) or is_bool(v)):
            return err("EXPR_TYPE_ERROR", "concat expects strings/numbers/booleans.")
        out += str(v).lower() if is_bool(v) else str(v)
        if len(out) > limits["maxStringLength"]:
            return err("EXPR_LIMIT_EXCEEDED", "concat exceeded string budget.")
    return ok(out)


def _to_string(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    import json
    v = norm(args[0])
    if v is None:
        return ok("")
    if is_str(v):
        return ok(v)
    if is_num(v) or is_bool(v):
        return ok(str(v).lower() if is_bool(v) else str(v))
    return ok(json.dumps(v, separators=(",", ":"), ensure_ascii=False))


OPERATORS: Dict[str, Callable[[List[Any], Dict[str, int]], Dict[str, Any]]] = {
    "and": lambda a, l: ok(all(a)) if all(is_bool(x) for x in a) else err("EXPR_TYPE_ERROR", "and expects booleans."),
    "or": lambda a, l: ok(any(a)) if all(is_bool(x) for x in a) else err("EXPR_TYPE_ERROR", "or expects booleans."),
    "not": lambda a, l: ok(not a[0]) if is_bool(a[0]) else err("EXPR_TYPE_ERROR", "not expects a boolean."),
    "if": lambda a, l: ok(norm(a[1] if a[0] else a[2])) if is_bool(a[0]) else err("EXPR_TYPE_ERROR", "if expects a boolean condition."),
    "coalesce": lambda a, l: next((ok(x) for x in a if norm(x) is not None), ok(None)),
    "eq": lambda a, l: ok(deep_equal(a[0], a[1])),
    "neq": lambda a, l: ok(not deep_equal(a[0], a[1])),
    "gt": _cmp(lambda a, b: a > b),
    "gte": _cmp(lambda a, b: a >= b),
    "lt": _cmp(lambda a, b: a < b),
    "lte": _cmp(lambda a, b: a <= b),
    "isNull": lambda a, l: ok(norm(a[0]) is None),
    "isEmpty": lambda a, l: _is_empty(a[0]),
    "in": lambda a, l: ok(any(deep_equal(v, a[0]) for v in a[1])) if isinstance(a[1], list) else err("EXPR_TYPE_ERROR", "in expects (value, array)."),
    "contains": lambda a, l: _contains(a[0], a[1]),
    "concat": _concat,
    "len": lambda a, l: _len(a[0], l),
    "startsWith": lambda a, l: ok(a[0].startswith(a[1])) if is_str(a[0]) and is_str(a[1]) else err("EXPR_TYPE_ERROR", "startsWith expects strings."),
    "endsWith": lambda a, l: ok(a[0].endswith(a[1])) if is_str(a[0]) and is_str(a[1]) else err("EXPR_TYPE_ERROR", "endsWith expects strings."),
    "lower": lambda a, l: ok(a[0].lower()) if is_str(a[0]) else err("EXPR_TYPE_ERROR", "lower expects a string."),
    "upper": lambda a, l: ok(a[0].upper()) if is_str(a[0]) else err("EXPR_TYPE_ERROR", "upper expects a string."),
    "trim": lambda a, l: ok(a[0].strip()) if is_str(a[0]) else err("EXPR_TYPE_ERROR", "trim expects a string."),
    "add": lambda a, l: _reduce(a, l, lambda x, y: x + y, 0),
    "mul": lambda a, l: _reduce(a, l, lambda x, y: x * y, 1),
    "sub": lambda a, l: _sub(a, l),
    "div": lambda a, l: _div(a, l),
    "mod": lambda a, l: _mod(a, l),
    "abs": lambda a, l: ok(abs(a[0])) if is_num(a[0]) else err("EXPR_TYPE_ERROR", "abs expects a number."),
    "round": lambda a, l: _round(a, l),
    "sum": lambda a, l: _reduce(a, l, lambda x, y: x + y, 0, skip_null=True),
    "avg": lambda a, l: _avg(a, l),
    "min": lambda a, l: _minmax(a, l, min),
    "max": lambda a, l: _minmax(a, l, max),
    "count": lambda a, l: ok(len(a[0])) if isinstance(a[0], list) else (ok(0) if norm(a[0]) is None else err("EXPR_TYPE_ERROR", "count expects an array.")),
    "toNumber": lambda a, l: _to_number(a[0]),
    "toString": _to_string,
    "toBoolean": lambda a, l: _to_boolean(a[0]),
    "dateAddDays": lambda a, l: _date_add(a, l),
    "dateDiffDays": lambda a, l: _date_diff(a, l),
}

OPERATOR_ARITY: Dict[str, Tuple[int, int]] = {
    "and": (1, -1), "or": (1, -1), "not": (1, 1), "if": (3, 3), "coalesce": (1, -1),
    "eq": (2, 2), "neq": (2, 2), "gt": (2, 2), "gte": (2, 2), "lt": (2, 2), "lte": (2, 2),
    "isNull": (1, 1), "isEmpty": (1, 1), "in": (2, 2), "contains": (2, 2),
    "concat": (0, -1), "len": (1, 1), "startsWith": (2, 2), "endsWith": (2, 2),
    "lower": (1, 1), "upper": (1, 1), "trim": (1, 1),
    "add": (0, -1), "mul": (0, -1), "sub": (1, -1), "div": (2, 2), "mod": (2, 2),
    "abs": (1, 1), "round": (1, 2), "sum": (1, -1), "avg": (1, -1), "min": (1, -1), "max": (1, -1), "count": (1, 1),
    "toNumber": (1, 1), "toString": (1, 1), "toBoolean": (1, 1),
    "dateAddDays": (2, 2), "dateDiffDays": (2, 2),
}


def _is_empty(v: Any) -> Dict[str, Any]:
    v = norm(v)
    if v is None:
        return ok(True)
    if is_str(v):
        return ok(len(v) == 0)
    if isinstance(v, list):
        return ok(len(v) == 0)
    if isinstance(v, dict):
        return ok(len(v) == 0)
    return ok(False)


def _contains(c: Any, x: Any) -> Dict[str, Any]:
    c = norm(c)
    if is_str(c) and is_str(x):
        return ok(x in c)
    if isinstance(c, list):
        return ok(any(deep_equal(v, x) for v in c))
    return err("EXPR_TYPE_ERROR", "contains expects (string, string) or (array, value).")


def _len(v: Any, limits: Dict[str, int]) -> Dict[str, Any]:
    v = norm(v)
    if is_str(v):
        return ok(len(v))
    if isinstance(v, list):
        return err("EXPR_LIMIT_EXCEEDED", "Collection too large.") if len(v) > limits["maxCollectionItems"] else ok(len(v))
    if v is None:
        return ok(0)
    return err("EXPR_TYPE_ERROR", "len expects string or array.")


def _reduce(args: List[Any], limits: Dict[str, int], fn: Callable, init: float, skip_null: bool = False) -> Dict[str, Any]:
    n = numbers(args, skip_null)
    if not n["ok"]:
        return n
    acc = init
    for v in n["value"]:
        acc = fn(acc, v)
    return finite(acc)


def _sub(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    n = numbers(args)
    if not n["ok"]:
        return n
    if not n["value"]:
        return ok(0)
    acc = n["value"][0]
    for v in n["value"][1:]:
        acc -= v
    return finite(acc)


def _div(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    if not is_num(args[0]) or not is_num(args[1]):
        return err("EXPR_TYPE_ERROR", "div expects numbers.")
    if args[1] == 0:
        return err("EXPR_DIVISION_BY_ZERO", "Division by zero.")
    return finite(args[0] / args[1])


def _mod(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    if not is_num(args[0]) or not is_num(args[1]):
        return err("EXPR_TYPE_ERROR", "mod expects numbers.")
    if args[1] == 0:
        return err("EXPR_DIVISION_BY_ZERO", "Modulo by zero.")
    return finite(math.fmod(args[0], args[1]))


def _round(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    if not is_num(args[0]):
        return err("EXPR_TYPE_ERROR", "round expects a number.")
    d = args[1] if len(args) > 1 else 0
    if not is_num(d) or not float(d).is_integer() or d < 0 or d > 10:
        return err("EXPR_TYPE_ERROR", "round digits must be integer 0..10.")
    return ok(round_half_away(args[0], int(d)))


def _avg(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    n = numbers(args, True)
    if not n["ok"]:
        return n
    if not n["value"]:
        return ok(None)
    return finite(sum(n["value"]) / len(n["value"]))


def _minmax(args: List[Any], limits: Dict[str, int], fn: Callable) -> Dict[str, Any]:
    n = numbers(args, True)
    if not n["ok"]:
        return n
    return ok(fn(n["value"]) if n["value"] else None)


def _to_number(v: Any) -> Dict[str, Any]:
    v = norm(v)
    if v is None:
        return ok(None)
    if is_num(v):
        return ok(v)
    if is_bool(v):
        return ok(1 if v else 0)
    if is_str(v) and v.strip() != "":
        try:
            f = float(v)
            if math.isfinite(f):
                return ok(int(f) if f.is_integer() and "." not in v and "e" not in v.lower() else f)
        except ValueError:
            pass
    return err("EXPR_TYPE_ERROR", "toNumber cannot convert value.")


def _to_boolean(v: Any) -> Dict[str, Any]:
    v = norm(v)
    if is_bool(v):
        return ok(v)
    if v is None:
        return ok(False)
    if is_num(v):
        return ok(v != 0)
    if is_str(v):
        return ok(len(v) > 0)
    if isinstance(v, list):
        return ok(len(v) > 0)
    return ok(True)


def _date_add(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    t = iso_date(args[0])
    if t is None or not is_num(args[1]) or not float(args[1]).is_integer():
        return err("EXPR_TYPE_ERROR", "dateAddDays expects (ISO date, integer days).")
    dt = datetime.fromtimestamp((t + int(args[1]) * 86400000) / 1000, tz=timezone.utc)
    return ok(dt.strftime("%Y-%m-%d"))


def _date_diff(args: List[Any], limits: Dict[str, int]) -> Dict[str, Any]:
    a, b = iso_date(args[0]), iso_date(args[1])
    if a is None or b is None:
        return err("EXPR_TYPE_ERROR", "dateDiffDays expects ISO dates.")
    return ok(round((a - b) / 86400000))


# ---------------- reference resolution ----------------
def resolve_ref(ref: str, scope: Dict[str, Any]) -> Dict[str, Any]:
    parsed = parse_ref(ref)
    if not parsed:
        return err("EXPR_REFERENCE_INVALID", f'Invalid reference "{ref}".')
    kind, path = parsed
    limits = {**DEFAULT_LIMITS, **scope.get("limits", {})}
    if kind == "field":
        v = get_path(scope.get("values", {}), path)
        if isinstance(v, list) and "*" in path and len(v) > limits["maxCollectionItems"]:
            return err("EXPR_LIMIT_EXCEEDED", "Wildcard projection exceeded collection budget.")
        return ok(None if v is None else v)
    if kind == "item":
        if scope.get("rowPrefix") is None:
            return err("EXPR_SCOPE_ERROR", f'item: reference "{ref}" used outside a repeater row.')
        v = get_path(scope.get("values", {}), f"{scope['rowPrefix']}.{path}")
        return ok(None if v is None else v)
    if kind == "parent":
        full = f"{scope['parentPrefix']}.{path}" if scope.get("parentPrefix") else path
        v = get_path(scope.get("values", {}), full)
        return ok(None if v is None else v)
    if kind == "index":
        if scope.get("rowIndex") is None:
            return err("EXPR_SCOPE_ERROR", "index reference used outside a repeater row.")
        return ok(scope["rowIndex"])
    if kind == "context":
        v = get_path(scope.get("context", {}), path)
        return ok(None if v is None else v)
    if kind == "source":
        v = scope.get("sources", {}).get(path)
        return ok(None if v is None else v)
    return err("EXPR_REFERENCE_INVALID", f'Invalid reference "{ref}".')


# ---------------- evaluator ----------------
def evaluate(expr: Dict[str, Any], scope: Dict[str, Any]) -> Dict[str, Any]:
    limits = {**DEFAULT_LIMITS, **scope.get("limits", {})}
    nodes, depth = measure_expr(expr)
    if nodes > limits["maxNodes"]:
        return err("EXPR_LIMIT_EXCEEDED", f"Expression has {nodes} nodes (max {limits['maxNodes']}).")
    if depth > limits["maxDepth"]:
        return err("EXPR_LIMIT_EXCEEDED", f"Expression depth {depth} exceeds max {limits['maxDepth']}.")

    budget = limits["maxNodes"] * 4
    functions = scope.get("functions", {})

    def eval_node(e: Dict[str, Any], d: int) -> Dict[str, Any]:
        nonlocal budget
        budget -= 1
        if budget < 0:
            return err("EXPR_LIMIT_EXCEEDED", "Evaluation budget exhausted.")
        if d > limits["maxDepth"]:
            return err("EXPR_LIMIT_EXCEEDED", "Depth budget exceeded.")
        if "const" in e:
            return ok(e["const"])
        if "ref" in e:
            return resolve_ref(e["ref"], {**scope, "limits": limits})
        if "op" not in e:
            return err("EXPR_REFERENCE_INVALID", "Malformed expression node.")

        op = e["op"]
        args_ast = e.get("args", [])
        own_op = op in OPERATORS
        own_fn = op in functions
        if not own_op and not own_fn:
            return err("EXPR_UNKNOWN_OPERATOR", f'Unknown operator "{op}".')
        if own_op:
            lo, hi = OPERATOR_ARITY[op]
            if len(args_ast) < lo or (hi != -1 and len(args_ast) > hi):
                return err("EXPR_TYPE_ERROR", f'Operator "{op}" has wrong arity ({len(args_ast)}).')

        if op in ("and", "or"):
            for a in args_ast:
                r = eval_node(a, d + 1)
                if not r["ok"]:
                    return r
                if not is_bool(r["value"]):
                    return err("EXPR_TYPE_ERROR", f"{op} expects booleans.")
                if op == "and" and r["value"] is False:
                    return ok(False)
                if op == "or" and r["value"] is True:
                    return ok(True)
            return ok(op == "and")
        if op == "if":
            c = eval_node(args_ast[0], d + 1)
            if not c["ok"]:
                return c
            if not is_bool(c["value"]):
                return err("EXPR_TYPE_ERROR", "if expects a boolean condition.")
            return eval_node(args_ast[1] if c["value"] else args_ast[2], d + 1)
        if op == "coalesce":
            for a in args_ast:
                r = eval_node(a, d + 1)
                if not r["ok"]:
                    return r
                if r["value"] is not None:
                    return ok(r["value"])
            return ok(None)

        args: List[Any] = []
        for a in args_ast:
            r = eval_node(a, d + 1)
            if not r["ok"]:
                return r
            args.append(r["value"])
        if own_op:
            return OPERATORS[op](args, limits)
        return functions[op](args)

    return eval_node(expr, 1)


def evaluate_boolean(expr: Dict[str, Any], scope: Dict[str, Any]) -> Dict[str, Any]:
    r = evaluate(expr, scope)
    if not r["ok"]:
        return r
    if not is_bool(r["value"]):
        return err("EXPR_TYPE_ERROR", "Condition must evaluate to a boolean.")
    return r
