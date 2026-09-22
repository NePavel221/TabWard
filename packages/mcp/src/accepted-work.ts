export class AcceptedWorkTracker {
  #counts = new Map<string, number>();
  #waiters = new Map<string, Set<() => void>>();

  count(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.#counts.set(key, this.count(key) + 1);
    try {
      return await work();
    } finally {
      const remaining = Math.max(0, this.count(key) - 1);
      if (remaining === 0) {
        this.#counts.delete(key);
        for (const resolve of this.#waiters.get(key) ?? []) resolve();
        this.#waiters.delete(key);
      } else {
        this.#counts.set(key, remaining);
      }
    }
  }

  async wait(key: string): Promise<void> {
    if (this.count(key) === 0) return;
    await new Promise<void>((resolve) => {
      let waiters = this.#waiters.get(key);
      if (!waiters) {
        waiters = new Set();
        this.#waiters.set(key, waiters);
      }
      waiters.add(resolve);
    });
  }
}
