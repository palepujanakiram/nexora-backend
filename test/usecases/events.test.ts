import { describe, expect, it } from 'vitest';

import { EventBus, type StreamEvent } from '../../src/usecases/events.ts';

const event: StreamEvent = { type: 'entitlement', mode: 'full' };

describe('EventBus', () => {
  it('delivers to every listener of that user only', () => {
    const bus = new EventBus();
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const other: StreamEvent[] = [];
    bus.subscribe('usr_1', (e) => a.push(e));
    bus.subscribe('usr_1', (e) => b.push(e));
    bus.subscribe('usr_2', (e) => other.push(e));
    bus.publish('usr_1', event);
    expect(a).toEqual([event]);
    expect(b).toEqual([event]);
    expect(other).toEqual([]);
    expect(bus.listenerCount('usr_1')).toBe(2);
  });

  it('keeps delivering when one listener throws', () => {
    const bus = new EventBus();
    const got: StreamEvent[] = [];
    bus.subscribe('usr_1', () => {
      throw new Error('socket closed');
    });
    bus.subscribe('usr_1', (e) => got.push(e));
    expect(() => bus.publish('usr_1', event)).not.toThrow();
    expect(got).toEqual([event]);
  });

  it('unsubscribes, and forgets users without listeners', () => {
    const bus = new EventBus();
    const got: StreamEvent[] = [];
    const off1 = bus.subscribe('usr_1', (e) => got.push(e));
    const off2 = bus.subscribe('usr_1', () => {});
    off1();
    expect(bus.listenerCount('usr_1')).toBe(1);
    off2();
    expect(bus.listenerCount('usr_1')).toBe(0);
    bus.publish('usr_1', event);
    bus.publish('usr_nobody', event);
    expect(got).toEqual([]);
  });
});
