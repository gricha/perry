import { useRef, useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
  Animated,
  Platform,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { useQuery } from '@tanstack/react-query'
import { api, getTerminalHtml, getTerminalUrl, getToken, HOST_WORKSPACE_NAME } from '../lib/api'
import { ExtraKeysBar } from '../components/ExtraKeysBar'
import { useTheme } from '../contexts/ThemeContext'

export function TerminalScreen({ route, navigation }: any) {
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const { name, initialCommand, runId: _runId } = route.params
  const webViewRef = useRef<WebView>(null)
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const [ctrlActive, setCtrlActive] = useState(false)
  const keyboardAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height)
      Animated.timing(keyboardAnim, {
        toValue: 1,
        duration: Platform.OS === 'ios' ? e.duration : 200,
        useNativeDriver: false,
      }).start()
    })

    const hideSub = Keyboard.addListener(hideEvent, (e) => {
      Animated.timing(keyboardAnim, {
        toValue: 0,
        duration: Platform.OS === 'ios' ? e.duration : 200,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) {
          setKeyboardHeight(0)
        }
      })
    })

    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [keyboardAnim])

  const isHost = name === HOST_WORKSPACE_NAME

  const { data: workspace } = useQuery({
    queryKey: ['workspace', name],
    queryFn: () => api.getWorkspace(name),
    enabled: !isHost,
  })

  const { data: hostInfo } = useQuery({
    queryKey: ['hostInfo'],
    queryFn: api.getHostInfo,
    enabled: isHost,
  })

  const isRunning = isHost ? (hostInfo?.enabled ?? false) : workspace?.status === 'running'

  const sendKey = useCallback((sequence: string) => {
    webViewRef.current?.postMessage(JSON.stringify({
      type: 'sendKey',
      key: sequence,
    }))
  }, [])

  const handleCtrlToggle = useCallback((active: boolean) => {
    setCtrlActive(active)
    webViewRef.current?.injectJavaScript(`window.setCtrlActive && window.setCtrlActive(${active}); true;`)
  }, [])

  const handleMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      if (data.type === 'connected') {
        setConnected(true)
        setLoading(false)
      } else if (data.type === 'disconnected' || data.type === 'error') {
        setConnected(false)
      } else if (data.type === 'ctrlReleased') {
        setCtrlActive(false)
      }
    } catch {
      // Ignore JSON parse errors for non-JSON messages
    }
  }

  const wsUrl = getTerminalUrl(name)
  const token = getToken()
  const escapedCommand = initialCommand ? initialCommand.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''
  const escapedToken = token ? token.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''

  const injectedJS = `
    if (window.initTerminal) {
      window.initTerminal('${wsUrl}', '${escapedCommand}', '${escapedToken}');
    }
    true;
  `

  if (!isRunning) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.accent }]}>‹</Text>
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Terminal</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.notRunning}>
          <Text style={[styles.notRunningText, { color: colors.textMuted }]}>Workspace is not running</Text>
          <Text style={[styles.notRunningSubtext, { color: colors.textMuted }]}>Start it to access the terminal</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={[styles.backBtnText, { color: colors.accent }]}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Terminal</Text>
          <View style={[styles.connectionDot, { backgroundColor: connected ? colors.success : colors.textMuted }]} />
        </View>
        <View style={styles.placeholder} />
      </View>

      <Animated.View
        style={[
          styles.terminalContainer,
          {
            paddingBottom: keyboardAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [insets.bottom, keyboardHeight + 50],
            }),
          },
        ]}
      >
        {loading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={[styles.loadingText, { color: colors.textMuted }]}>Loading terminal...</Text>
          </View>
        )}
        <WebView
          ref={webViewRef}
          source={{ html: getTerminalHtml() }}
          style={styles.webview}
          onMessage={handleMessage}
          injectedJavaScript={injectedJS}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          bounces={false}
          keyboardDisplayRequiresUserAction={false}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.extraKeysContainer,
          {
            bottom: keyboardAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [-50, keyboardHeight],
            }),
            opacity: keyboardAnim,
          },
        ]}
      >
        <ExtraKeysBar onSendKey={sendKey} ctrlActive={ctrlActive} onCtrlToggle={handleCtrlToggle} />
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
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
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  placeholder: {
    width: 44,
  },
  terminalContainer: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  extraKeysContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0d1117',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#8e8e93',
  },
  notRunning: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
})
