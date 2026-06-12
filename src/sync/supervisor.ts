import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { getSetting, setSetting } from "../db/index.ts";
import { obEnv } from "./ob.ts";
import { clearLock, reapStrayOb, writeLock } from "./lock.ts";
import { logger } from "../log.ts";

const log = logger("sync");

export type SyncState = "idle" | "starting" | "running" | "error" | "stopped";

const MAX_LOG_LINES = 500;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const HEALTHY_RESET_MS = 5 * 60_000;

/**
 * Supervises `ob sync --continuous` as a child process:
 * ring-buffer log capture, exponential-backoff restarts, desired-state
 * persistence (survives container restarts), and the SIGTERM→SIGKILL
 * shutdown dance (ob ignores SIGTERM — github.com/obsidianmd/obsidian-headless#25).
 */
export class SyncSupervisor {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private logLines: string[] = [];
  private state: SyncState = "idle";
  private lastError: string | null = null;
  private restartAttempts = 0;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    private config: Config,
    private db: Database,
  ) {}

  status() {
    return {
      state: this.state,
      pid: this.proc?.pid ?? null,
      lastError: this.lastError,
      restartAttempts: this.restartAttempts,
      desired: this.desiredRunning(),
      log: this.logLines.slice(-100),
    };
  }

  recentLog(lines = 100): string[] {
    return this.logLines.slice(-lines);
  }

  desiredRunning(): boolean {
    return getSetting(this.db, "sync_desired") === "1";
  }

  private setDesired(running: boolean) {
    setSetting(this.db, "sync_desired", running ? "1" : "0");
  }

  /** Called on boot: start if the user previously enabled sync. */
  autostart() {
    if (this.config.syncAutostart && this.desiredRunning()) {
      log.info("autostarting ob sync (desired state: running)");
      this.spawn();
    }
  }

  start() {
    this.setDesired(true);
    this.restartAttempts = 0;
    if (!this.proc) this.spawn();
  }

  async stop() {
    this.setDesired(false);
    await this.killProcess();
    this.state = "stopped";
  }

  async restart() {
    await this.killProcess();
    this.restartAttempts = 0;
    this.setDesired(true);
    this.spawn();
  }

  private appendLog(chunk: string) {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      this.logLines.push(`${new Date().toISOString()} ${line}`);
    }
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines = this.logLines.slice(-MAX_LOG_LINES);
    }
  }

  private spawn() {
    if (this.proc || this.stopping) return;
    this.state = "starting";
    this.lastError = null;
    this.startedAt = Date.now();
    // kill any ob left over from a prior run on this vault (HMR orphan, crash)
    reapStrayOb(this.config);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.config.obBin, "sync", "--path", this.config.vaultDir, "--continuous"], {
        env: obEnv(this.config),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      this.state = "error";
      this.lastError = `Could not launch '${this.config.obBin}': ${err instanceof Error ? err.message : err}`;
      this.appendLog(`[supervisor] ${this.lastError}`);
      log.error(this.lastError);
      return;
    }
    this.proc = proc;
    writeLock(this.config, proc.pid);
    this.state = "running";
    this.appendLog(`[supervisor] started ob sync --continuous (pid ${proc.pid})`);
    log.info(`ob sync started (pid ${proc.pid})`);

    void this.pipe(proc.stdout as ReadableStream);
    void this.pipe(proc.stderr as ReadableStream);

    void proc.exited.then((code) => {
      if (this.proc !== proc) return; // superseded
      this.proc = null;
      this.appendLog(`[supervisor] ob exited with code ${code}`);
      if (this.stopping || !this.desiredRunning()) {
        this.state = "stopped";
        return;
      }
      // unexpected exit → backoff restart
      if (Date.now() - this.startedAt > HEALTHY_RESET_MS) this.restartAttempts = 0;
      this.restartAttempts++;
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.restartAttempts - 1));
      this.state = "error";
      this.lastError = `ob exited with code ${code}; restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts})`;
      log.warn(this.lastError);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawn();
      }, delay);
    });
  }

  private async pipe(stream: ReadableStream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.appendLog(decoder.decode(value));
      }
    } catch {}
  }

  private async killProcess() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.kill("SIGTERM");
    const graceful = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), this.config.obKillGraceMs)),
    ]);
    if (!graceful) {
      this.appendLog("[supervisor] ob ignored SIGTERM; sending SIGKILL");
      log.warn("ob ignored SIGTERM; sending SIGKILL");
      proc.kill("SIGKILL");
      await proc.exited;
    }
    clearLock(this.config);
    this.appendLog("[supervisor] ob stopped");
  }

  /** Shutdown path for the whole server (does not change desired state). */
  async shutdown() {
    this.stopping = true;
    await this.killProcess();
  }
}
