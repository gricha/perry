import { View, StyleSheet } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { AgentType } from '../lib/api'

interface AgentIconProps {
  agentType: AgentType
  size?: 'sm' | 'md'
}

const ICON_COLORS: Record<AgentType, { bg: string; border: string }> = {
  'claude-code': { bg: 'rgba(249, 115, 22, 0.1)', border: 'rgba(249, 115, 22, 0.2)' },
  opencode: { bg: 'rgba(34, 197, 94, 0.1)', border: 'rgba(34, 197, 94, 0.2)' },
  codex: { bg: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.2)' },
  pi: { bg: 'rgba(139, 92, 246, 0.1)', border: 'rgba(139, 92, 246, 0.2)' },
}

function ClaudeIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"
        fill="#D97706"
      />
    </Svg>
  )
}

function OpenCodeIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <Path d="M320 224V352H192V224H320Z" fill="#5A5858" />
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="#10B981"
      />
    </Svg>
  )
}

function CodexIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M8 6L3 12L8 18M16 6L21 12L16 18"
        stroke="#3B82F6"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

function PiIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 7h12M9 7v10M15 7v10"
        stroke="#8B5CF6"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function AgentIcon({ agentType, size = 'sm' }: AgentIconProps) {
  const containerSize = size === 'sm' ? styles.containerSm : styles.containerMd
  const iconSize = size === 'sm' ? 14 : 18
  const iconColors = ICON_COLORS[agentType]

  return (
    <View style={[
      styles.container,
      containerSize,
      { backgroundColor: iconColors.bg, borderColor: iconColors.border }
    ]}>
      {agentType === 'claude-code' && <ClaudeIcon size={iconSize} />}
      {agentType === 'opencode' && <OpenCodeIcon size={iconSize} />}
      {agentType === 'codex' && <CodexIcon size={iconSize} />}
      {agentType === 'pi' && <PiIcon size={iconSize} />}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  containerSm: {
    width: 24,
    height: 24,
    borderRadius: 4,
  },
  containerMd: {
    width: 32,
    height: 32,
    borderRadius: 6,
  },
})
