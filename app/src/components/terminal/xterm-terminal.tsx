"use client";

import type { Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type React from "react";

import { cn } from "@/lib/utils";

export interface XtermTerminalHandle {
  write(data: string): void;
  clear(): void;
  fit(): void;
  focus(): void;
}

export interface XtermTerminalProps {
  className?: string;
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onReady?(): void;
  onError?(message: string): void;
}

/**
 * Thin xterm.js wrapper. The emulator modules (and their CSS) load only in
 * the browser so the Workers/SSR bundle never evaluates xterm's DOM code.
 */
export const XtermTerminal = forwardRef<
  XtermTerminalHandle,
  XtermTerminalProps
>(function XtermTerminal(
  { className, onData, onResize, onReady, onError },
  ref,
): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);

  onDataRef.current = onData;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useImperativeHandle(
    ref,
    () => ({
      write(data) {
        terminalRef.current?.write(data);
      },
      clear() {
        terminalRef.current?.clear();
      },
      fit() {
        fitRef.current?.fit();
      },
      focus() {
        terminalRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let terminal: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let dataSubscription: { dispose(): void } | undefined;
    let frame = 0;

    const fit = () => {
      if (!terminal || disposed) {
        return;
      }
      try {
        fitRef.current?.fit();
        onResizeRef.current(terminal.cols, terminal.rows);
      } catch {
        // A container that is mid-unmount has no measurable cell size.
      }
    };

    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };

    void (async () => {
      try {
        await import("@xterm/xterm/css/xterm.css");
        const [{ Terminal: TerminalCtor }, { FitAddon }, { WebLinksAddon }] =
          await Promise.all([
            import("@xterm/xterm"),
            import("@xterm/addon-fit"),
            import("@xterm/addon-web-links"),
          ]);
        if (disposed || !containerRef.current) {
          return;
        }
        terminal = new TerminalCtor({
          cursorBlink: true,
          fontFamily:
            '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.25,
          scrollback: 5000,
          allowProposedApi: false,
          theme: {
            background: "#0b0f14",
            foreground: "#d7e0ea",
            cursor: "#7dd3fc",
            cursorAccent: "#0b0f14",
            selectionBackground: "#1f3a52",
            black: "#111820",
            red: "#f87171",
            green: "#86efac",
            yellow: "#fde68a",
            blue: "#93c5fd",
            magenta: "#f0abfc",
            cyan: "#67e8f9",
            white: "#e5e7eb",
            brightBlack: "#64748b",
            brightRed: "#fca5a5",
            brightGreen: "#bbf7d0",
            brightYellow: "#fef08a",
            brightBlue: "#bfdbfe",
            brightMagenta: "#f5d0fe",
            brightCyan: "#a5f3fc",
            brightWhite: "#f8fafc",
          },
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(
          new WebLinksAddon((event, uri) => {
            event.preventDefault();
            window.open(uri, "_blank", "noopener,noreferrer");
          }),
        );
        terminal.open(containerRef.current);
        terminalRef.current = terminal;
        fitRef.current = fitAddon;
        dataSubscription = terminal.onData((data) => onDataRef.current(data));
        scheduleFit();
        onReadyRef.current?.();
        observer = new ResizeObserver(scheduleFit);
        observer.observe(containerRef.current);
        terminal.focus();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onErrorRef.current?.(message);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      dataSubscription?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        "min-h-72 w-full overflow-hidden rounded-lg bg-[#0b0f14] p-2",
        className,
      )}
      data-slot="xterm-terminal"
    />
  );
});
