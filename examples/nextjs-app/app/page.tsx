import contactDocument from '../../forms/contact.vds.json';
import FormClient from './form-client';

/** Server Component: imports the canonical document and passes only JSON data across the client boundary. */
export default function Page() {
  const safeDocument = JSON.parse(JSON.stringify(contactDocument));
  return <main>
    <h1>Contact form</h1>
    <p>Server-composed App Router page; interactive runtime is isolated below the client boundary.</p>
    <FormClient document={safeDocument} />
  </main>;
}
