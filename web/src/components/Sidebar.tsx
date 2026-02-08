import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Menu,
  X,
  KeyRound,
  FolderSync,
  Terminal,
  SquareTerminal,
  Settings,
  Monitor,
  Boxes,
  Wand2,
  Plug,
  Github,
  Network,
  ChevronDown,
  Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, type WorkspaceInfo } from '@/lib/api';
import { HOST_WORKSPACE_NAME } from '@shared/client-types';
import { Button } from '@/components/ui/button';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';

interface SidebarProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function Sidebar({ isOpen, onToggle }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(240);

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: api.listWorkspaces,
  });

  const { data: hostInfo } = useQuery({
    queryKey: ['hostInfo'],
    queryFn: api.getHostInfo,
  });

  // Sync workspace count to state on every render
  useEffect(() => {
    setWorkspaceCount(workspaces?.length || 0);
  }, [workspaces]);

  // Track sidebar width via DOM measurement
  useEffect(() => {
    const el = document.querySelector('.sidebar-container');
    if (el) {
      setSidebarWidth(el.clientWidth);
    }
  }, [isOpen]);

  // Log every render for debugging
  useEffect(() => {
    console.log('Sidebar rendered', { workspaceCount, sidebarWidth, isOpen });
  }, [workspaceCount, sidebarWidth, isOpen]);

  const workspaceLinks = [
    { to: '/settings/environment', label: 'Environment', icon: KeyRound },
    { to: '/settings/files', label: 'Files', icon: FolderSync },
    { to: '/settings/ssh', label: 'SSH Keys', icon: KeyRound },
    { to: '/settings/scripts', label: 'Scripts', icon: Terminal },
    { to: '/settings/terminal', label: 'Terminal', icon: SquareTerminal },
    { to: '/settings/security', label: 'Security', icon: Shield },
  ];

  const integrationLinks = [
    { to: '/settings/agents', label: 'AI Agents', icon: Settings },
    { to: '/settings/github', label: 'GitHub', icon: Github },
    { to: '/settings/tailscale', label: 'Tailscale', icon: Network },
    { to: '/skills', label: 'Skills', icon: Wand2 },
    { to: '/mcp', label: 'MCP', icon: Plug },
  ];

  const isWorkspaceActive = workspaceLinks.some((link) => location.pathname === link.to);
  const isIntegrationActive = integrationLinks.some((link) => location.pathname === link.to);
  const [workspaceOpen, setWorkspaceOpen] = useState(isWorkspaceActive);
  const [integrationOpen, setIntegrationOpen] = useState(isIntegrationActive);

  const handleNavigate = (path: string) => {
    navigate(path);
    if (isOpen) onToggle();
  };

  useEffect(() => {
    if (isWorkspaceActive) {
      setWorkspaceOpen(true);
    }
  }, [isWorkspaceActive]);

  useEffect(() => {
    if (isIntegrationActive) {
      setIntegrationOpen(true);
    }
  }, [isIntegrationActive]);

  useEffect(() => {
    const handleResize = () => {
      const el = document.querySelector('.sidebar-container');
      if (el) setSidebarWidth(el.clientWidth);
    };
    window.addEventListener('resize', handleResize);
  }, []);

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden transition-opacity duration-200',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        onClick={onToggle}
      />

      <aside
        className={cn(
          'fixed left-0 top-0 z-50 flex h-screen w-60 flex-col bg-card border-r transition-transform duration-200 ease-out lg:translate-x-0 lg:static lg:z-0',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4 flex-shrink-0">
          <Link to="/" className="flex items-center gap-2.5">
            <img src="/logo.png" alt="Perry Logo" className="h-7 w-7 object-contain" />
            <span className="font-semibold text-sm tracking-tight">Perry</span>
          </Link>
          <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8" onClick={onToggle}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Workspaces Section - Scrollable */}
          <nav className="flex-1 overflow-y-auto p-3">
            <div className="section-header">Workspaces</div>
            <div className="space-y-0.5">
              <Link
                to="/workspaces"
                className={cn(
                  'flex items-center gap-2.5 rounded px-2 py-2 text-sm transition-colors hover:bg-accent min-h-[44px]',
                  location.pathname === '/workspaces' && 'nav-active'
                )}
                onClick={() => isOpen && onToggle()}
              >
                <Boxes className="h-4 w-4 text-muted-foreground" />
                <span>All Workspaces</span>
              </Link>
              {workspaces?.map((ws: WorkspaceInfo, index: number) => {
                const wsPath = `/workspaces/${ws.name}`;
                const isActive =
                  location.pathname === wsPath || location.pathname.startsWith(`${wsPath}/`);
                return (
                  <button
                    key={index}
                    className={cn(
                      'w-full flex items-center gap-2.5 rounded px-2 py-2 text-sm transition-colors hover:bg-accent group min-h-[44px]',
                      isActive && 'nav-active'
                    )}
                    style={{ padding: isActive ? '8px 12px' : '8px 8px' }}
                    onClick={() => handleNavigate(wsPath)}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full flex-shrink-0',
                        ws.status === 'running'
                          ? 'status-online status-online-pulse'
                          : 'bg-muted-foreground/40'
                      )}
                    />
                    <span className="truncate text-muted-foreground group-hover:text-foreground transition-colors text-left">
                      {ws.name}
                    </span>
                  </button>
                );
              })}
              {hostInfo?.enabled && (
                <button
                  className={cn(
                    'w-full flex items-center gap-2.5 rounded px-2 py-2 text-sm transition-colors hover:bg-accent group min-h-[44px]',
                    location.pathname.includes(encodeURIComponent(HOST_WORKSPACE_NAME)) &&
                      'nav-active'
                  )}
                  onClick={() => {
                    navigate(`/workspaces/${encodeURIComponent(HOST_WORKSPACE_NAME)}`);
                    if (isOpen) onToggle();
                  }}
                >
                  <Monitor className="h-4 w-4 text-amber-500 flex-shrink-0" />
                  <span className="truncate text-muted-foreground group-hover:text-foreground transition-colors text-left">
                    {hostInfo.hostname}
                  </span>
                </button>
              )}
            </div>
          </nav>

          {/* Settings Sections */}
          <div className="flex-shrink-0 border-t px-3 py-2 space-y-3">
            <div>
              <button
                type="button"
                onClick={() => setWorkspaceOpen((prev) => !prev)}
                className="w-full flex items-center justify-between section-header hover:text-foreground transition-colors"
              >
                <span>Workspace</span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform',
                    workspaceOpen && 'rotate-180'
                  )}
                />
              </button>
              {workspaceOpen && (
                <div className="space-y-0">
                  {workspaceLinks.map((link) => (
                    <Link
                      key={link.to}
                      to={link.to}
                      className={cn(
                        'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent',
                        location.pathname === link.to && 'nav-active'
                      )}
                      onClick={() => isOpen && onToggle()}
                    >
                      <link.icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{link.label}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setIntegrationOpen((prev) => !prev)}
                className="w-full flex items-center justify-between section-header hover:text-foreground transition-colors"
              >
                <span>Integrations</span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform',
                    integrationOpen && 'rotate-180'
                  )}
                />
              </button>
              {integrationOpen && (
                <div className="space-y-0">
                  {integrationLinks.map((link) => (
                    <Link
                      key={link.to}
                      to={link.to}
                      className={cn(
                        'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-accent',
                        location.pathname === link.to && 'nav-active'
                      )}
                      onClick={() => isOpen && onToggle()}
                    >
                      <link.icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{link.label}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

        <div className="border-t px-3 py-2 flex-shrink-0 space-y-1">
          <div className="section-header">Appearance</div>
          <ThemeSwitcher />
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider pt-1">
            Perry v0.1.0
          </div>
        </div>
      </aside>
    </>
  );
}

export function SidebarTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" className="lg:hidden h-9 w-9" onClick={onClick}>
      <Menu className="h-5 w-5" />
    </Button>
  );
}
