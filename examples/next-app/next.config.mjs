/**
 * The workspace packages ship TypeScript source, so Next must transpile them.
 * No browser-only globals are touched during SSR by the form packages.
 */
const config = {
  reactStrictMode: true,
  transpilePackages: [
    '@vds-form/react', '@vds-form/runtime', '@vds-form/compiler', '@vds-form/core',
    '@vds-form/types', '@vds-form/validation', '@vds-form/expressions', '@vds-form/fields',
    '@vds-form/submission', '@vds-form/vds-contracts', '@vds-form/execution-node',
    '@vds-form/data-sources', '@vds-form/persistence', '@vds-form/spec',
    '@vds-form/migrations', '@vds-form/inspector', '@vds-form/plugin-sdk', '@vds-form/vds-logic',
  ],
  typescript: { ignoreBuildErrors: false },
};

export default config;
