import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const umdPath = join(__dirname, '../node_modules/ghostty-web/dist/ghostty-web.umd.cjs')
const umdContent = readFileSync(umdPath, 'utf-8')

const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #0d1117;
    }
    #terminal {
      width: 100%;
      height: 100%;
      padding: 8px;
    }
    #terminal textarea,
    #terminal input {
      position: absolute !important;
      left: -9999px !important;
      top: -9999px !important;
      opacity: 0 !important;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script>
${umdContent}
  </script>
  <script>
    const { Ghostty, Terminal, FitAddon } = GhosttyWeb;

    let term = null;
    let ws = null;
    let fitAddon = null;

    async function connect(wsUrl, initialCommand, token) {
      const ghostty = await Ghostty.load();

      term = new Terminal({
        ghostty,
        cursorBlink: false,
        cursorStyle: 'block',
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, monospace',
        scrollback: 5000,
        theme: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          cursor: '#58a6ff',
          cursorAccent: '#0d1117',
          selectionBackground: '#264f78',
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
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('terminal'));

      const textarea = document.querySelector('#terminal textarea');
      if (textarea) {
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('autocorrect', 'off');
        textarea.setAttribute('autocomplete', 'off');
        textarea.setAttribute('spellcheck', 'false');
      }

      requestAnimationFrame(() => {
        fitAddon.fit();
      });

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'connected' }));
        if (token) {
          ws.send(JSON.stringify({ type: 'auth', token: token }));
        }
        const dims = term.getDimensions ? term.getDimensions() : { cols: term.cols, rows: term.rows };
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        if (initialCommand) {
          setTimeout(() => {
            ws.send(initialCommand + '\\n');
          }, 500);
        }
      };

      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          event.data.text().then(text => term.write(text));
        } else {
          term.write(event.data);
        }
      };

      ws.onclose = (event) => {
        term.writeln('');
        if (event.code === 1000) {
          term.writeln('\\x1b[38;5;245mSession ended\\x1b[0m');
        } else {
          term.writeln('\\x1b[31mDisconnected\\x1b[0m');
        }
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'disconnected' }));
      };

      ws.onerror = () => {
        term.writeln('\\x1b[31mConnection error\\x1b[0m');
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error' }));
      };

      let ctrlActive = false;

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          if (ctrlActive && data.length === 1) {
            const code = data.charCodeAt(0);
            if (code >= 97 && code <= 122) {
              ws.send(String.fromCharCode(code - 96));
              ctrlActive = false;
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ctrlReleased' }));
              return;
            }
            if (code >= 65 && code <= 90) {
              ws.send(String.fromCharCode(code - 64));
              ctrlActive = false;
              window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ctrlReleased' }));
              return;
            }
          }
          ws.send(data);
        }
      });

      window.setCtrlActive = (active) => {
        ctrlActive = active;
      };

      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      term.focus();
    }

    window.addEventListener('resize', () => {
      if (fitAddon) {
        fitAddon.fit();
      }
    });

    function handleMessage(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'sendKey' && ws?.readyState === WebSocket.OPEN) {
          ws.send(data.key);
        }
      } catch {}
    }

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage);

    window.initTerminal = connect;
  </script>
</body>
</html>`

const outputPath = join(__dirname, '../src/lib/terminal-html.ts')
writeFileSync(outputPath, `export const TERMINAL_HTML = ${JSON.stringify(html)};\n`)

console.log('Generated terminal-html.ts')
