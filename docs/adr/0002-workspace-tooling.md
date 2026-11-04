# ADR-0002 — Workspace tooling

Status: accepted · 2026-11-04

## Decision
- **npm workspaces** (npm 10 ships with Node 22) — no Nx/Turbo/Lerna.
- TypeScript ~5.9, strict, ESM (`"type": "module"`). Packages are **source-first**:
  `exports` point at `./src/index.ts`; consumers (vitest, vite, tsx) compile TS directly.
  A `tsc` build to `dist/` is part of release preparation, not day-to-day testing.
- **vitest 3** for all TS tests, mirroring the reference library's proven setup:
  - core/integrations/tools → node environment
  - React/Vue/Angular adapters → jsdom (Angular adds zone.js + TestBed JIT setup)
  - Expo adapter → jsdom with `react-native → react-native-web` alias (same technique the
    reference library uses in CI), `__DEV__` defined.
- Python adapter: pytest + Django from PyPI. PHP adapter: framework-free core + Laravel
  provider; executed only if a PHP runtime can be obtained (see ADR-0006).

## Rationale
The reference repo proves this exact toolchain works for Expo-targeted code without devices.
No unnecessary build systems; every claim of "verified" maps to an executed command.
