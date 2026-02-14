import { test, expect } from './fixtures';
import { generateTestWorkspaceName } from '../helpers/agent';

test.describe('Web UI', () => {
  test('loads dashboard page', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1')).toContainText('Dashboard');
  });

  test('shows empty workspace list after deleting all workspaces', async ({ agent, page }) => {
    const workspaces = await agent.api.listWorkspaces();
    for (const ws of workspaces) {
      await agent.api.deleteWorkspace(ws.name);
    }

    await page.goto(`http://127.0.0.1:${agent.port}/workspaces`);
    await expect(page.getByRole('heading', { name: 'Welcome to Perry' })).toBeVisible({
      timeout: 15000,
    });

    await agent.api.createWorkspace({ name: workspaces[0]?.name || generateTestWorkspaceName() });
  });

  test('can navigate to settings', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/settings`);
    await expect(page.locator('h1')).toContainText('Environment', { timeout: 15000 });
  });
});

test.describe('Web UI - Workspace Operations', () => {
  test('shows created workspace in list', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces`);
    await expect(page.getByText(workspaceName).first()).toBeVisible({ timeout: 30000 });
  });

  test('can open workspace detail page', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}`);
    await expect(page.getByText(workspaceName).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('button', { name: /sessions/i })).toBeVisible();
  });

  test('shows workspace status indicators', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces`);
    await expect(page.getByText(workspaceName).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Running').first()).toBeVisible();
  });

  test('can stop workspace from detail page', async ({ agent, page }) => {
    const name = generateTestWorkspaceName();
    await agent.api.createWorkspace({ name });

    try {
      await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${name}?tab=settings`);
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 30000 });

      const stopButton = page.getByRole('button', { name: /^stop$/i });
      await stopButton.click();

      await expect(page.getByText('stopped').first()).toBeVisible({ timeout: 30000 });
    } finally {
      await agent.api.deleteWorkspace(name);
    }
  });
});

test.describe('Web UI - Create Workspace', () => {
  test('create workspace form shows name and repo inputs', async ({
    agent,
    workspaceName,
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces`);
    await page.waitForLoadState('networkidle');

    const newWorkspaceButton = page.getByRole('button', { name: /new workspace/i });
    await newWorkspaceButton.click();

    await expect(page.getByLabel('Name')).toBeVisible({ timeout: 10000 });
    await expect(page.getByPlaceholder('my-project')).toBeVisible();
    await expect(page.getByPlaceholder('https://github.com/user/repo')).toBeVisible();
  });

  test('repo selector allows manual URL entry', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces`);
    await page.waitForLoadState('networkidle');

    const newWorkspaceButton = page.getByRole('button', { name: /new workspace/i });
    await newWorkspaceButton.click();

    const repoInput = page.getByPlaceholder('https://github.com/user/repo');
    await expect(repoInput).toBeVisible({ timeout: 10000 });

    await repoInput.fill('https://github.com/test/repo');
    await expect(repoInput).toHaveValue('https://github.com/test/repo');
  });
});

test.describe('Web UI - Settings Pages', () => {
  test('environment settings page loads', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/settings/environment`);
    await expect(page.locator('h1')).toContainText('Environment', { timeout: 15000 });
  });

  test('agents settings page loads', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/settings/agents`);
    await expect(page.locator('h1')).toContainText('AI Agents', { timeout: 15000 });
  });

  test('files settings page loads', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/settings/files`);
    await expect(page.locator('h1')).toContainText('Files', { timeout: 15000 });
  });

  test('scripts settings page loads', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/settings/scripts`);
    await expect(page.locator('h1')).toContainText('Scripts', { timeout: 15000 });
  });
});

test.describe('Web UI - Terminal', () => {
  test('can open terminal tab and interact', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}`);
    await expect(page.getByText(workspaceName).first()).toBeVisible({ timeout: 30000 });

    const terminalTab = page.getByRole('button', { name: /terminal/i });
    await terminalTab.click();

    const terminalScreen = page.locator('[data-testid="terminal-screen"]');
    await expect(terminalScreen).toBeVisible({ timeout: 15000 });

    await page.waitForTimeout(2000);

    await terminalScreen.click();
    await page.keyboard.type('echo test', { delay: 50 });
    await page.keyboard.press('Enter');

    await page.waitForTimeout(1000);
  });

  test('can navigate directly to terminal via tab param', async ({
    agent,
    workspaceName,
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=terminal`);

    const terminalScreen = page.locator('[data-testid="terminal-screen"]');
    await expect(terminalScreen).toBeVisible({ timeout: 15000 });

    const sessionsTab = page.getByRole('button', { name: /sessions/i });
    await sessionsTab.click();

    await expect(page.getByRole('button', { name: /new session/i })).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe('Web UI - Sessions', () => {
  test('workspace shows stopped state message when not running', async ({ agent, page }) => {
    const name = generateTestWorkspaceName();
    await agent.api.createWorkspace({ name });
    await agent.api.stopWorkspace(name);

    try {
      await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${name}`);
      await expect(page.getByText('Workspace is stopped')).toBeVisible({ timeout: 30000 });
    } finally {
      await agent.api.deleteWorkspace(name);
    }
  });

  test('sessions tab loads for running workspace', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);
    await expect(page.getByRole('button', { name: /new session/i })).toBeVisible({
      timeout: 30000,
    });
  });

  test('sessions tab has agent filter dropdown', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);
    await expect(page.getByRole('button', { name: /all agents/i })).toBeVisible({
      timeout: 30000,
    });
  });

  test('sessions tab has new chat dropdown', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);
    await expect(page.getByRole('button', { name: /new session/i })).toBeVisible({
      timeout: 30000,
    });
  });

  test('sessions list shows prompt and clicking opens terminal', async ({
    agent,
    workspaceName,
    page,
  }) => {
    const sessionId = `test-session-${Date.now()}`;
    const filePath = `/home/workspace/.claude/projects/-workspace/${sessionId}.jsonl`;
    const sessionContent = [
      '{"type":"user","content":"Hello from test","timestamp":"2026-01-01T00:00:00.000Z"}',
      '{"type":"assistant","content":"Hi there","timestamp":"2026-01-01T00:00:01.000Z"}',
    ].join('\n');

    await agent.exec(
      workspaceName,
      `mkdir -p /home/workspace/.claude/projects/-workspace && cat <<'EOF' > "${filePath}"\n${sessionContent}\nEOF`
    );

    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);
    const sessionItem = page
      .getByTestId('session-list-item')
      .filter({ hasText: 'Hello from test' })
      .first();
    await expect(sessionItem).toBeVisible({ timeout: 30000 });

    await sessionItem.click();

    await expect(page.getByText('Agent Terminal')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="terminal-screen"]')).toBeVisible();
  });

  test('clicking session opens terminal with resume command', async ({
    agent,
    workspaceName,
    page,
  }) => {
    const sessionId = `history-test-${Date.now()}`;
    const filePath = `/home/workspace/.claude/projects/-workspace/${sessionId}.jsonl`;
    const sessionContent = [
      '{"type":"user","message":{"content":"What is 2+2?"},"timestamp":"2026-01-01T00:00:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"2+2 equals 4"}]},"timestamp":"2026-01-01T00:00:01.000Z"}',
    ].join('\n');

    await agent.exec(
      workspaceName,
      `mkdir -p /home/workspace/.claude/projects/-workspace && cat <<'EOF' > "${filePath}"\n${sessionContent}\nEOF`
    );

    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);
    const sessionItem = page
      .getByTestId('session-list-item')
      .filter({ hasText: 'What is 2+2?' })
      .first();
    await expect(sessionItem).toBeVisible({ timeout: 30000 });

    await sessionItem.click();

    await expect(page.getByText('Agent Terminal')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="terminal-screen"]')).toBeVisible();
  });

  test('clicking new session opens terminal', async ({ agent, workspaceName, page }) => {
    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);

    await page.getByRole('button', { name: /new session/i }).click();
    await page.getByText('Claude Code').first().click();

    await expect(page.getByText('Agent Terminal')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="terminal-screen"]')).toBeVisible();
  });

  test('resuming session from project folder opens terminal', async ({
    agent,
    workspaceName,
    page,
  }) => {
    const sessionId = `project-path-test-${Date.now()}`;
    const projectDir = '-home-workspace-myproject';
    const filePath = `/home/workspace/.claude/projects/${projectDir}/${sessionId}.jsonl`;
    const sessionContent = [
      '{"type":"user","message":{"content":"Test message"},"timestamp":"2026-01-01T00:00:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Test response"}]},"timestamp":"2026-01-01T00:00:01.000Z"}',
    ].join('\n');

    await agent.exec(
      workspaceName,
      `mkdir -p /home/workspace/.claude/projects/${projectDir} && cat <<'EOF' > "${filePath}"\n${sessionContent}\nEOF`
    );

    await page.goto(`http://127.0.0.1:${agent.port}/workspaces/${workspaceName}?tab=sessions`);

    const sessionItem = page
      .getByTestId('session-list-item')
      .filter({ hasText: 'Test message' })
      .first();
    await expect(sessionItem).toBeVisible({ timeout: 30000 });

    await sessionItem.click();

    await expect(page.getByText('Agent Terminal')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="terminal-screen"]')).toBeVisible();
  });
});
