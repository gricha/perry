import { useState, useCallback, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Play,
  Square,
  Trash2,
  Terminal as TerminalIcon,
  RefreshCw,
  MessageSquare,
  Settings,
  ArrowLeft,
  Clock,
  Hash,
  ChevronRight,
  Bot,
  Loader2,
  Copy,
  CopyPlus,
  Check,
  Info,
  AlertTriangle,
  FolderSync,
  Search,
  Circle,
  X,
} from 'lucide-react'
import { api, type SessionInfo, type AgentType, type PortMapping } from '@/lib/api'
import { HOST_WORKSPACE_NAME } from '@shared/client-types'
import { getUserWorkspaceNameError } from '@shared/workspace-name'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Terminal } from '@/components/Terminal'
import { cn } from '@/lib/utils'
import { AgentIcon } from '@/components/AgentIcon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type TabType = 'sessions' | 'terminal' | 'settings'

const AGENT_LABELS: Record<AgentType | 'all', string> = {

  all: 'All Agents',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  pi: 'Pi',
}

type DateGroup = 'Today' | 'Yesterday' | 'This Week' | 'Older'

function getAgentResumeCommand(agentType: AgentType, sessionId: string): string {
  switch (agentType) {
    case 'claude-code':
      return `claude --resume ${sessionId}`
    case 'opencode':
      return `opencode --session ${sessionId}`
    case 'codex':
      return `codex resume ${sessionId}`
    case 'pi':
      return `pi --session ${sessionId}`
  }
}

function getAgentNewCommand(agentType: AgentType): string {
  switch (agentType) {
    case 'claude-code':
      return 'claude'
    case 'opencode':
      return 'opencode'
    case 'codex':
      return 'codex'
    case 'pi':
      return 'pi'
  }
}

function getDateGroup(dateString: string): DateGroup {
  const date = new Date(dateString)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  const sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (sessionDate.getTime() >= today.getTime()) return 'Today'
  if (sessionDate.getTime() >= yesterday.getTime()) return 'Yesterday'
  if (sessionDate.getTime() >= weekAgo.getTime()) return 'This Week'
  return 'Older'
}

