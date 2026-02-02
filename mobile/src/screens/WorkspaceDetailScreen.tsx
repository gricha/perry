import { useState, useMemo, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native'
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import Reanimated, { SharedValue, useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from '@react-navigation/native'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, SessionInfo, AgentType, HOST_WORKSPACE_NAME } from '../lib/api'
import { parseNetworkError } from '../lib/network'
import { useTheme } from '../contexts/ThemeContext'
import { ThemeColors } from '../lib/themes'
import { AgentIcon } from '../components/AgentIcon'

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

function getAgentStartCommand(agentType: AgentType): string {
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

const DELETE_ACTION_WIDTH = 80

function WorkspaceDetailDeleteAction({
  drag,
  onPress,
  color,
}: {
  drag: SharedValue<number>
  onPress: () => void
  color: string
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drag.value + DELETE_ACTION_WIDTH }],
  }))

  return (
    <Reanimated.View style={[styles.deleteAction, { backgroundColor: color }, animatedStyle]}>
      <TouchableOpacity style={styles.deleteActionTouchable} onPress={onPress}>
        <Text style={styles.deleteActionText}>Delete</Text>
      </TouchableOpacity>
    </Reanimated.View>
  )
}

function getDateGroup(dateString: string): DateGroup {
  const date = new Date(dateString)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 7)

  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  if (date >= weekAgo) return 'This Week'
  return 'Older'
}

function groupSessionsByDate(sessions: SessionInfo[]): Record<DateGroup, SessionInfo[]> {
  const groups: Record<DateGroup, SessionInfo[]> = {
    Today: [],
    Yesterday: [],
    'This Week': [],
    Older: [],
  }
  sessions.forEach((s) => {
    const group = getDateGroup(s.lastActivity)
    groups[group].push(s)
  })
  return groups
}

function SessionRow({
  session,
  onPress,
  colors,
}: {
  session: SessionInfo
  onPress: () => void
  colors: ThemeColors
}) {
  const timeAgo = useMemo(() => {
    const date = new Date(session.lastActivity)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `${mins}m`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    return `${days}d`
  }, [session.lastActivity])

  return (
    <TouchableOpacity style={[styles.sessionRow, { borderBottomColor: colors.border, backgroundColor: colors.background }]} onPress={onPress}>
      <View style={styles.agentIconWrapper}>
        <AgentIcon agentType={session.agentType} size="sm" />
      </View>
      <View style={styles.sessionContent}>
        <Text style={[styles.sessionName, { color: colors.text }]} numberOfLines={1}>
          {session.name || session.firstPrompt || 'Empty session'}
        </Text>
        <Text style={[styles.sessionMeta, { color: colors.textMuted }]}>
          {session.messageCount} messages • {session.projectPath.split('/').pop()}
        </Text>
      </View>
      <Text style={[styles.sessionTime, { color: colors.textMuted }]}>{timeAgo}</Text>
      <Text style={[styles.sessionChevron, { color: colors.textMuted }]}>›</Text>
    </TouchableOpacity>
  )
}

function DateGroupHeader({ title, colors }: { title: string; colors: ThemeColors }) {
  return (
    <View style={styles.dateGroupHeader}>
      <Text style={[styles.dateGroupTitle, { color: colors.textMuted }]}>{title}</Text>
    </View>
  )
}

