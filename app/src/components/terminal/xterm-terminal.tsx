"use client";

import type { ITheme, Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type React from "react";

import { TERMINAL_FONT_SIZE } from "@/lib/terminal-view";
import { cn } from "@/lib/utils";

export interface XtermTerminalHandle {
  write(data: string): void;
  clear(): void;
  fit(): void;
  focus(): void;
  getSize(): { cols: number; rows: number } | null;
}

export interface XtermTerminalProps {
  className?: string;
  fontSize?: number;
  onData(data: string): void;
  onResize(cols: number, rows: number): void;
  onReady?(): void;
  onError?(message: string): void;
  onSize?(cols: number, rows: number): void;
}

function readCssVar(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
) {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

function readTerminalTheme(): ITheme {
  const fallback = {
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
  };
  if (typeof document === "undefined") {
    return fallback;
  }
  const styles = getComputedStyle(document.documentElement);
  return {
    background: readCssVar(
      styles,
      "--terminal-background",
      fallback.background,
    ),
    foreground: readCssVar(
      styles,
      "--terminal-foreground",
      fallback.foreground,
    ),
    cursor: readCssVar(styles, "--terminal-cursor", fallback.cursor),
    cursorAccent: fallback.cursorAccent,
    selectionBackground: readCssVar(
      styles,
      "--terminal-selection",
      fallback.selectionBackground,
    ),
    black: readCssVar(styles, "--terminal-black", fallback.black),
    red: readCssVar(styles, "--terminal-red", fallback.red),
    green: readCssVar(styles, "--terminal-green", fallback.green),
    yellow: readCssVar(styles, "--terminal-yellow", fallback.yellow),
    blue: readCssVar(styles, "--terminal-blue", fallback.blue),
    magenta: readCssVar(styles, "--terminal-magenta", fallback.magenta),
    cyan: readCssVar(styles, "--terminal-cyan", fallback.cyan),
    white: readCssVar(styles, "--terminal-white", fallback.white),
    brightBlack: readCssVar(
      styles,
      "--terminal-bright-black",
      fallback.brightBlack,
    ),
    brightRed: readCssVar(styles, "--terminal-bright-red", fallback.brightRed),
    brightGreen: readCssVar(
      styles,
      "--terminal-bright-green",
      fallback.brightGreen,
    ),
    brightYellow: readCssVar(
      styles,
      "--terminal-bright-yellow",
      fallback.brightYellow,
    ),
    brightBlue: readCssVar(
      styles,
      "--terminal-bright-blue",
      fallback.brightBlue,
    ),
    brightMagenta: readCssVar(
      styles,
      "--terminal-bright-magenta",
      fallback.brightMagenta,
    ),
    brightCyan: readCssVar(
      styles,
      "--terminal-bright-cyan",
      fallback.brightCyan,
    ),
    brightWhite: readCssVar(
      styles,
      "--terminal-bright-white",
      fallback.brightWhite,
    ),
  };
}

/**
 * Thin xterm.js wrapper. The emulator modules (and their CSS) load only in
 * the browser so the Workers/SSR bundle never evaluates xterm's DOM code.
 */
export const XtermTerminal = forwardRef<
  XtermTerminalHandle,
  XtermTerminalProps
>(function XtermTerminal(
  {
    className,
    fontSize = TERMINAL_FONT_SIZE.default,
    onData,
    onResize,
    onReady,
    onError,
    onSize,
  },
  ref,
): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const scheduleFitRef = useRef<() => void>(() => {});
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onSizeRef = useRef(onSize);
  const fontSizeRef = useRef(fontSize);

  onDataRef.current = onData;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onSizeRef.current = onSize;
  fontSizeRef.current = fontSize;

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
      getSize() {
        if (!terminalRef.current) {
          return null;
        }
        return {
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows,
        };
      },
    }),
    [],
  );

  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }
    terminalRef.current.options.fontSize = fontSize;
    scheduleFitRef.current();
  }, [fontSize]);

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
        onSizeRef.current?.(terminal.cols, terminal.rows);
      } catch {
        // A container that is mid-unmount has no measurable cell size.
      }
    };

    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    scheduleFitRef.current = scheduleFit;

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
          fontSize: fontSizeRef.current,
          lineHeight: 1.25,
          scrollback: 5000,
          allowProposedApi: false,
          theme: readTerminalTheme(),
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
        if (containerRef.current.parentElement) {
          observer.observe(containerRef.current.parentElement);
        }
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
      scheduleFitRef.current = () => {};
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        "size-full overflow-hidden bg-terminal px-2 py-1",
        className,
      )}
      data-slot="xterm-terminal"
    />
  );
});
