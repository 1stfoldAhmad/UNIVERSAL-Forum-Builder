import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'core',
      environment: 'node',
      include: [
        'packages/*/tests/**/*.test.ts',
        'execution-adapters/node/tests/**/*.test.ts',
        'integrations/*/tests/**/*.test.ts',
        'tools/*/tests/**/*.test.ts',
        'examples/headless-node/**/*.test.ts',
        'tests/**/*.test.ts',
        'adapters/node/tests/**/*.test.ts',
      ],
      exclude: ['**/node_modules/**', '**/dist/**', 'vendor/**', '**/*.hydrate.test.ts'],
    },
  },
  {
    esbuild: { jsx: 'automatic' },
    test: {
      name: 'web',
      environment: 'jsdom',
      globals: true,
      include: [
        'adapters/react/tests/**/*.test.tsx',
        'adapters/vue/tests/**/*.test.ts',
        'examples/react-app/tests/**/*.test.tsx',
        'adapters/node/tests/**/*.hydrate.test.ts',
      ],
      exclude: ['**/node_modules/**'],
      setupFiles: ['./tests/setup-web.ts'],
    },
  },
  {
    esbuild: { jsx: 'automatic' },
    resolve: {
      alias: { 'react-native': 'react-native-web' },
      extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
    },
    define: { __DEV__: 'true' },
    test: {
      name: 'native',
      environment: 'jsdom',
      globals: true,
      include: [
        'adapters/expo/tests/**/*.test.tsx',
        'examples/expo-app/tests/**/*.test.tsx',
      ],
      exclude: ['**/node_modules/**'],
      setupFiles: ['./tests/setup-web.ts'],
    },
  },
  {
    esbuild: { jsx: 'automatic' },
    resolve: {
      // `server-only` throws outside the RSC runtime; the real guard is verified
      // by `next build`. See tests/stubs/server-only.ts.
      alias: { 'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url).pathname },
    },
    test: {
      name: 'nextjs',
      environment: 'node',
      globals: true,
      include: ['examples/next-app/tests/**/*.test.ts', 'examples/next-app/tests/**/*.test.tsx'],
      exclude: ['**/node_modules/**', '**/.next/**'],
    },
  },
  {
    test: {
      name: 'angular',
      environment: 'jsdom',
      globals: true,
      include: ['adapters/angular/tests/**/*.test.ts'],
      exclude: ['**/node_modules/**'],
      setupFiles: ['./tests/setup-angular.ts'],
    },
  },
]);
