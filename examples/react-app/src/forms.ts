import contact from '../../forms/contact.vds.json';
import customer from '../../forms/customer-registration.vds.json';
import invoice from '../../forms/invoice.vds.json';
import kyc from '../../forms/kyc-documents.vds.json';
import job from '../../forms/job-application.vds.json';
import address from '../../forms/business-address.vds.json';
import profile from '../../forms/nested-profile.vds.json';
import survey from '../../forms/field-survey.vds.json';
import purchase from '../../forms/purchase-approval.vds.json';
import type { FormDocument } from '@vds-form/types';

export interface DemoForm { id: string; title: string; blurb: string; document: FormDocument }

export const DEMO_FORMS: DemoForm[] = [
  { id: 'contact', title: 'Contact', blurb: 'Simple fields, sync validation, submission.', document: contact as unknown as FormDocument },
  { id: 'customer', title: 'Customer Registration', blurb: 'Conditional business fields, async email-uniqueness, drafts.', document: customer as unknown as FormDocument },
  { id: 'invoice', title: 'Invoice', blurb: 'Repeater with stable row identity + live computed totals.', document: invoice as unknown as FormDocument },
  { id: 'kyc', title: 'KYC Documents', blurb: 'Drag-and-drop uploads through the Storage contract.', document: kyc as unknown as FormDocument },
  { id: 'job', title: 'Job Application', blurb: 'Multi-step wizard with per-step validation.', document: job as unknown as FormDocument },
  { id: 'address', title: 'Business Address', blurb: 'Cascading data sources (country → city).', document: address as unknown as FormDocument },
  { id: 'profile', title: 'Nested Profile', blurb: 'Nested groups and dotted paths.', document: profile as unknown as FormDocument },
  { id: 'survey', title: 'Field Survey', blurb: 'Ratings, ranges, switches, mixed inputs.', document: survey as unknown as FormDocument },
  { id: 'purchase', title: 'Purchase Approval', blurb: 'Currency, percentage, cross-field rules.', document: purchase as unknown as FormDocument },
];
