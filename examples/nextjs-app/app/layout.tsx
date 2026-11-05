import type { ReactNode } from 'react';

export const metadata = { title: 'VDS Form — Next.js App Router', description: 'Canonical vds.form rendered with React.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 760, margin: '2rem auto', padding: '0 1rem' }}>{children}</body></html>;
}
