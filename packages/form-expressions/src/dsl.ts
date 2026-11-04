/**
 * Authoring sugar: a tiny text DSL that compiles to the canonical vds.expr/1 AST.
 * The DSL is NOT the cross-language contract — the AST is. No eval is used;
 * this is a hand-written tokenizer + Pratt parser with hard limits.
 *
 *   qty * price + 1          → arithmetic on field refs
 *   $item.qty * $item.price  → repeater row scope
 *   items.*.amount           → wildcard collection projection
 *   SUM(items.*.lineTotal)   → operator call (case-insensitive)
 *   $context.today           → approved context ref
 *   customer.type == "business" AND NOT isEmpty(taxId)
 */
import type { Expr } from '@vds-form/types';
import { OPERATOR_ARITY } from './operators';
import { parseRef } from './refs';

export const MAX_DSL_LENGTH = 4000;
export const MAX_DSL_TOKENS = 1000;
export const MAX_DSL_DEPTH = 64;

export class DslSyntaxError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
    this.name = 'DslSyntaxError';
  }
}

type Tok =
  | { t: 'num'; v: number; o: number }
  | { t: 'str'; v: string; o: number }
  | { t: 'ident'; v: string; o: number }
  | { t: 'op'; v: string; o: number }
  | { t: 'eof'; v: ''; o: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const push = (t: Tok) => {
    toks.push(t);
    if (toks.length > MAX_DSL_TOKENS) throw new DslSyntaxError('Too many tokens.', i);
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '"' || c === "'") {
      const quote = c; let j = i + 1; let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      if (j >= src.length) throw new DslSyntaxError('Unterminated string.', i);
      push({ t: 'str', v: out, o: i }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new DslSyntaxError('Invalid number.', i);
      push({ t: 'num', v: Number(m[0]), o: i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$@]/.test(c)) {
      const m = /^[A-Za-z_$@][A-Za-z0-9_$@.\-*]*/.exec(src.slice(i))!;
      push({ t: 'ident', v: m[0], o: i }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) { push({ t: 'op', v: two, o: i }); i += 2; continue; }
    if ('+-*/%(),<>!'.includes(c)) { push({ t: 'op', v: c, o: i }); i += 1; continue; }
    throw new DslSyntaxError(`Unexpected character "${c}".`, i);
  }
  push({ t: 'eof', v: '', o: i });
  return toks;
}

const OP_ALIASES: Record<string, string> = {
  '==': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
  '&&': 'and', '||': 'or', '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
};
const PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, 'IN': 3, '>': 4, '>=': 4, '<': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
};
OP_ALIASES['IN'] = 'in';

/** Keyword operators: uppercase AND / OR / NOT / IN (function forms AND(a,b) still work). */
function keywordOp(toks: Tok[], pos: number): string | null {
  const t = toks[pos];
  if (t.t !== 'ident') return null;
  if (t.v === 'AND' && toks[pos + 1]?.v !== '(') return '&&';
  if (t.v === 'OR' && toks[pos + 1]?.v !== '(') return '||';
  if (t.v === 'IN') return 'IN';
  return null;
}

function identToRef(name: string, offset: number): Expr {
  const lower = name.toLowerCase();
  if (lower === 'true') return { const: true };
  if (lower === 'false') return { const: false };
  if (lower === 'null') return { const: null };
  let ref: string;
  if (name === '$index') ref = 'index';
  else if (name.startsWith('$item.')) ref = `item:${name.slice(6)}`;
  else if (name.startsWith('$parent.')) ref = `parent:${name.slice(8)}`;
  else if (name.startsWith('$context.')) ref = `context:${name.slice(9)}`;
  else if (name.startsWith('$source.')) ref = `source:${name.slice(8)}`;
  else if (name.startsWith('$')) throw new DslSyntaxError(`Unknown scope token "${name}".`, offset);
  else ref = `field:${name}`;
  if (!parseRef(ref)) throw new DslSyntaxError(`Invalid reference "${name}".`, offset);
  return { ref };
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private expect(v: string) {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v) throw new DslSyntaxError(`Expected "${v}".`, t.o);
  }

  parse(depth = 0): Expr {
    if (depth > MAX_DSL_DEPTH) throw new DslSyntaxError('Expression too deep.', this.peek().o);
    let left = this.unary(depth);
    for (;;) {
      const t = this.peek();
      const kw = keywordOp(this.toks, this.pos);
      const opv = t.t === 'op' && t.v in PRECEDENCE ? t.v : kw;
      if (!opv) break;
      const prec = PRECEDENCE[opv];
      this.next();
      const right = this.parsePrec(prec + 1, depth + 1);
      left = { op: OP_ALIASES[opv], args: [left, right] };
    }
    return left;
  }
  private parsePrec(minPrec: number, depth: number): Expr {
    if (depth > MAX_DSL_DEPTH) throw new DslSyntaxError('Expression too deep.', this.peek().o);
    let left = this.unary(depth);
    for (;;) {
      const t = this.peek();
      const kw = keywordOp(this.toks, this.pos);
      const opv = t.t === 'op' && t.v in PRECEDENCE ? t.v : kw;
      if (!opv || PRECEDENCE[opv] < minPrec) break;
      this.next();
      const right = this.parsePrec(PRECEDENCE[opv] + 1, depth + 1);
      left = { op: OP_ALIASES[opv], args: [left, right] };
    }
    return left;
  }
  private unary(depth: number): Expr {
    const t = this.peek();
    if (t.t === 'ident' && t.v === 'NOT') { this.next(); return { op: 'not', args: [this.unary(depth + 1)] }; }
    if (t.t === 'op' && t.v === '!') { this.next(); return { op: 'not', args: [this.unary(depth + 1)] }; }
    if (t.t === 'op' && t.v === '-') { this.next(); return { op: 'sub', args: [{ const: 0 }, this.unary(depth + 1)] }; }
    return this.primary(depth);
  }
  private primary(depth: number): Expr {
    const t = this.next();
    if (t.t === 'num') return { const: t.v };
    if (t.t === 'str') return { const: t.v };
    if (t.t === 'op' && t.v === '(') {
      const inner = this.parse(depth + 1);
      this.expect(')');
      return inner;
    }
    if (t.t === 'ident') {
      if (this.peek().t === 'op' && (this.peek() as { v: string }).v === '(') {
        this.next();
        const args: Expr[] = [];
        if (!(this.peek().t === 'op' && (this.peek() as { v: string }).v === ')')) {
          for (;;) {
            args.push(this.parse(depth + 1));
            const sep = this.next();
            if (sep.t === 'op' && sep.v === ')') break;
            if (!(sep.t === 'op' && sep.v === ',')) throw new DslSyntaxError('Expected "," or ")".', sep.o);
          }
        } else this.next();
        const op = resolveOpName(t.v);
        if (!op) throw new DslSyntaxError(`Unknown function "${t.v}".`, t.o);
        const arity = OPERATOR_ARITY[op];
        if (arity && (args.length < arity[0] || (arity[1] !== -1 && args.length > arity[1]))) {
          throw new DslSyntaxError(`Function "${t.v}" has wrong argument count.`, t.o);
        }
        return { op, args };
      }
      return identToRef(t.v, t.o);
    }
    throw new DslSyntaxError('Unexpected token.', t.o);
  }
}

function resolveOpName(name: string): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(OPERATOR_ARITY)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

/** Compile DSL text to the canonical AST. Throws DslSyntaxError on invalid input. */
export function compileDsl(source: string): Expr {
  if (source.length > MAX_DSL_LENGTH) throw new DslSyntaxError('Expression too long.', 0);
  const parser = new Parser(tokenize(source));
  const ast = parser.parse();
  // Ensure full consumption.
  const rest = (parser as unknown as { toks: Tok[]; pos: number });
  if (rest.toks[rest.pos].t !== 'eof') throw new DslSyntaxError('Trailing tokens.', rest.toks[rest.pos].o);
  return ast;
}
