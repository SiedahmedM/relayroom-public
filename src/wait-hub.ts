export class WaitHub {
  private listeners = new Map<string, Set<() => void>>();

  wait(roomId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        const roomListeners = this.listeners.get(roomId);
        roomListeners?.delete(finish);
        if (roomListeners?.size === 0) this.listeners.delete(roomId);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const roomListeners = this.listeners.get(roomId) ?? new Set<() => void>();
      roomListeners.add(finish);
      this.listeners.set(roomId, roomListeners);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  publish(roomId: string): void {
    for (const listener of this.listeners.get(roomId) ?? []) listener();
  }

  close(): void {
    for (const roomId of this.listeners.keys()) this.publish(roomId);
  }
}
