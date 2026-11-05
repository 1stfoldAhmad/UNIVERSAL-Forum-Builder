/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@vds-form/core', '@vds-form/react', '@vds-form/runtime', '@vds-form/types',
    '@vds-form/validation', '@vds-form/expressions', '@vds-form/fields',
    '@vds-form/compiler', '@vds-form/submission', '@vds-form/spec',
    '@vds-form/execution-node', '@vds-form/vds-contracts',
  ],
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
};
export default nextConfig;
