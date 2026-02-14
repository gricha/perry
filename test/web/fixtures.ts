import { test as base } from '@playwright/test';
import { startTestAgent, type TestAgent } from '../helpers/agent';

type TestFixtures = {
  agent: TestAgent;
  workspaceName: string;
};

export const test = base.extend<TestFixtures>({
  agent: [
    async ({}, use) => {
      const agent = await startTestAgent();
      await use(agent);
      await agent.cleanup();
    },
    { scope: 'worker' },
  ],
  workspaceName: [
    async ({ agent }, use) => {
      const name = agent.generateWorkspaceName();
      await agent.api.createWorkspace({ name });
      await use(name);
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
