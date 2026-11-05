import { expect, test } from '@playwright/test';

test('SSR page hydrates the canonical form and submits through trusted host operation', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Contact form' })).toBeVisible();
  // Wait for the client effect to initialize; this verifies hydration beyond SSR HTML.
  const name = page.getByLabel('Full name');
  await expect(name).toBeVisible();
  await name.fill('Ada Lovelace');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Message').fill('A sufficiently long message for this test.');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('submission-status')).toHaveText('succeeded');
});

test('trusted route rejects forged authentication and malformed JSON', async ({ request }) => {
  const forged = await request.post('/api/forms/submit', { data: { auth: { userId: 'attacker' } } });
  expect(forged.status()).toBe(400);
  expect((await forged.json()).code).toBe('AUTH_IN_BODY_FORBIDDEN');
  const invalid = await request.post('/api/forms/submit', { data: '{', headers: { 'content-type': 'application/json' } });
  expect(invalid.status()).toBe(400);
});
