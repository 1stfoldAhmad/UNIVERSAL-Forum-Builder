# Next.js App Router integration example

This is a real Next.js App Router example (not the Vite demo under another name).
It demonstrates server-side page composition, plain-JSON serialization across a
Server/Client Component boundary, client-only controller creation, React form
rendering, and a server route that invokes a registered operation through the
trusted Node execution adapter.

The `test:contact.create` operation is deliberately a demo-only in-memory TEST
operation. Replace it with an operation supplied by the host application. The
client never supplies a trusted principal; a production host must resolve identity
from authenticated server middleware and pass it as the separate trusted handler
argument. The example contact form is public and intentionally has no identity.

Run from this directory after the monorepo root `npm ci`:

```sh
npm run dev
npm run build
npm run start
npm run test:e2e
```

The Playwright suite starts the built app, verifies server-rendered page response,
waits for interactive hydration, fills and submits the form, and exercises forged
body-auth rejection and invalid JSON handling.
