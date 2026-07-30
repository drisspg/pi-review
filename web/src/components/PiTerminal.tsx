import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type PiTerminalServerMessage =
  | { type: "ready"; pid: number }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal: number }
  | { type: "error"; message: string };

type TerminalStatus = "connecting" | "connected" | "closed" | "error";

function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--panel2").trim(),
    foreground: styles.getPropertyValue("--text").trim(),
    cursor: styles.getPropertyValue("--text").trim(),
    cursorAccent: styles.getPropertyValue("--panel2").trim(),
    selectionBackground: `color-mix(in srgb, ${styles.getPropertyValue("--accent").trim()} 35%, transparent)`,
    black: "#484f58",
    red: styles.getPropertyValue("--danger").trim(),
    green: styles.getPropertyValue("--success").trim(),
    yellow: styles.getPropertyValue("--attention").trim(),
    blue: styles.getPropertyValue("--accent").trim(),
    magenta: styles.getPropertyValue("--thread-accent").trim(),
    cyan: styles.getPropertyValue("--link").trim(),
    white: styles.getPropertyValue("--text").trim(),
  };
}

function terminalWebSocketUrl(prKey: string, session: string, context?: string): string {
  const url = new URL("/api/pi/terminal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("prKey", prKey);
  url.searchParams.set("session", session);
  if (context != null) url.searchParams.set("context", context);
  return url.toString();
}

/** Render a real interactive Pi TUI connected to a server-owned pseudoterminal. */
export function PiTerminal({ prKey, session = "main", context, compact = false }: { prKey: string; session?: string; context?: string; compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (containerRef.current == null) return;
    const container: HTMLDivElement = containerRef.current;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      theme: terminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    const socket = new WebSocket(terminalWebSocketUrl(prKey, session, context));
    let ready = false;

    function send(message: Record<string, unknown>): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    function fit(): void {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fitAddon.fit();
      if (ready) send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    }

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const inputDisposable = terminal.onData((data) => send({ type: "input", data }));

    socket.addEventListener("message", (event) => {
      let message: PiTerminalServerMessage;
      try {
        message = JSON.parse(String(event.data)) as PiTerminalServerMessage;
      } catch {
        return;
      }
      if (message.type === "ready") {
        ready = true;
        setStatus("connected");
        window.requestAnimationFrame(() => {
          fit();
          terminal.focus();
        });
      } else if (message.type === "output") {
        terminal.write(message.data);
      } else if (message.type === "exit") {
        setStatus("closed");
        terminal.write(`\r\n\x1b[2mPi exited (${message.exitCode}). Reopen the terminal to continue this session.\x1b[0m\r\n`);
      } else {
        setStatus("error");
        setError(message.message);
      }
    });
    socket.addEventListener("close", () => setStatus((current) => current === "error" || current === "closed" ? current : "closed"));
    socket.addEventListener("error", () => {
      setStatus("error");
      setError("Could not connect to the Pi terminal.");
    });

    window.requestAnimationFrame(fit);
    return () => {
      inputDisposable.dispose();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      socket.close();
      terminal.dispose();
    };
  }, [context, prKey, session]);

  return <div className={`pi-native-terminal${compact ? " compact" : ""}`}>
    <div ref={containerRef} className="pi-native-terminal-surface" aria-label="Interactive Pi terminal" />
    {status !== "connected" && <div className={`pi-native-terminal-status ${status}`} role="status">
      {status === "connecting" ? "Connecting to Pi…" : status === "closed" ? "Pi terminal closed." : error ?? "Pi terminal unavailable."}
    </div>}
  </div>;
}
