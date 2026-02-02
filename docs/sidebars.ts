import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';
import apiSidebar from './docs/api/sidebar';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'introduction',
    'quickstart',
    {
      type: 'category',
      label: 'Core Tasks',
      items: ['workspaces', 'connect', 'agents', 'skills', 'networking', 'sync-update'],
    },
    {
      type: 'category',
      label: 'Agent Workflows',
      items: ['workflows/opencode', 'workflows/claude-code', 'workflows/pi'],
    },
    {
      type: 'category',
      label: 'Configuration',
      items: [
        'configuration/overview',
        'configuration/credentials',
        'configuration/agents',
        'configuration/scripts',
        'configuration/tailscale',
        'configuration/github',
        'configuration/authentication',
      ],
    },
    {
      type: 'category',
      label: 'CLI Reference',
      link: {
        type: 'doc',
        id: 'cli',
      },
      items: [],
    },
    'web-ui',
    'mobile',
    'troubleshooting',
    {
      type: 'category',
      label: 'API Reference',
      link: {
        type: 'generated-index',
        title: 'Perry API Reference',
        description: 'Auto-generated reference for internal Perry APIs. These APIs are used by the CLI and Web UI and are not intended for direct use.',
        slug: '/api',
      },
      items: apiSidebar,
    },
  ],
};

export default sidebars;
