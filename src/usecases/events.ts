/** Something a user's devices should hear about at once, over `/stream`. */
export type StreamEvent =
  | { type: 'leg'; parentOrderId: string; parentStatus: string; leg: Record<string, unknown> }
  | { type: 'relink_needed'; accountId: string; broker: string; message: string }
  | { type: 'entitlement'; mode: string };

export type Listener = (event: StreamEvent) => void;

/**
 * In-process publish/subscribe per user. One server process today; with
 * several, this becomes a Postgres LISTEN/NOTIFY or NATS subject per user.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set();
    set.add(listener);
    this.listeners.set(userId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(userId);
    };
  }

  publish(userId: string, event: StreamEvent): void {
    for (const listener of this.listeners.get(userId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken socket must not stop the others, or the caller.
      }
    }
  }

  listenerCount(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}
