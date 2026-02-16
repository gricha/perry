import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ghostty, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web'
import { getTerminalUrl, getToken } from '@/lib/api'

interface TerminalProps {
  workspaceName: string
  initialCommand?: string
  runId?: string
}

const MAX_CACHED_TERMINALS = 5

interface CachedTerminal {
  ghostty: Ghostty
  terminal: GhosttyTerminal
  fitAddon: FitAddon
  ws: WebSocket | null
  lastUsed: number
  initialCommandSent: boolean
  runId?: string
}

const terminalCache = new Map<string, CachedTerminal>()

function evictLRU(): void {
  if (terminalCache.size <= MAX_CACHED_TERMINALS) return

  let oldest: string | null = null
  let oldestTime = Infinity

  for (const [key, cached] of terminalCache) {
    if (cached.lastUsed < oldestTime) {
      oldestTime = cached.lastUsed
      oldest = key
    }
  }

  if (oldest) {
    const cached = terminalCache.get(oldest)
    if (cached) {
      cached.ws?.close()
      cached.terminal.dispose()
      terminalCache.delete(oldest)
    }
  }
}

function getOrCreateTerminal(
  cacheKey: string,
  ghosttyFactory: () => Promise<Ghostty>
): Promise<CachedTerminal> {
  const existing = terminalCache.get(cacheKey)
  if (existing) {
    existing.lastUsed = Date.now()
    return Promise.resolve(existing)
  }

  return ghosttyFactory().then((ghostty) => {
    const terminal = new GhosttyTerminal({
      ghostty,
      cursorBlink: false,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      scrollback: 10000,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        selectionForeground: '#ffffff',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const cached: CachedTerminal = {
      ghostty,
      terminal,
      fitAddon,
      ws: null,
      lastUsed: Date.now(),
      initialCommandSent: false,
    }

    terminalCache.set(cacheKey, cached)
    evictLRU()

    return cached
  })
}

function TerminalInstance({ workspaceName, initialCommand, runId }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const cachedRef = useRef<CachedTerminal | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [hasReceivedData, setHasReceivedData] = useState(false)

  const cacheKey = useMemo(() => `${workspaceName}:${runId ?? 'default'}`, [workspaceName, runId])

  const setupWebSocket = useCallback((cached: CachedTerminal, cancelled: { current: boolean }) => {
    if (cached.ws && cached.ws.readyState === WebSocket.OPEN) {
      setIsConnected(true)
      if (initialCommand && !cached.initialCommandSent) {
        cached.initialCommandSent = true
        cached.ws.send(initialCommand + '\n')
      }
      return
    }

    cached.ws?.close()

    const wsUrl = getTerminalUrl(workspaceName)
    const ws = new WebSocket(wsUrl)
    cached.ws = ws

    ws.onopen = () => {
      if (cancelled.current) return
      setIsConnected(true)
      const token = getToken()
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }))
      }
      const { cols, rows } = cached.terminal
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))

      if (initialCommand && !cached.initialCommandSent) {
        cached.initialCommandSent = true
        setTimeout(() => {
          if (!cancelled.current && ws.readyState === WebSocket.OPEN) {
            ws.send(initialCommand + '\n')
          }
        }, 500)
      }
    }

    ws.onmessage = (event) => {
      if (cancelled.current) return
      setHasReceivedData(true)
      if (event.data instanceof Blob) {
        event.data.text().then((text) => {
          if (!cancelled.current) cached.terminal.write(text)
        })
      } else if (event.data instanceof ArrayBuffer) {
        cached.terminal.write(new Uint8Array(event.data))
      } else {
        cached.terminal.write(event.data)
      }
    }

    ws.onclose = (event) => {
      if (cancelled.current) return
      setIsConnected(false)
      cached.terminal.writeln('')
      if (event.code === 1000) {
        cached.terminal.writeln('\x1b[38;5;245mSession ended\x1b[0m')
      } else if (event.code === 404 || event.reason?.includes('not found')) {
        cached.terminal.writeln('\x1b[31mWorkspace not found or not running\x1b[0m')
      } else {
        cached.terminal.writeln(`\x1b[31mDisconnected (code: ${event.code})\x1b[0m`)
      }
    }

    ws.onerror = () => {
      if (cancelled.current) return
      setIsConnected(false)
      cached.terminal.writeln('\x1b[31mConnection error - is the workspace running?\x1b[0m')
    }
  }, [workspaceName, initialCommand])

  useEffect(() => {
    const cancelled = { current: false }

    const connect = async () => {
      if (!terminalRef.current || cancelled.current) return

      const cached = await getOrCreateTerminal(cacheKey, () => Ghostty.load())
      if (cancelled.current) return

      cachedRef.current = cached
      cached.lastUsed = Date.now()
      if (cached.runId !== runId) {
        cached.initialCommandSent = false
        cached.runId = runId
      }
      setIsInitialized(true)

      const term = cached.terminal

      const isAlreadyOpen = term.element?.parentElement != null
      if (!isAlreadyOpen) {
        term.open(terminalRef.current)
      } else {
        terminalRef.current.appendChild(term.element!)
      }

      if (term.textarea) {
        term.textarea.style.opacity = '0'
        term.textarea.style.position = 'absolute'
        term.textarea.style.left = '-9999px'
        term.textarea.style.top = '-9999px'
      }

      requestAnimationFrame(() => {
        if (!cancelled.current) {
          try {
            cached.fitAddon.fit()
          } catch {}
        }
      })

      setupWebSocket(cached, cancelled)

      term.onData((data) => {
        if (cached.ws?.readyState === WebSocket.OPEN) {
          cached.ws.send(data)
        }
      })

      term.onResize(({ cols, rows }) => {
        if (cached.ws?.readyState === WebSocket.OPEN) {
          cached.ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      })

      term.focus()
    }

    connect()

    const handleFit = () => {
      if (cachedRef.current) {
        try {
          cachedRef.current.fitAddon.fit()
        } catch {}
      }
    }

    const debouncedFit = debounce(handleFit, 100)

    if (terminalRef.current) {
      resizeObserverRef.current = new ResizeObserver(() => {
        debouncedFit()
      })
      resizeObserverRef.current.observe(terminalRef.current)
    }

    window.addEventListener('resize', debouncedFit)

    const containerElement = terminalRef.current

    return () => {
      cancelled.current = true
      window.removeEventListener('resize', debouncedFit)
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null

      if (cachedRef.current?.terminal.element?.parentElement === containerElement) {
        containerElement?.removeChild(cachedRef.current.terminal.element)
      }
      cachedRef.current = null
    }
  }, [cacheKey, runId, setupWebSocket, workspaceName])

  return (
    <>
      <div
        ref={terminalRef}
        className="absolute inset-0"
        data-testid="terminal-screen"
        style={{
          padding: '8px',
          opacity: 1,
        }}
        onClick={() => cachedRef.current?.terminal.focus()}
      />
      {!isInitialized && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1117]">
          <span className="text-zinc-500 text-sm">Loading terminal...</span>
        </div>
      )}
      {isInitialized && !isConnected && hasReceivedData && (
        <div className="absolute bottom-3 right-3">
          <span className="text-xs text-zinc-500 bg-zinc-900/80 px-2 py-1 rounded">
            Disconnected
          </span>
        </div>
      )}
    </>
  )
}

export function Terminal({ workspaceName, initialCommand, runId }: TerminalProps) {
  return (
    <div className="relative h-full w-full bg-[#0d1117] rounded-lg overflow-hidden cursor-default" data-testid="terminal-container">
      <TerminalInstance
        key={`${workspaceName}-${runId ?? 'default'}`}
        workspaceName={workspaceName}
        initialCommand={initialCommand}
        runId={runId}
      />
    </div>
  )
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timeoutId: ReturnType<typeof setTimeout>
  return ((...args: unknown[]) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), ms)
  }) as T
}
