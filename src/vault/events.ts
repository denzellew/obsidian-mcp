export interface VaultMutation {
  /** Tool-level reason, e.g. "edit_note Projects/Foo.md" */
  reason: string;
  /** Paths touched, vault-relative */
  paths: string[];
  /** True for ops where a pre-mutation snapshot should be taken synchronously */
  risky?: boolean;
}

type Listener = (m: VaultMutation) => void | Promise<void>;

export class VaultEvents {
  private listeners = new Set<Listener>();
  /** Listeners invoked BEFORE a risky mutation is applied (pre-op snapshot). */
  private preListeners = new Set<Listener>();

  onMutation(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onBeforeRiskyMutation(fn: Listener): () => void {
    this.preListeners.add(fn);
    return () => this.preListeners.delete(fn);
  }

  async emitBeforeRisky(m: VaultMutation) {
    for (const fn of this.preListeners) await fn(m);
  }

  async emitMutation(m: VaultMutation) {
    for (const fn of this.listeners) await fn(m);
  }
}
