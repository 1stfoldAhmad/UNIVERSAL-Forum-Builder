import type { ReactNode } from 'react';

export const metadata = {
  title: 'VDS Universal Form Builder — Next.js App Router example',
  description: 'Server-compiled FormIR, a client form boundary, and a trusted submission route.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f7f7f8' }}>
        <main style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>{children}</main>
      </body>
    </html>
  );
}
