import { test, expect } from './fixtures';

test.describe('Web UI - MCP', () => {
  test('mcp page loads from sidebar', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/`);

    await page.getByRole('button', { name: 'Integrations' }).click();
    await page.getByRole('link', { name: 'MCP' }).click();
    await expect(page.getByRole('heading', { name: 'MCP Servers' })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Add MCP Server' })).toBeVisible();
  });
});