export function WorkspaceDetailScreen({ route, navigation }: any) {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const queryClient = useQueryClient()
  const { name } = route.params
  const [agentFilter, setAgentFilter] = useState<AgentType | undefined>(undefined)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [showNewSessionPicker, setShowNewSessionPicker] = useState(false)
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false)
  const [isManualRefresh, setIsManualRefresh] = useState(false)

  const isHost = name === HOST_WORKSPACE_NAME

  const { data: workspace, isLoading: workspaceLoading } = useQuery({
    queryKey: ['workspace', name],
    queryFn: () => api.getWorkspace(name),
    refetchInterval: 5000,
    enabled: !isHost,
  })

  const { data: hostInfo } = useQuery({
    queryKey: ['hostInfo'],
    queryFn: api.getHostInfo,
    enabled: isHost,
  })

  const { data: allWorkspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: api.listWorkspaces,
  })

  const isRunning = isHost ? true : workspace?.status === 'running'
  const isCreating = isHost ? false : workspace?.status === 'creating'
  const startupSteps = workspace?.startup?.steps ?? []

  const { data: sessionsData, isLoading: sessionsLoading, refetch: refetchSessions } = useQuery({
    queryKey: ['sessions', name, agentFilter],
    queryFn: () => api.listSessions(name, agentFilter, 50),
    enabled: isRunning,
  })

  const deleteSessionMutation = useMutation({
    mutationFn: (input: { sessionId: string; agentType: AgentType }) =>
      api.deleteSession(name, input.sessionId, input.agentType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', name] })
    },
    onError: (err) => {
      Alert.alert('Error', parseNetworkError(err))
    },
  })

  const confirmDeleteSession = useCallback((session: SessionInfo, onCancel?: () => void) => {
    Alert.alert(
      'Delete session?',
      'This will permanently delete the session and its messages.',
      [
        { text: 'Cancel', style: 'cancel', onPress: onCancel },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteSessionMutation.mutate({ sessionId: session.id, agentType: session.agentType }),
        },
      ]
    )
  }, [deleteSessionMutation])

  useFocusEffect(
    useCallback(() => {
      if (isRunning) {
        refetchSessions()
      }
    }, [isRunning, refetchSessions])
  )

  const handleManualRefresh = useCallback(async () => {
    setIsManualRefresh(true)
    await refetchSessions()
    setIsManualRefresh(false)
  }, [refetchSessions])

  const groupedSessions = useMemo(() => {
    if (!sessionsData?.sessions) return null
    return groupSessionsByDate(sessionsData.sessions)
  }, [sessionsData?.sessions])

  const flatData = useMemo(() => {
    if (!groupedSessions) return []
    const result: ({ type: 'header'; title: DateGroup } | { type: 'session'; session: SessionInfo })[] = []
    const order: DateGroup[] = ['Today', 'Yesterday', 'This Week', 'Older']
    order.forEach((group) => {
      if (groupedSessions[group].length > 0) {
        result.push({ type: 'header', title: group })
        groupedSessions[group].forEach((s) => result.push({ type: 'session', session: s }))
      }
    })
    return result
  }, [groupedSessions])

  const displayName = isHost
    ? (hostInfo ? `${hostInfo.username}@${hostInfo.hostname}` : 'Host Machine')
    : name

  const agentLabels: Record<string, string> = {
    all: 'All Agents',
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
    codex: 'Codex',
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={[styles.backBtnText, { color: colors.accent }]}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.headerCenter}
          onPress={() => setShowWorkspacePicker(!showWorkspacePicker)}
        >
          <Text style={[styles.headerTitle, { color: colors.text }, isHost && styles.hostHeaderTitle]} numberOfLines={1}>{displayName}</Text>
          <View style={[styles.statusIndicator, { backgroundColor: isHost ? colors.warning : (isRunning ? colors.success : isCreating ? colors.warning : colors.textMuted) }]} />
          <Text style={[styles.headerChevron, { color: colors.textMuted }]}>▼</Text>
        </TouchableOpacity>
        {isHost ? (
          <View style={styles.settingsBtn} />
        ) : (
          <TouchableOpacity
            onPress={() => navigation.navigate('WorkspaceSettings', { name })}
            style={styles.settingsBtn}
          >
            <Text style={[styles.settingsIcon, { color: colors.textMuted }]}>⚙</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={[styles.actionBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.filterBtn, { backgroundColor: colors.surface }]}
          onPress={() => setShowAgentPicker(!showAgentPicker)}
        >
          <Text style={[styles.filterBtnText, { color: colors.text }]}>
            {agentLabels[agentFilter || 'all']}
          </Text>
          <Text style={[styles.filterBtnArrow, { color: colors.textMuted }]}>▼</Text>
        </TouchableOpacity>

        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[styles.terminalBtn, { backgroundColor: colors.surface }]}
            onPress={() => navigation.navigate('Terminal', { name })}
            disabled={!isRunning}
            testID="terminal-button"
          >
            <Text style={[styles.terminalBtnText, { color: colors.text }, !isRunning && styles.disabledText]}>Terminal</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.newChatBtn, { backgroundColor: colors.accent }]}
            onPress={() => setShowNewSessionPicker(!showNewSessionPicker)}
            disabled={!isRunning}
            testID="new-session-button"
          >
            <Text style={[styles.newChatBtnText, { color: colors.accentText }, !isRunning && styles.disabledText]}>New Session ▼</Text>
          </TouchableOpacity>
        </View>
      </View>

      {showAgentPicker && (
        <View style={[styles.agentPicker, { backgroundColor: colors.surface }]}>
          {(['all', 'claude-code', 'opencode', 'codex'] as const).map((type) => (
            <TouchableOpacity
              key={type}
              style={[
                styles.agentPickerItem,
                (type === 'all' ? !agentFilter : agentFilter === type) && [styles.agentPickerItemActive, { backgroundColor: colors.surfaceSecondary }],
              ]}
              onPress={() => {
                setAgentFilter(type === 'all' ? undefined : type as AgentType)
                setShowAgentPicker(false)
              }}
            >
              <Text style={[styles.agentPickerText, { color: colors.text }]}>{agentLabels[type]}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {showNewSessionPicker && (
        <View style={styles.newChatPickerOverlay}>
          <TouchableOpacity style={styles.newChatPickerBackdrop} onPress={() => setShowNewSessionPicker(false)} />
          <View style={[styles.newChatPicker, { backgroundColor: colors.surfaceSecondary }]}>
            <Text style={[styles.newChatPickerTitle, { color: colors.textMuted }]}>Start session with</Text>
            {(['claude-code', 'opencode', 'codex'] as const).map((type) => (
              <TouchableOpacity
                key={type}
                style={styles.newChatPickerItem}
                onPress={() => {
                  setShowNewSessionPicker(false)
                  const runId = `${type}-${Date.now()}`
                  navigation.navigate('Terminal', {
                    name,
                    initialCommand: getAgentStartCommand(type),
                    runId,
                  })
                }}
                testID={`new-session-${type}`}
              >
                <AgentIcon agentType={type} size="md" />
                <Text style={[styles.newChatPickerItemText, { color: colors.text }]}>{agentLabels[type]}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {showWorkspacePicker && (
        <View style={styles.workspacePickerOverlay}>
          <TouchableOpacity style={styles.workspacePickerBackdrop} onPress={() => setShowWorkspacePicker(false)} />
          <View style={[styles.workspacePicker, { backgroundColor: colors.surfaceSecondary }]}>
            <Text style={[styles.workspacePickerTitle, { color: colors.textMuted }]}>Switch workspace</Text>
            {allWorkspaces?.map((ws) => (
              <TouchableOpacity
                key={ws.name}
                style={[styles.workspacePickerItem, ws.name === name && [styles.workspacePickerItemActive, { backgroundColor: colors.surface }]]}
                onPress={() => {
                  setShowWorkspacePicker(false)
                  if (ws.name !== name) {
                    navigation.replace('WorkspaceDetail', { name: ws.name })
                  }
                }}
              >
                <View style={[styles.workspaceStatusDot, { backgroundColor: ws.status === 'running' ? colors.success : ws.status === 'creating' ? colors.warning : colors.textMuted }]} />
                <Text style={[styles.workspacePickerItemText, { color: colors.text }, ws.name === name && styles.workspacePickerItemTextActive]}>{ws.name}</Text>
                {ws.name === name && <Text style={[styles.workspaceCheckmark, { color: colors.accent }]}>✓</Text>}
              </TouchableOpacity>
            ))}
            {!isHost && (
              <TouchableOpacity
                style={styles.workspacePickerItem}
                onPress={() => {
                  setShowWorkspacePicker(false)
                  navigation.replace('WorkspaceDetail', { name: HOST_WORKSPACE_NAME })
                }}
              >
                <View style={[styles.workspaceStatusDot, { backgroundColor: colors.warning }]} />
                <Text style={[styles.workspacePickerItemText, { color: colors.text }]}>Host Machine</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {isHost && (
        <View style={[styles.hostWarningBanner, { borderBottomColor: `${colors.warning}33` }]}>
          <Text style={[styles.hostWarningText, { color: colors.warning }]}>
            Commands run directly on your machine without isolation
          </Text>
        </View>
      )}

      {workspaceLoading && !isHost ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : !isRunning && !isHost ? (
        isCreating ? (
          <View style={styles.notRunning}>
            <ActivityIndicator size="large" color={colors.warning} style={{ marginBottom: 16 }} />
            <Text style={[styles.notRunningText, { color: colors.textMuted }]}>Workspace is starting</Text>
            <Text style={[styles.notRunningSubtext, { color: colors.textMuted }]}>Please wait while the container starts up</Text>
            {startupSteps.length > 0 && (
              <View style={[styles.startupSteps, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}>
                {startupSteps.map((step) => {
                  const color = step.status === 'done'
                    ? colors.success
                    : step.status === 'running'
                      ? colors.warning
                      : step.status === 'error'
                        ? colors.error
                        : step.status === 'skipped'
                          ? colors.textMuted
                          : colors.textMuted
                  return (
                    <View key={step.id} style={styles.startupStepRow}>
                      <View style={[styles.startupStepDot, { backgroundColor: color }]} />
                      <View style={styles.startupStepText}>
                        <Text style={[styles.startupStepTitle, { color: colors.text }]}>{step.label}</Text>
                        {step.message && (
                          <Text style={[styles.startupStepMessage, { color: colors.textMuted }]}>{step.message}</Text>
                        )}
                      </View>
                    </View>
                  )
                })}
              </View>
            )}
          </View>
        ) : (
          <View style={styles.notRunning}>
            <Text style={[styles.notRunningText, { color: colors.textMuted }]}>Workspace is not running</Text>
            <Text style={[styles.notRunningSubtext, { color: colors.textMuted }]}>Start it from settings to view sessions</Text>
          </View>
        )
      ) : sessionsLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      ) : flatData.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>No sessions yet</Text>
          <Text style={[styles.emptySubtext, { color: colors.textMuted }]}>Start a new session to create one</Text>
        </View>
      ) : (
        <FlatList
          data={flatData}
          keyExtractor={(item) => item.type === 'header' ? `header-${item.title}` : `session-${item.session.id}`}
          renderItem={({ item }) => {
            if (item.type === 'header') {
              return <DateGroupHeader title={item.title} colors={colors} />
            }
             return (
               <ReanimatedSwipeable
                 friction={2}
                 rightThreshold={40}
                 renderRightActions={(_prog, drag, swipeable) => (
                   <WorkspaceDetailDeleteAction
                     drag={drag}
                     onPress={() => confirmDeleteSession(item.session, swipeable.close)}
                     color={colors.error}
                   />
                 )}
               >
                 <SessionRow
                   session={item.session}
                   colors={colors}
                   onPress={() => {
                     const resumeId = item.session.agentSessionId || item.session.id
                     const command = getAgentResumeCommand(item.session.agentType, resumeId)
                     navigation.navigate('Terminal', {
                       name,
                       initialCommand: command,
                       runId: `${item.session.agentType}-${item.session.id}`,
                     })
                     api.recordSessionAccess(name, item.session.id, item.session.agentType).catch(() => {})
                   }}
                 />
               </ReanimatedSwipeable>
             )
          }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
          refreshControl={
            <RefreshControl
              refreshing={isManualRefresh}
              onRefresh={handleManualRefresh}
              tintColor={colors.text}
            />
          }
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1e',
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnText: {
    fontSize: 32,
    color: '#0a84ff',
    fontWeight: '300',
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
  },
  hostHeaderTitle: {
    color: '#f59e0b',
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  settingsBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsIcon: {
    fontSize: 22,
    color: '#8e8e93',
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1e',
  },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  filterBtnText: {
    fontSize: 14,
    color: '#fff',
  },
  filterBtnArrow: {
    fontSize: 10,
    color: '#8e8e93',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  terminalBtn: {
    backgroundColor: '#1c1c1e',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  terminalBtnText: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '500',
  },
  newChatBtn: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  newChatBtnText: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '500',
  },
  disabledText: {
    opacity: 0.4,
  },
  agentPicker: {
    backgroundColor: '#1c1c1e',
    marginHorizontal: 12,
    marginTop: -1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  agentPickerItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  agentPickerItemActive: {
    backgroundColor: '#2c2c2e',
  },
  agentPickerText: {
    fontSize: 15,
    color: '#fff',
  },
  hostWarningBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(245, 158, 11, 0.2)',
  },
  hostWarningText: {
    fontSize: 12,
    color: '#f59e0b',
    textAlign: 'center',
  },
  notRunning: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  notRunningText: {
    fontSize: 17,
    color: '#8e8e93',
    fontWeight: '500',
  },
  notRunningSubtext: {
    fontSize: 14,
    color: '#636366',
    marginTop: 6,
  },
  startupSteps: {
    width: '100%',
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 10,
  },
  startupStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  startupStepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
  },
  startupStepText: {
    flex: 1,
  },
  startupStepTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  startupStepMessage: {
    fontSize: 12,
    marginTop: 2,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 17,
    color: '#8e8e93',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#636366',
    marginTop: 4,
  },
  dateGroupHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  dateGroupTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#636366',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1c1c1e',
  },
  agentIconWrapper: {
    marginRight: 10,
  },
  sessionContent: {
    flex: 1,
  },
  sessionName: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '500',
  },
  sessionMeta: {
    fontSize: 12,
    color: '#636366',
    marginTop: 2,
  },
  sessionTime: {
    fontSize: 13,
    color: '#636366',
    marginRight: 8,
  },
  sessionChevron: {
    fontSize: 18,
    color: '#636366',
  },
  newChatPickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  newChatPickerBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  newChatPicker: {
    position: 'absolute',
    top: 120,
    right: 12,
    backgroundColor: '#2c2c2e',
    borderRadius: 12,
    padding: 12,
    minWidth: 180,
  },
  newChatPickerTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8e8e93',
    marginBottom: 12,
    textAlign: 'center',
  },
  newChatPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    gap: 12,
  },
  newChatPickerItemText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '500',
  },
  headerChevron: {
    fontSize: 10,
    color: '#8e8e93',
    marginLeft: 4,
  },
  workspacePickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
  },
  workspacePickerBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  workspacePicker: {
    position: 'absolute',
    top: 60,
    left: 50,
    right: 50,
    backgroundColor: '#2c2c2e',
    borderRadius: 12,
    padding: 12,
  },
  workspacePickerTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8e8e93',
    marginBottom: 12,
    textAlign: 'center',
  },
  workspacePickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 10,
  },
  workspacePickerItemActive: {
    backgroundColor: '#3c3c3e',
  },
  workspacePickerItemText: {
    fontSize: 16,
    color: '#fff',
    flex: 1,
  },
  workspacePickerItemTextActive: {
    fontWeight: '600',
  },
  workspaceStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  workspaceCheckmark: {
    fontSize: 14,
    color: '#0a84ff',
    fontWeight: '600',
  },
  deleteAction: {
    width: DELETE_ACTION_WIDTH,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteActionTouchable: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  deleteActionText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  },
})
