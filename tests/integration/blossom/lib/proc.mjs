import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";

/** Direct and transitive child pids of `pid` (macOS and Linux). */
export function descendants(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  const children = (result.stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((value) => Number(value));
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start time of a pid as `ps` prints it; identifies the process so a recycled
 * pid is never mistaken for one this run started. Undefined if it is gone.
 */
function startTime(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const value = (result.stdout ?? "").trim();
  return result.status === 0 && value ? value : undefined;
}

/**
 * A child process owned by the harness. Output goes to a log file (never the
 * terminal) and only pids this object started or discovered as its own
 * descendants are ever signalled. Descendants are remembered together with
 * their start time, so a pid reused by an unrelated process is left alone.
 */
export class ManagedProcess {
  constructor(name, command, args, { env, cwd, logFile, trackEveryMs = 0 }) {
    this.name = name;
    this.logFile = logFile;
    /** @type {Map<number, string>} pid -> start time */
    this.descendantStarts = new Map();
    const fd = openSync(logFile, "a");
    this.child = spawn(command, args, {
      env,
      cwd,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
      this.child.once("error", (error) => resolve({ error }));
    });
    // A supervisor that crashes leaves its children orphaned (re-parented, so
    // `pgrep -P` no longer finds them); sampling while it runs keeps them known.
    if (trackEveryMs > 0) {
      this.tracker = setInterval(() => {
        if (this.running) this.trackDescendants();
      }, trackEveryMs);
      this.tracker.unref();
    }
  }

  get pid() {
    return this.child.pid;
  }

  get running() {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Pids of descendants seen so far (including ones that may have exited). */
  get descendantPids() {
    return new Set(this.descendantStarts.keys());
  }

  /** Remember current descendants so they can be reaped if they outlive us. */
  trackDescendants() {
    if (this.pid) {
      for (const pid of descendants(this.pid)) {
        if (this.descendantStarts.has(pid)) continue;
        const started = startTime(pid);
        if (started) this.descendantStarts.set(pid, started);
      }
    }
    return [...this.descendantStarts.keys()];
  }

  /** Tracked descendants that are still the same live process. */
  #liveDescendants() {
    return [...this.descendantStarts].filter(
      ([pid, started]) => alive(pid) && startTime(pid) === started,
    );
  }

  /** Whether this process or anything it spawned is still running. */
  survivors() {
    const found = this.#liveDescendants().map(([pid]) => `${this.name} child pid ${pid}`);
    if (this.running) found.unshift(`${this.name} pid ${this.pid}`);
    return found;
  }

  tail(lines = 40) {
    try {
      return readFileSync(this.logFile, "utf8").split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  async stop(graceMs = 8000) {
    if (this.tracker) clearInterval(this.tracker);
    if (!this.pid) return;
    this.trackDescendants();
    if (this.running) {
      this.child.kill("SIGTERM");
      const winner = await Promise.race([
        this.exited.then(() => "exited"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), graceMs)),
      ]);
      if (winner === "timeout") this.child.kill("SIGKILL");
    }
    // The agent supervises sing-box; make sure nothing it started survives.
    for (const [pid] of this.#liveDescendants()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const [pid] of this.#liveDescendants()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}
