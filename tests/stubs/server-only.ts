/**
 * Test stub for the `server-only` package.
 *
 * Next.js uses `server-only` to make a module throw if it is ever imported into
 * a client bundle. Outside the React Server Components runtime (e.g. Vitest)
 * there is no `react-server` export condition, so the real package would throw.
 * This stub lets server modules be unit-tested; the real guard still applies in
 * the Next.js build, which is verified by `next build` in CI.
 */
export {};
