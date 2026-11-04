# Benchmark results

Generated: 2026-11-04T08:36:59.078Z · Node v22.22.3 · single-run indicative numbers (warmup + measured iterations).

| Benchmark | Iterations | Total (ms) | Ops/sec | Avg (µs/op) |
|---|---:|---:|---:|---:|
| compile (5 example forms) | 2,000 | 1476.2 | 1,355 | 738.1 |
| evaluate invoice total formula | 100,000 | 246.83 | 405,138 | 2.47 |
| evaluate 20-level arithmetic AST | 100,000 | 800.7 | 124,890 | 8.01 |
| validate customer-registration (submit) | 20,000 | 138.68 | 144,216 | 6.93 |
| computeEffectiveState (customer) | 50,000 | 154.89 | 322,807 | 3.1 |
| buildSubmissionPayload (invoice) | 50,000 | 142.13 | 351,798 | 2.84 |
| runtime setFieldValue + recompute (invoice) | 5,000 | 463.07 | 10,798 | 92.61 |

These figures characterize the headless core (no UI rendering). Renderer paint performance is environment-specific and out of scope for this harness.
