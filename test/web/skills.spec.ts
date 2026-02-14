import { test, expect } from './fixtures';

test.describe('Web UI - Skills', () => {
  test('skills page loads from sidebar', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/`);

    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.getByRole('link', { name: 'Skills' }).click();
    await expect(page.getByRole('heading', { name: 'Skills' })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Add Skill' })).toBeVisible();
  });
});
