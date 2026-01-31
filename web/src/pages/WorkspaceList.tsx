import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, RefreshCw, Boxes, ChevronRight, Sparkles, Monitor, AlertTriangle, Shield, Network } from 'lucide-react'
import { api, type WorkspaceInfo, type CreateWorkspaceRequest, type HostInfo } from '@/lib/api'
import { HOST_WORKSPACE_NAME } from '@shared/client-types'
import { getUserWorkspaceNameError } from '@shared/workspace-name'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RepoSelector } from '@/components/RepoSelector'
import { cn } from '@/lib/utils'

function StatCard({ value, label, accent }: { value: number | string; label: string; accent?: boolean }) {
  return (
    <div className={cn(
      "flex flex-col items-center justify-center p-4 rounded-lg border bg-card/50",
      accent && "border-primary/30 bg-primary/5"
    )}>
      <span className={cn(
        "text-2xl font-bold tabular-nums",
        accent && "text-primary"
      )}>{value}</span>
      <span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span>
    </div>
  )
}

function WorkspaceRow({ workspace, onClick }: { workspace: WorkspaceInfo; onClick: () => void }) {
  const isRunning = workspace.status === 'running'
  const isError = workspace.status === 'error'
  const isCreating = workspace.status === 'creating'

  return (
    <button
      onClick={onClick}
      data-testid="workspace-row"
      className="w-full flex items-center gap-4 px-4 py-4 border-b border-border/50 hover:bg-accent/50 transition-colors text-left group"
    >
      <div className="relative">
        <span className={cn(
          "block h-2.5 w-2.5 rounded-full",
          isRunning && "bg-emerald-500",
          isError && "bg-destructive",
          isCreating && "bg-amber-500",
          !isRunning && !isError && !isCreating && "bg-muted-foreground/40"
        )} />
        {isRunning && (
          <span className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-emerald-500 animate-ping opacity-75" />
        )}
        {isCreating && (
          <span className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-amber-500 animate-ping opacity-75" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{workspace.name}</span>
          {isRunning && (
            <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-medium">
              Running
            </span>
          )}
          {isCreating && (
            <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400 font-medium">
              Starting
            </span>
          )}
          {isError && (
            <span className="text-[10px] uppercase tracking-wider text-destructive font-medium">
              Error
            </span>
          )}
        </div>
        {workspace.repo && (
          <p className="text-sm text-muted-foreground truncate mt-0.5">{workspace.repo}</p>
        )}
        {workspace.tailscale?.status === 'connected' && workspace.tailscale.hostname && (
          <div className="flex items-center gap-1.5 mt-1">
            <Network className="h-3 w-3 text-blue-500" />
            <span className="text-xs text-muted-foreground font-mono">{workspace.tailscale.hostname}</span>
          </div>
        )}
        {workspace.tailscale?.status === 'failed' && (
          <div className="flex items-center gap-1.5 mt-1">
            <Network className="h-3 w-3 text-amber-500" />
            <span className="text-xs text-amber-600 dark:text-amber-400">Tailscale failed</span>
          </div>
        )}
      </div>

      <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
    </button>
  )
}

function HostSection({ hostInfo, onNavigate }: {
  hostInfo: HostInfo
  onNavigate: () => void
}) {
  if (!hostInfo.enabled) {
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Host Machine
        </h2>
        <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
          <div className="px-4 py-4">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                <Shield className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground">Host Access Disabled</div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Run with <code className="px-1.5 py-0.5 rounded bg-muted text-foreground text-xs">--host-access</code> to enable direct access to {hostInfo.hostname}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Host Machine
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          Direct access enabled
        </span>
      </div>

      <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 overflow-hidden">
        <button
          onClick={onNavigate}
          className="w-full flex items-center gap-4 px-4 py-4 hover:bg-accent/50 transition-colors text-left group"
        >
          <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <Monitor className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{hostInfo.hostname}</span>
              <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400 font-medium">
                Active
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {hostInfo.username}@{hostInfo.hostname} &middot; {hostInfo.homeDir}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
        </button>
        <div className="px-4 py-3 border-t border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Commands run directly on your machine without isolation</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function WorkspaceList() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRepo, setNewRepo] = useState('')

  const trimmedNewName = newName.trim()
  const newNameError = trimmedNewName ? getUserWorkspaceNameError(trimmedNewName) : null
  const canCreate = trimmedNewName.length > 0 && !newNameError

  const { data: workspaces, isLoading, error, refetch } = useQuery({
    queryKey: ['workspaces'],
    queryFn: api.listWorkspaces,
  })

  const { data: hostInfo } = useQuery({
    queryKey: ['hostInfo'],
    queryFn: api.getHostInfo,
    enabled: !!workspaces,
  })

  const createMutation = useMutation({
    mutationFn: (data: CreateWorkspaceRequest) => api.createWorkspace(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      setShowCreate(false)
      setNewName('')
      setNewRepo('')
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canCreate) return

    createMutation.mutate({
      name: trimmedNewName,
      clone: newRepo.trim() || undefined,
    })
  }

  const handleRowClick = (ws: WorkspaceInfo) => {
    navigate(`/workspaces/${ws.name}/sessions`)
  }

  const totalCount = workspaces?.length || 0
  const runningCount = workspaces?.filter(ws => ws.status === 'running').length || 0

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <p className="text-destructive mb-4">Failed to load workspaces</p>
        <Button onClick={() => refetch()} variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Manage your development workspaces
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => refetch()} variant="ghost" size="icon" className="text-muted-foreground">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Workspace
          </Button>
        </div>
      </div>

      {/* Stats */}
      {!isLoading && totalCount > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard value={totalCount} label="Workspaces" />
          <StatCard value={runningCount} label="Running" accent={runningCount > 0} />
          <StatCard value={totalCount - runningCount} label="Stopped" />
          <StatCard value="—" label="Sessions" />
        </div>
      )}

      {/* Host Section */}
      {hostInfo && (
        <HostSection
          hostInfo={hostInfo}
          onNavigate={() => navigate(`/workspaces/${encodeURIComponent(HOST_WORKSPACE_NAME)}`)}
        />
      )}

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Create Workspace</CardTitle>
            <CardDescription>Set up a new isolated development environment</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="my-project"
                  autoFocus
                />
                {newNameError && <p className="text-sm text-destructive">{newNameError}</p>}
              </div>
              <RepoSelector
                value={newRepo}
                onChange={setNewRepo}
                placeholder="https://github.com/user/repo"
              />
              <div className="flex gap-2 pt-2">
                <Button type="submit" disabled={createMutation.isPending || !canCreate}>
                  {createMutation.isPending ? 'Creating...' : 'Create Workspace'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </Button>
              </div>
              {createMutation.error && (
                <p className="text-sm text-destructive">
                  {(createMutation.error as Error).message}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {/* Workspace list */}
      {isLoading ? (
        <div className="rounded-lg border bg-card/50">
          <div className="animate-pulse">
            <div className="h-16 border-b border-border/50 bg-muted/20" />
            <div className="h-16 border-b border-border/50 bg-muted/10" />
            <div className="h-16 bg-muted/5" />
          </div>
        </div>
      ) : totalCount === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/30">
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Boxes className="h-6 w-6 text-primary" />
            </div>
            <h3 className="text-lg font-medium mb-1">No workspaces yet</h3>
            <p className="text-muted-foreground text-center max-w-sm mb-6">
              Create your first workspace to get started with an isolated development environment.
            </p>
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create your first workspace
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Workspaces
            </h2>
          </div>
          <div className="rounded-lg border bg-card/50 overflow-hidden">
            {workspaces?.map((ws: WorkspaceInfo) => (
              <WorkspaceRow
                key={ws.name}
                workspace={ws}
                onClick={() => handleRowClick(ws)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Quick tips */}
      {!isLoading && totalCount > 0 && (
        <div className="rounded-lg border border-border/50 bg-muted/20 p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
            <div className="text-sm">
              <span className="font-medium">Quick tip:</span>{' '}
              <span className="text-muted-foreground">
                Use <code className="px-1.5 py-0.5 rounded bg-muted text-foreground text-xs">perry shell {'<name>'}</code> from your terminal to SSH directly into any workspace.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
