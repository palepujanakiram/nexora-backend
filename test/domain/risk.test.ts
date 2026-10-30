import { describe, expect, it } from 'vitest';

import { marketOpen } from '../../src/domain/risk.ts';
import { NOW } from '../helpers.ts';

/** A moment on Tue 27 Oct 2026 at [hhmm] IST, or on [date] when given. */
const ist = (hhmm: string, date = '2026-10-27') => new Date(`${date}T${hhmm}:00+05:30`);

describe('marketOpen', () => {
  it('is open for equity and F&O between 09:15 and 15:30 IST', () => {
    for (const ex of ['NSE', 'BSE', 'NFO', 'BFO'] as const) {
      expect(marketOpen(ex, NOW, false)).toBe(true);
      expect(marketOpen(ex, ist('09:14'), false)).toBe(false);
      expect(marketOpen(ex, ist('09:15'), false)).toBe(true);
      expect(marketOpen(ex, ist('15:29'), false)).toBe(true);
      expect(marketOpen(ex, ist('15:30'), false)).toBe(false);
    }
  });

  it('uses the currency and commodity sessions', () => {
    expect(marketOpen('CDS', ist('09:00'), false)).toBe(true);
    expect(marketOpen('CDS', ist('08:59'), false)).toBe(false);
    expect(marketOpen('CDS', ist('16:59'), false)).toBe(true);
    expect(marketOpen('CDS', ist('17:00'), false)).toBe(false);
    expect(marketOpen('MCX', ist('09:00'), false)).toBe(true);
    expect(marketOpen('MCX', ist('23:29'), false)).toBe(true);
    expect(marketOpen('MCX', ist('23:30'), false)).toBe(false);
    expect(marketOpen('NSE', ist('20:00'), false)).toBe(false);
  });

  it('is closed on weekends and holidays', () => {
    expect(marketOpen('NSE', NOW, true)).toBe(false);
    expect(marketOpen('MCX', ist('12:00', '2026-10-31'), false)).toBe(false); // Saturday
    expect(marketOpen('NSE', ist('12:00', '2026-11-01'), false)).toBe(false); // Sunday
    expect(marketOpen('NSE', ist('12:00', '2026-10-30'), false)).toBe(true); // Friday
  });
});