function groupSessionsByDate(sessions: SessionInfo[]): Record<DateGroup, SessionInfo[]> {
  const groups: Record<DateGroup, SessionInfo[]> = {
    Today: [],
    Yesterday: [],
    'This Week': [],
    Older: [],
  }
  for (const session of sessions) {
    groups[getDateGroup(session.lastActivity)].push(session)
  }
  return groups
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function CopyableSessionId({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await navigator.clipboard.writeText(sessionId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors group"
      title={`Click to copy: ${sessionId}`}
      data-testid="session-id"
    >
      <span>{sessionId.slice(0, 8)}</span>
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  )
}

function parsePortMapping(spec: string): PortMapping | null {
  const trimmed = spec.trim()
  if (trimmed.includes(':')) {
    const [hostStr, containerStr] = trimmed.split(':')
    const host = parseInt(hostStr, 10)
    const container = parseInt(containerStr, 10)
    if (isNaN(host) || isNaN(container) || host < 1 || host > 65535 || container < 1 || container > 65535) {
      return null
    }
    return { host, container }
  }
  const port = parseInt(trimmed, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    return null
  }
  return { host: port, container: port }
}

function PortForwardsCard({ workspaceName, currentPorts }: { workspaceName: string; currentPorts: PortMapping[] }) {
  const [ports, setPorts] = useState<PortMapping[]>(currentPorts)
  const [newPort, setNewPort] = useState('')
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  useEffect(() => {
    setPorts(currentPorts)
  }, [currentPorts])

  const mutation = useMutation({
    mutationFn: (newPorts: PortMapping[]) => api.setPortForwards(workspaceName, newPorts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', workspaceName] })
      setError(null)
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const handleAddPort = () => {
    const mapping = parsePortMapping(newPort)
    if (!mapping) {
      setError('Invalid format. Use port (e.g. 3000) or host:container (e.g. 8080:3000)')
      return
    }
    if (ports.some(p => p.host === mapping.host)) {
      setError(`Host port ${mapping.host} already configured`)
      return
    }
    const updated = [...ports, mapping].sort((a, b) => a.host - b.host)
    setPorts(updated)
    setNewPort('')
    setError(null)
    mutation.mutate(updated)
  }

  const handleRemovePort = (mapping: PortMapping) => {
    const updated = ports.filter(p => p.host !== mapping.host || p.container !== mapping.container)
    setPorts(updated)
    mutation.mutate(updated)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddPort()
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          Port Mapping
        </CardTitle>
        <CardDescription>
          Map container ports to host ports for <code className="text-xs bg-muted px-1 py-0.5 rounded">perry proxy {workspaceName}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="3000 or 8080:3000 (host:container)"
            value={newPort}
            onChange={(e) => setNewPort(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1"
          />
          <Button onClick={handleAddPort} disabled={mutation.isPending || !newPort}>
            Add
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {ports.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {ports.map((mapping) => (
              <Badge key={`${mapping.host}:${mapping.container}`} variant="secondary" className="text-sm py-1 px-3 gap-2">
                {mapping.host === mapping.container ? (
                  <span>{mapping.container}</span>
                ) : (
                  <span>{mapping.host} <span className="text-muted-foreground">→</span> {mapping.container}</span>
                )}
                <button
                  onClick={() => handleRemovePort(mapping)}
                  className="hover:text-destructive transition-colors"
                  title="Remove port mapping"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No ports configured. Add ports above to use with <code className="text-xs bg-muted px-1 py-0.5 rounded">perry proxy</code>.</p>
        )}
        {mutation.isPending && (
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function SessionListItem({
  session,
  onClick,
  onDelete,
}: {
  session: SessionInfo
  onClick: () => void
  onDelete: () => void
}) {
  const isEmpty = session.messageCount === 0
  const hasPrompt = session.firstPrompt && session.firstPrompt.trim().length > 0
  const displayTitle = session.name || (hasPrompt ? session.firstPrompt : 'No prompt recorded')

  return (
    <div
      data-testid="session-list-item"
      className={cn(
        'w-full text-left px-3 sm:px-4 py-3 border-b border-border/50 transition-colors hover:bg-accent/50 flex items-center gap-2 sm:gap-4 min-h-[56px]',
        isEmpty && 'opacity-60'
      )}
    >
      <button onClick={onClick} className="flex-1 flex items-center gap-2 sm:gap-4 min-w-0">
        <AgentIcon
          agentType={session.agentType}
          data-testid="agent-badge"
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p
              className={cn(
                'text-sm font-medium truncate',
                hasPrompt || session.name ? 'text-foreground' : 'text-muted-foreground italic'
              )}
            >
              {displayTitle}
            </p>
            {isEmpty && (
              <Badge variant="secondary" className="text-[10px] font-normal bg-muted text-muted-foreground shrink-0 hidden sm:inline-flex">
                Empty
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3 mt-1 text-xs text-muted-foreground">
            <CopyableSessionId sessionId={session.id} />
            <span className="flex items-center gap-1">
              <Hash className="h-3 w-3" />
              {session.messageCount}
            </span>
            <span className="truncate font-mono text-[11px] hidden sm:inline">{session.projectPath}</span>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-1.5 sm:gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3 hidden sm:block" />
          <span className="text-[11px] sm:text-xs">{formatTimeAgo(session.lastActivity)}</span>
        </div>
      </button>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="shrink-0 p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
        title="Delete session"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </div>
  )
}

type TerminalMode = { type: 'terminal'; command: string; runId?: string }

export function WorkspaceDetail() {
  const { name: rawName } = useParams<{ name: string }>()
  const name = rawName ? decodeURIComponent(rawName) : undefined
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const isHostWorkspace = name === HOST_WORKSPACE_NAME
  const currentTab = (searchParams.get('tab') as TabType) || 'sessions'
  const sessionParam = searchParams.get('session')
  const agentParam = searchParams.get('agent') as AgentType | null
  const runIdParam = searchParams.get('runId')

  const terminalMode: TerminalMode | null = useMemo(() => {
    if (!sessionParam && !agentParam) return null
    if (agentParam && sessionParam) {
      return { type: 'terminal', command: getAgentResumeCommand(agentParam as AgentType, sessionParam) }
    }
    if (agentParam) {
      return { type: 'terminal', command: getAgentNewCommand(agentParam as AgentType), runId: runIdParam ?? undefined }
    }
    return null
  }, [sessionParam, agentParam, runIdParam])

  const setTerminalMode = useCallback((mode: TerminalMode | null) => {
    if (!mode) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('session')
        next.delete('agent')
        next.delete('runId')
        return next
      })
      return
    }

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      const claudeMatch = mode.command.match(/^claude\s+--resume\s+(\S+)/)
      const opencodeMatch = mode.command.match(/^opencode\s+--session\s+(\S+)/)
      const codexMatch = mode.command.match(/^codex\s+resume\s+(\S+)/)
      if (claudeMatch) {
        next.set('agent', 'claude-code')
        next.set('session', claudeMatch[1])
        next.delete('runId')
      } else if (opencodeMatch) {
        next.set('agent', 'opencode')
        next.set('session', opencodeMatch[1])
        next.delete('runId')
      } else if (codexMatch) {
        next.set('agent', 'codex')
        next.set('session', codexMatch[1])
        next.delete('runId')
      } else {
        const agentMap: Record<string, AgentType> = { claude: 'claude-code', opencode: 'opencode', codex: 'codex' }
        const agent = agentMap[mode.command] || mode.command
        next.set('agent', agent)
        next.delete('session')
        if (mode.runId) {
          next.set('runId', mode.runId)
        }
      }
      return next
    })
  }, [setSearchParams])

  const [agentFilter, setAgentFilter] = useState<AgentType | 'all'>('all')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [deleteSessionDialog, setDeleteSessionDialog] = useState<SessionInfo | null>(null)
  const [showCloneDialog, setShowCloneDialog] = useState(false)
  const [cloneName, setCloneName] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const trimmedCloneName = cloneName.trim()
  const cloneNameError = trimmedCloneName ? getUserWorkspaceNameError(trimmedCloneName) : null
  const canClone = trimmedCloneName.length > 0 && !cloneNameError
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const setTab = (tab: TabType) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', tab)
      return next
    })
  }

  const { data: hostInfo, isLoading: hostLoading } = useQuery({
    queryKey: ['hostInfo'],
    queryFn: api.getHostInfo,
    enabled: isHostWorkspace,
  })

  const { data: workspace, isLoading: workspaceLoading, error, refetch } = useQuery({
    queryKey: ['workspace', name],
    queryFn: () => api.getWorkspace(name!),
    enabled: !!name && !isHostWorkspace,
    refetchInterval: (query) =>
      query.state.data?.status === 'creating' ? 2000 : false,
  })

  const isLoading = isHostWorkspace ? hostLoading : workspaceLoading

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ['sessions', name, agentFilter],
    queryFn: () => api.listSessions(name!, agentFilter === 'all' ? undefined : agentFilter, 50, 0),
    enabled: !!name && ((isHostWorkspace && hostInfo?.enabled) || (!isHostWorkspace && workspace?.status === 'running')),
  })

  const sessions = sessionsData?.sessions
  const totalSessions = sessionsData?.total || 0

  const { data: searchData, isLoading: searchLoading } = useQuery({
    queryKey: ['sessionSearch', name, debouncedQuery],
    queryFn: () => api.searchSessions(name!, debouncedQuery),
    enabled: !!name && !!debouncedQuery.trim() && ((isHostWorkspace && hostInfo?.enabled) || (!isHostWorkspace && workspace?.status === 'running')),
  })

  const filteredSessions = useMemo(() => {
    const sessionList = sessions || []
    if (!debouncedQuery.trim()) return sessionList
    if (!searchData?.results) return []
    const matchingIds = new Set(searchData.results.map((r) => r.sessionId))
    return sessionList.filter((session) => matchingIds.has(session.id))
  }, [sessions, debouncedQuery, searchData])


  const startMutation = useMutation({
    mutationFn: () => api.startWorkspace(name!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', name] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
    },
  })

  const stopMutation = useMutation({
    mutationFn: () => api.stopWorkspace(name!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', name] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      setTerminalMode(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteWorkspace(name!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      navigate('/workspaces')
    },
  })

  const syncMutation = useMutation({
    mutationFn: () => api.syncWorkspace(name!),
  })

  const cloneMutation = useMutation({
    mutationFn: (cloneName: string) => api.cloneWorkspace(name!, cloneName),
    onSuccess: (newWorkspace) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      setShowCloneDialog(false)
      setCloneName('')
      navigate(`/workspaces/${encodeURIComponent(newWorkspace.name)}`)
    },
  })

  const deleteSessionMutation = useMutation({
    mutationFn: ({ sessionId, agentType }: { sessionId: string; agentType: AgentType }) =>
      api.deleteSession(name!, sessionId, agentType),
    onMutate: async ({ sessionId }) => {
      await queryClient.cancelQueries({ queryKey: ['sessions', name] })
      const previousData = queryClient.getQueryData(['sessions', name, agentFilter])
      queryClient.setQueryData(
        ['sessions', name, agentFilter],
        (old: { sessions: SessionInfo[]; total: number; hasMore: boolean } | undefined) => {
          if (!old) return old
          return {
            ...old,
            sessions: old.sessions.filter((s) => s.id !== sessionId),
            total: old.total - 1,
          }
        }
      )
      setDeleteSessionDialog(null)
      return { previousData }
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['sessions', name, agentFilter], context.previousData)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', name] })
      queryClient.invalidateQueries({ queryKey: ['recentSessions'] })
    },
  })

  const handleResume = (session: SessionInfo) => {
    const resumeId = session.agentSessionId || session.id
    setTerminalMode({ type: 'terminal', command: getAgentResumeCommand(session.agentType, resumeId) })
    if (name) {
      api.recordSessionAccess(name, session.id, session.agentType).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['sessions', name] })
    }
  }

  const handleNewSession = (agentType: AgentType = 'claude-code') => {
    const sessionId = `${agentType}-${Date.now()}`
    setTerminalMode({ type: 'terminal', command: getAgentNewCommand(agentType), runId: sessionId })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (isHostWorkspace) {
    if (!hostInfo?.enabled) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <AlertTriangle className="h-12 w-12 text-amber-500" />
          <p className="text-xl font-medium">Host Access Disabled</p>
          <p className="text-muted-foreground text-center max-w-md">
            Enable host access from the dashboard to use terminal and agents on your host machine.
          </p>
          <Button variant="outline" onClick={() => navigate('/workspaces')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Button>
        </div>
      )
    }
  } else if (error || !workspace) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <p className="text-destructive">{error ? (error as Error).message : 'Workspace not found'}</p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate('/workspaces')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          <Button onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const isRunning = isHostWorkspace ? (hostInfo?.enabled ?? false) : workspace?.status === 'running'
  const isError = isHostWorkspace ? false : workspace?.status === 'error'
  const isCreating = isHostWorkspace ? false : workspace?.status === 'creating'
  const displayName = isHostWorkspace ? (hostInfo?.hostname || 'Host') : workspace?.name
  const startupSteps = workspace?.startup?.steps ?? []

  const tabs = isHostWorkspace
    ? [
        { id: 'sessions' as const, label: 'Sessions', icon: MessageSquare },
        { id: 'terminal' as const, label: 'Terminal', icon: TerminalIcon },
      ]
    : [
        { id: 'sessions' as const, label: 'Sessions', icon: MessageSquare },
        { id: 'terminal' as const, label: 'Terminal', icon: TerminalIcon },
        { id: 'settings' as const, label: 'Settings', icon: Settings },
      ]

  const renderStartPrompt = () => {
    if (isCreating) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="h-16 w-16 rounded-full flex items-center justify-center mb-6 bg-amber-500/10">
            <Loader2 className="h-8 w-8 text-amber-500 animate-spin" />
          </div>
          <p className="text-xl font-medium mb-2">Workspace is starting</p>
          <p className="text-muted-foreground mb-6 text-center max-w-md">
            Please wait while the workspace container starts up. This may take a moment if the Docker image is being downloaded.
          </p>
          {startupSteps.length > 0 && (
            <div className="w-full max-w-md space-y-2">
              {startupSteps.map((step) => {
                const icon =
                  step.status === 'done' ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : step.status === 'running' ? (
                    <Loader2 className="h-4 w-4 text-amber-500 animate-spin" />
                  ) : step.status === 'error' ? (
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  ) : step.status === 'skipped' ? (
                    <Check className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )
                return (
                  <div
                    key={step.id}
                    className="flex items-center gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-2"
                  >
                    {icon}
                    <div className="flex-1 text-sm">
                      <div className="font-medium text-foreground">{step.label}</div>
                      {step.message && (
                        <div className="text-xs text-muted-foreground">{step.message}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className={cn(
          "h-16 w-16 rounded-full flex items-center justify-center mb-6",
          isError ? "bg-destructive/10" : "bg-muted/50"
        )}>
          {isError ? (
            <AlertTriangle className="h-8 w-8 text-destructive" />
          ) : (
            <Square className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
        <p className="text-xl font-medium mb-2">
          {isError ? 'Workspace needs recovery' : 'Workspace is stopped'}
        </p>
        <p className="text-muted-foreground mb-6 text-center max-w-md">
          {isError
            ? 'The container was deleted externally. Click below to recreate it with existing data.'
            : 'Start the workspace to access this feature'}
        </p>
        {startMutation.error && (
          <div className="mb-4 px-4 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm max-w-md text-center">
            {(startMutation.error as Error).message || 'Failed to start workspace'}
          </div>
        )}
        <Button
          size="lg"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
        >
          {startMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              {isError ? 'Recovering...' : 'Starting...'}
            </>
          ) : (
            <>
              {isError ? <RefreshCw className="mr-2 h-5 w-5" /> : <Play className="mr-2 h-5 w-5" />}
              {isError ? 'Recover Workspace' : 'Start Workspace'}
            </>
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-border/50 bg-card/50 min-h-[48px]">
        <Button variant="ghost" size="sm" className="h-9 w-9 p-0 flex-shrink-0" onClick={() => navigate('/workspaces')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold truncate">{displayName}</span>
          {isHostWorkspace ? (
            <Badge variant="secondary" className="text-xs flex-shrink-0 bg-amber-500/10 text-amber-600 border-amber-500/20">
              host
            </Badge>
          ) : isRunning ? (
            <span className="h-2 w-2 rounded-full bg-success animate-pulse flex-shrink-0" title="Running" />
          ) : isCreating ? (
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" title="Starting" />
          ) : isError ? (
            <Badge variant="destructive" className="text-xs flex-shrink-0">error</Badge>
          ) : (
            <Badge variant="muted" className="text-xs flex-shrink-0">stopped</Badge>
          )}
        </div>
        <div className="flex items-center ml-8 border-l border-border">
          {tabs.filter(tab => tab.id !== 'settings').map((tab, index) => (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={cn(
                'px-4 py-1.5 text-sm font-medium transition-colors cursor-pointer',
                currentTab === tab.id
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/30',
                index > 0 && 'border-l border-border'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {tabs.some(tab => tab.id === 'settings') && (
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => {
                setShowCloneDialog(true)
                setCloneName('')
              }}
              className="p-2 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-accent/50"
              title="Clone workspace"
            >
              <CopyPlus className="h-5 w-5" />
            </button>
            <button
              onClick={() => setTab('settings')}
              className={cn(
                'p-2 rounded-md transition-colors',
                currentTab === 'settings'
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              )}
              title="Settings"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {currentTab === 'sessions' && (
          <div className="h-full flex flex-col">
            {!isRunning ? (
              renderStartPrompt()
            ) : terminalMode ? (
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50">
                  <Button variant="ghost" size="sm" onClick={() => setTerminalMode(null)}>
                    <ArrowLeft className="h-4 w-4 mr-1" />
                    Back to Sessions
                  </Button>
                  <span className="text-sm font-medium">Agent Terminal</span>
                </div>
                <div className="flex-1">
                  <Terminal
                    key={`agent-${name}`}
                    workspaceName={name!}
                    initialCommand={terminalMode.command}
                    runId={terminalMode.runId ?? terminalMode.command}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 border-b border-border/50">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-8 px-2 sm:px-3 flex-shrink-0">
                        <Bot className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">{AGENT_LABELS[agentFilter]}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuRadioGroup
                        value={agentFilter}
                        onValueChange={(value) => setAgentFilter(value as AgentType | 'all')}
                      >
                        <DropdownMenuRadioItem value="all">All Agents</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="claude-code">Claude Code</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="opencode">OpenCode</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="codex">Codex</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search..."
                      className="pl-8 h-8 text-sm"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {totalSessions > 0 && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline">
                      {debouncedQuery
                        ? `${filteredSessions.length}/${totalSessions}`
                        : totalSessions}
                    </span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" className="h-8 px-2 sm:px-3 flex-shrink-0 ml-auto">
                        <Play className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">New Session</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleNewSession('claude-code')}>
                        <span className="w-2 h-2 rounded-full bg-orange-500 mr-2" />
                        Claude Code
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleNewSession('opencode')}>
                        <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2" />
                        OpenCode
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleNewSession('codex')}>
                        <span className="w-2 h-2 rounded-full bg-blue-500 mr-2" />
                        Codex
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {sessionsLoading || (debouncedQuery && searchLoading) ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  ) : !sessions || sessions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16">
                        <MessageSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
                        <p className="text-muted-foreground mb-4">No agent sessions yet</p>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button>
                            <Play className="mr-2 h-4 w-4" />
                              Start an agent session

                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onClick={() => handleNewSession('claude-code')}>
                            <span className="w-2 h-2 rounded-full bg-orange-500 mr-2" />
                            Claude Code
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleNewSession('opencode')}>
                            <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2" />
                            OpenCode
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleNewSession('codex')}>
                            <span className="w-2 h-2 rounded-full bg-blue-500 mr-2" />
                            Codex
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : filteredSessions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16">
                      <Search className="h-12 w-12 text-muted-foreground/50 mb-4" />
                      <p className="text-muted-foreground">No sessions match your search</p>
                    </div>
                  ) : (
                    <div data-testid="sessions-list">
                      {(['Today', 'Yesterday', 'This Week', 'Older'] as DateGroup[]).map((group) => {
                        const groupedSessions = groupSessionsByDate(filteredSessions)
                        const groupSessions = groupedSessions[group]
                        if (groupSessions.length === 0) return null
                        return (
                          <div key={group} data-testid={`date-group-${group.toLowerCase().replace(' ', '-')}`}>
                            <div className="px-4 py-2 bg-muted/30 border-b border-border/50 sticky top-0">
                              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                {group}
                              </span>
                            </div>
                            {groupSessions.map((session) => (
                              <SessionListItem
                                key={session.id}
                                session={session}
                                onClick={() => handleResume(session)}
                                onDelete={() => setDeleteSessionDialog(session)}
                              />
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {currentTab === 'terminal' && (
          <div className="h-full flex flex-col">
            {!isRunning ? (
              renderStartPrompt()
            ) : (
              <Terminal key={`terminal-${isHostWorkspace ? HOST_WORKSPACE_NAME : workspace!.name}`} workspaceName={isHostWorkspace ? HOST_WORKSPACE_NAME : workspace!.name} />
            )}
          </div>
        )}

        {currentTab === 'settings' && !isHostWorkspace && workspace && (
          <div className="h-full overflow-y-auto p-6">
            <div className="max-w-2xl space-y-6">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Info className="h-4 w-4 text-muted-foreground" />
                    Workspace Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <Badge variant={isRunning ? 'success' : isError ? 'destructive' : isCreating ? 'secondary' : 'muted'} className={isCreating ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' : ''}>
                      {isRunning ? 'running' : isError ? 'error' : isCreating ? 'starting' : 'stopped'}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-sm text-muted-foreground">Container ID</span>
                    <span className="font-mono text-sm">{workspace.containerId.slice(0, 12)}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-sm text-muted-foreground">SSH Port</span>
                    <span className="font-mono text-sm">{workspace.ports.ssh}</span>
                  </div>
                  {workspace.repo && (
                    <div className="flex justify-between items-start py-2 border-b border-border/50">
                      <span className="text-sm text-muted-foreground">Repository</span>
                      <span className="text-sm text-right break-all max-w-[60%]">{workspace.repo}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm text-muted-foreground">Created</span>
                    <span className="text-sm">{new Date(workspace.created).toLocaleString()}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FolderSync className="h-4 w-4 text-muted-foreground" />
                    Sync Credentials
                  </CardTitle>
                  <CardDescription>
                    Sync configuration files and credentials from host to workspace
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between p-4 rounded-lg border border-border/50 bg-muted/30">
                    <div>
                      <p className="font-medium text-sm">Sync Files</p>
                      <p className="text-sm text-muted-foreground">
                        Copy .gitconfig, Claude credentials, Codex auth, and configured files
                      </p>
                      {syncMutation.isSuccess && (
                        <p className="text-sm text-success mt-1 flex items-center gap-1">
                          <Check className="h-3 w-3" />
                          Synced successfully
                        </p>
                      )}
                      {syncMutation.error && (
                        <p className="text-sm text-destructive mt-1">
                          {(syncMutation.error as Error).message || 'Sync failed'}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => syncMutation.mutate()}
                      disabled={syncMutation.isPending || !isRunning}
                    >
                      {syncMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FolderSync className="mr-2 h-4 w-4" />
                      )}
                      {syncMutation.isPending ? 'Syncing...' : 'Sync Now'}
                    </Button>
                  </div>
                  {!isRunning && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Start the workspace to sync files
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CopyPlus className="h-4 w-4 text-muted-foreground" />
                    Clone Workspace
                  </CardTitle>
                  <CardDescription>
                    Create a copy of this workspace with all its data
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between p-4 rounded-lg border border-border/50 bg-muted/30">
                    <div>
                      <p className="font-medium text-sm">Clone</p>
                      <p className="text-sm text-muted-foreground">
                        Creates a new workspace with copied volumes and configuration
                      </p>
                      {cloneMutation.error && (
                        <p className="text-sm text-destructive mt-1">
                          {(cloneMutation.error as Error).message || 'Clone failed'}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowCloneDialog(true)
                        setCloneName('')
                      }}
                      disabled={cloneMutation.isPending}
                    >
                      {cloneMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <CopyPlus className="mr-2 h-4 w-4" />
                      )}
                      {cloneMutation.isPending ? 'Cloning...' : 'Clone'}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <PortForwardsCard workspaceName={name!} currentPorts={workspace.ports.forwards || []} />

              <Card className="border-destructive/30">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-4 w-4" />
                    Danger Zone
                  </CardTitle>
                  <CardDescription>Destructive actions that cannot be undone</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {isRunning ? (
                    <div className="flex items-center justify-between p-4 rounded-lg border border-border/50 bg-muted/30">
                      <div>
                        <p className="font-medium text-sm">Stop Workspace</p>
                        <p className="text-sm text-muted-foreground">Stop the running container. You can restart it later.</p>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => stopMutation.mutate()}
                        disabled={stopMutation.isPending}
                      >
                        <Square className="mr-2 h-4 w-4" />
                        {stopMutation.isPending ? 'Stopping...' : 'Stop'}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between p-4 rounded-lg border border-border/50 bg-muted/30">
                      <div>
                        <p className="font-medium text-sm">Start Workspace</p>
                        <p className="text-sm text-muted-foreground">Start the container to use terminal and sessions.</p>
                        {startMutation.error && (
                          <p className="text-sm text-destructive mt-1">
                            {(startMutation.error as Error).message || 'Failed to start'}
                          </p>
                        )}
                      </div>
                      <Button
                        onClick={() => startMutation.mutate()}
                        disabled={startMutation.isPending}
                      >
                        {startMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="mr-2 h-4 w-4" />
                        )}
                        {startMutation.isPending ? 'Starting...' : 'Start'}
                      </Button>
                    </div>
                  )}

                  <div className="flex items-center justify-between p-4 rounded-lg border border-destructive/30 bg-destructive/5">
                    <div>
                      <p className="font-medium text-sm">Delete Workspace</p>
                      <p className="text-sm text-muted-foreground">Permanently delete this workspace and all its data.</p>
                    </div>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setShowDeleteDialog(true)
                        setDeleteConfirmName('')
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>

      {workspace && (
        <AlertDialog open={showDeleteDialog} onOpenChange={(open) => !open && setShowDeleteDialog(false)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Workspace</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete the workspace
                <span className="font-mono font-semibold text-foreground"> {workspace.name}</span> and all its data.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="py-4">
              <Label htmlFor="confirm-name" className="text-sm text-muted-foreground">
                Type <span className="font-mono font-semibold text-foreground">{workspace.name}</span> to confirm
              </Label>
              <Input
                id="confirm-name"
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                placeholder="Enter workspace name"
                className="mt-2"
                autoComplete="off"
                data-testid="delete-confirm-input"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setShowDeleteDialog(false)}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (deleteConfirmName === workspace.name) {
                    deleteMutation.mutate()
                  }
                }}
                disabled={deleteConfirmName !== workspace.name || deleteMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete Workspace'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <AlertDialog
        open={!!deleteSessionDialog}
        onOpenChange={(open) => !open && setDeleteSessionDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Session</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this session and its conversation history.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteSessionDialog) {
                  deleteSessionMutation.mutate({
                    sessionId: deleteSessionDialog.id,
                    agentType: deleteSessionDialog.agentType,
                  })
                }
              }}
              disabled={deleteSessionMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteSessionMutation.isPending ? 'Deleting...' : 'Delete Session'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCloneDialog} onOpenChange={(open) => !open && setShowCloneDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clone Workspace</AlertDialogTitle>
            <AlertDialogDescription>
              Create a copy of <span className="font-mono font-semibold text-foreground">{workspace?.name}</span> with all its data.
              The source workspace will be temporarily stopped during cloning.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="clone-name" className="text-sm text-muted-foreground">
              New workspace name
            </Label>
            <Input
              id="clone-name"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              placeholder="e.g., my-project-copy"
              className="mt-2"
              autoComplete="off"
              data-testid="clone-name-input"
            />
            {cloneNameError && <p className="text-sm text-destructive mt-2">{cloneNameError}</p>}
            {cloneMutation.error && (
              <p className="text-sm text-destructive mt-2">
                {(cloneMutation.error as Error).message || 'Clone failed'}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowCloneDialog(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (canClone) {
                  cloneMutation.mutate(trimmedCloneName)
                }
              }}
              disabled={!canClone || cloneMutation.isPending}
            >
              {cloneMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cloning...
                </>
              ) : (
                'Clone Workspace'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
