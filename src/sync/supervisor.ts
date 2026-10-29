import type { Config } from "../config.ts";
import type { VaultSettings } from "../db/index.ts";
import { obEnv } from "./ob.ts";
import { clearLock, reapStrayOb, writeLock } from "./lock.ts";
import { logger } from "../log.ts";

const log = logger("sync");

export type SyncState = "idle" | "starting" | "running" | "error" | "stopped";

const MAX_LOG_LINES = 500;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const HEALTHY_RESET_MS = 5 * 60_000;
// obsidian-headless keeps the process alive and logs "Fully synced" after the
// macOS watcher dies (obsidianmd/obsidian-headless#57) and can sit forever on
// "Connecting..." (#50). Exit-based restart never sees either failure.
const UPLOAD_STALL_MS = 90_000;
const CONNECT_STALL_MS = 120_000;

export interface SyncWatchdogOptions {
  uploadStallMs?: number;
  connectStallMs?: number;
}

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
  /** Bumped on every spawn and kill so log lines from a dead child are ignored. */
  private generation = 0;
  /** Set once this child has logged an upload or "Fully synced" (startup scan finished). */
  private scanSettled = false;
  /** Last log line said the sync socket is up. */
  private connected = false;
  /** Local edit still waiting for an "Uploading file" / "Upload complete" line. */
  private expectUploadSince: number | null = null;
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallRestarting = false;
  private readonly uploadStallMs: number;
  private readonly connectStallMs: number;

  constructor(
    private config: Config,
    private settings: VaultSettings,
    watchdog: SyncWatchdogOptions = {},
  ) {
    this.uploadStallMs = watchdog.uploadStallMs ?? UPLOAD_STALL_MS;
    this.connectStallMs = watchdog.connectStallMs ?? CONNECT_STALL_MS;
  }

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
    return this.settings.get("sync_desired") === "1";
  }

  private setDesired(running: boolean) {
    this.settings.set("sync_desired", running ? "1" : "0");
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

  /**
   * A local vault write (MCP). If `ob` is connected and the startup scan has
   * finished, an upload log line must follow or the watcher is presumed dead.
   */
  noteLocalChange(): void {
    if (this.stopping || !this.desiredRunning()) return;
    if (this.state !== "running" && this.state !== "starting") return;
    if (this.expectUploadSince != null) return;
    this.expectUploadSince = Date.now();
    this.scheduleUploadCheck();
  }

  private appendLog(chunk: string, generation: number | null = null) {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      this.logLines.push(`${new Date().toISOString()} ${line}`);
      if (generation === null || generation === this.generation) this.observeLine(line);
    }
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines = this.logLines.slice(-MAX_LOG_LINES);
    }
  }

  /** Watch ob's own log. "Fully synced" alone is not health — uploads are. */
  private observeLine(line: string) {
    if (line.includes("Uploading file") || line.includes("Upload complete")) {
      this.expectUploadSince = null;
      this.clearUploadTimer();
      this.scanSettled = true;
      this.connected = true;
      this.clearConnectTimer();
      this.restartAttempts = 0;
      return;
    }
    if (line.includes("Fully synced")) {
      this.scanSettled = true;
      this.connected = true;
      this.clearConnectTimer();
      this.scheduleUploadCheck();
      return;
    }
    if (line.includes("Connection successful")) {
      this.connected = true;
      this.clearConnectTimer();
      return;
    }
    if (
      line.includes("Disconnected from server") ||
      line.includes("Waiting to connect") ||
      line.includes("Connecting...")
    ) {
      this.connected = false;
      this.clearUploadTimer();
      this.armConnectTimer();
    }
  }

  private scheduleUploadCheck() {
    if (this.uploadTimer || this.expectUploadSince == null || this.stopping) return;
    if (!this.scanSettled || !this.connected) return;
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = null;
      if (this.expectUploadSince == null || !this.scanSettled || !this.connected) return;
      if (this.stopping || !this.desiredRunning() || this.state !== "running") return;
      void this.restartForStall("local change was not uploaded");
    }, this.uploadStallMs);
  }

  private armConnectTimer() {
    if (this.connectTimer || this.stopping) return;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.connected || this.stopping || !this.desiredRunning()) return;
      if (this.state !== "running") return;
      void this.restartForStall("ob stuck connecting");
    }, this.connectStallMs);
  }

  private clearUploadTimer() {
    if (!this.uploadTimer) return;
    clearTimeout(this.uploadTimer);
    this.uploadTimer = null;
  }

  private clearConnectTimer() {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearWatchTimers() {
    this.clearUploadTimer();
    this.clearConnectTimer();
  }

  /**
   * Same backoff as an unexpected exit. Does not clear desired state, and does
   * not reset the attempt counter the way a manual restart does — a watcher
   * that dies on every spawn has to slow down.
   */
  private async restartForStall(reason: string) {
    if (this.stallRestarting || this.stopping || !this.desiredRunning()) return;
    if (this.state !== "running" && this.state !== "starting") return;
    this.stallRestarting = true;
    this.clearWatchTimers();
    try {
      if (Date.now() - this.startedAt > HEALTHY_RESET_MS) this.restartAttempts = 0;
      this.restartAttempts++;
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.restartAttempts - 1));
      this.lastError = `${reason}; restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts})`;
      this.appendLog(`[supervisor] ${this.lastError}`);
      log.warn(this.lastError);
      await this.killProcess();
      if (this.stopping || !this.desiredRunning()) {
        this.state = "stopped";
        return;
      }
      this.state = "error";
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawn();
      }, delay);
    } finally {
      this.stallRestarting = false;
    }
  }

  private spawn() {
    if (this.proc || this.stopping) return;
    this.state = "starting";
    this.lastError = null;
    this.startedAt = Date.now();
    this.scanSettled = false;
    this.connected = false;
    this.expectUploadSince = null;
    this.clearWatchTimers();
    const generation = ++this.generation;
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
    this.armConnectTimer();

    void this.pipe(proc.stdout as ReadableStream, generation);
    void this.pipe(proc.stderr as ReadableStream, generation);

    void proc.exited.then((code) => {
      if (this.proc !== proc) return; // superseded
      this.proc = null;
      this.clearWatchTimers();
      this.scanSettled = false;
      this.connected = false;
      this.expectUploadSince = null;
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

  private async pipe(stream: ReadableStream, generation: number) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.appendLog(decoder.decode(value), generation);
      }
    } catch {}
  }

  private async killProcess() {
    this.generation++;
    this.clearWatchTimers();
    this.scanSettled = false;
    this.connected = false;
    this.expectUploadSince = null;
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
