/**
 * Demo execution environment for the live preview.
 *
 * IMPORTANT: every provider here is an explicitly-named TEST adapter from
 * @vds-form/vds-contracts. They exercise the REAL submission / data-source /
 * upload / RBAC contracts with in-memory persistence — they are NOT production
 * VDS Database/API/Storage integrations (those builder repos are not public).
 * The point is to prove the full pipeline end-to-end in a browser:
 *   JSON → Schema → Compiler → FormIR → Runtime → React → registered executor.
 */
import {
  SubmissionExecutorRegistry, DataSourceProviderRegistry,
  MemoryDraftStorage, MemoryOfflineQueue,
} from '@vds-form/core';
import {
  TestOperationExecutor, TestDataSourceProvider, TestUploadProvider,
  SimpleRbacEvaluator, authContextFromClaims, InMemoryRecordStore, succeeded,
} from '@vds-form/vds-contracts';
import type { SubmissionContext } from '@vds-form/types';

export interface DemoEnvironment {
  executors: SubmissionExecutorRegistry;
  dataProviders: DataSourceProviderRegistry;
  uploadProvider: TestUploadProvider;
  rbac: SimpleRbacEvaluator;
  auth: ReturnType<typeof authContextFromClaims>;
  drafts: MemoryDraftStorage;
  offlineQueue: MemoryOfflineQueue;
  store: InMemoryRecordStore;
}

const COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'DE', name: 'Germany' },
];
const CITIES: Record<string, Array<{ code: string; name: string }>> = {
  US: [{ code: 'nyc', name: 'New York' }, { code: 'sf', name: 'San Francisco' }],
  GB: [{ code: 'lon', name: 'London' }, { code: 'man', name: 'Manchester' }],
  PK: [{ code: 'isb', name: 'Islamabad' }, { code: 'rwp', name: 'Rawalpindi' }, { code: 'lhe', name: 'Lahore' }],
  DE: [{ code: 'ber', name: 'Berlin' }, { code: 'muc', name: 'Munich' }],
};

export function createDemoEnvironment(): DemoEnvironment {
  const store = new InMemoryRecordStore();
  // Seed a taken email so the async uniqueness validator can reject it live.
  store.create('customers', { email: 'taken@example.com', name: 'Existing Customer' });

  const persist = (table: string, operationRef: string) => (ctx: SubmissionContext) =>
    succeeded(operationRef, store.create(table, ctx.values as Record<string, unknown>), ctx);

  const executors = new SubmissionExecutorRegistry();
  executors.register(new TestOperationExecutor('test', {
    'test:contact.create': persist('contacts', 'test:contact.create'),
    'test:customer.create': (ctx) => {
      const email = (ctx.values as Record<string, unknown>).email;
      if (typeof email === 'string' && store.findBy('customers', 'email', email)) {
        return { status: 'business-rejected', code: 'EMAIL_TAKEN', message: 'That email is already registered.' };
      }
      return succeeded('test:customer.create', store.create('customers', ctx.values as Record<string, unknown>), ctx);
    },
    'test:invoice.create': persist('invoices', 'test:invoice.create'),
    'test:kyc.submit': persist('kycSubmissions', 'test:kyc.submit'),
    'test:application.create': persist('applications', 'test:application.create'),
    'test:profile.save': persist('profiles', 'test:profile.save'),
    'test:address.save': persist('addresses', 'test:address.save'),
    'test:survey.create': persist('surveys', 'test:survey.create'),
    'test:purchase.create': persist('purchases', 'test:purchase.create'),
  }));

  const dataProviders = new DataSourceProviderRegistry();
  dataProviders.register(new TestDataSourceProvider('test', {
    'test:geo.countries': () => COUNTRIES,
    'test:geo.cities': (params) => CITIES[String(params.country ?? '')] ?? [],
    'test:customer.emailUnique': (params) => {
      const taken = Boolean(store.findBy('customers', 'email', params.value));
      return [{ valid: !taken, message: taken ? 'This email is already registered.' : undefined }];
    },
  }));

  return {
    executors,
    dataProviders,
    uploadProvider: new TestUploadProvider(),
    rbac: new SimpleRbacEvaluator(),
    auth: authContextFromClaims({ sub: 'demo-user', tenant_id: 'demo-tenant', roles: ['user'], permissions: ['*'], sid: 'demo-session' }),
    drafts: new MemoryDraftStorage(),
    offlineQueue: new MemoryOfflineQueue(),
    store,
  };
}
