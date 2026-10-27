import { describe, expect, it } from 'vitest';

import { SignalParseError } from '../../src/domain/errors.ts';
import { SignalParser } from '../../src/domain/signal-parser.ts';
import { clock } from '../helpers.ts';

const parser = new SignalParser(clock);

describe('SignalParser', () => {
  it('parses the reference SENSEX signal', () => {
    const s = parser.parse('BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540, TGT2 600');
    expect(s).toMatchObject({
      action: 'BUY',
      underlying: 'SENSEX',
      expiry: '2026-10-29',
      strike: 73100,
      optionType: 'PE',
      entryLow: 400,
      entryHigh: 420,
      stopLoss: 300,
      targets: [540, 600],
      warnings: [],
    });
  });

  it('handles lowercase, @, explicit year, CE and slash targets', () => {
    const s = parser.parse('  sell nifty 30-oct-2026 24500 ce @ 120 to 125 sl 160 target 90/70 ');
    expect(s).toMatchObject({
      action: 'SELL',
      underlying: 'NIFTY',
      expiry: '2026-10-30',
      optionType: 'CE',
      entryLow: 120,
      entryHigh: 125,
      stopLoss: 160,
      targets: [90, 70],
      warnings: [],
    });
    expect(s.raw).toBe('sell nifty 30-oct-2026 24500 ce @ 120 to 125 sl 160 target 90/70');
  });

  it('rolls a past day/month into next year, using the date in India', () => {
    const s = parser.parse('BUY BANKNIFTY 2 JAN 52000 CALL AT 300 SL 250 TGT 360');
    expect(s.expiry).toBe('2027-01-02');
    expect([s.entryLow, s.entryHigh, s.targets]).toEqual([300, 300, [360]]);
    // 26 Oct 20:00 UTC is already 27 Oct in India, so "26 OCT" has passed.
    const lateUtc = new SignalParser(() => new Date('2026-10-26T20:00:00Z'));
    expect(lateUtc.parse('BUY NIFTY 26 OCT 24000 PE AT 100').expiry).toBe('2027-10-26');
    expect(lateUtc.parse('BUY NIFTY 27 OCT 24000 PE AT 100').expiry).toBe('2026-10-27');
  });

  it('accepts a two-digit year and swaps a reversed entry range', () => {
    const s = parser.parse('BUY NIFTY 30 OCT 26 24000 PE AT 110-100 SL 80');
    expect(s.expiry).toBe('2026-10-30');
    expect([s.entryLow, s.entryHigh]).toEqual([100, 110]);
  });

  it('does not confuse "TGT 540" with a target index', () => {
    expect(parser.parse('BUY SENSEX 29 OCT 73100 PE 400 SL 300 TGT 540 TARGET 2: 600').targets).toEqual([540, 600]);
  });

  it('targets before stop loss are not polluted by the SL value', () => {
    const s = parser.parse('BUY NIFTY 30 OCT 24000 PE AT 100 TGT 130, 150 SL 80');
    expect(s.targets).toEqual([130, 150]);
    expect(s.stopLoss).toBe(80);
  });

  it('warns about missing or misplaced stop loss and targets', () => {
    expect(parser.parse('BUY NIFTY 30 OCT 24000 PE AT 100').warnings).toEqual([
      'No stop loss found.',
      'No targets found.',
    ]);
    expect(parser.parse('BUY NIFTY 30 OCT 24000 PE AT 100 SL 120 TGT 90').warnings).toEqual([
      'Stop loss is on the wrong side of the entry price.',
      'A target is on the wrong side of the entry price.',
    ]);
    expect(parser.parse('SELL NIFTY 30 OCT 24000 PE AT 100 SL 90 TGT 120').warnings).toEqual([
      'Stop loss is on the wrong side of the entry price.',
      'A target is on the wrong side of the entry price.',
    ]);
  });

  it('rejects empty text, non-signals, missing entry and impossible dates', () => {
    expect(() => parser.parse('   ')).toThrow('Signal is empty.');
    expect(() => parser.parse('Good morning traders!')).toThrow(SignalParseError);
    expect(() => parser.parse('BUY NIFTY 30 OCT 24000 PE WITH SL 80')).toThrow('Could not find the entry price');
    expect(() => parser.parse('BUY NIFTY 31 NOV 24000 PE AT 100 SL 80')).toThrow('Invalid expiry date: 31/11/2026.');
  });

  it('defaults to the real clock', () => {
    expect(new SignalParser().parse('BUY NIFTY 30 OCT 2030 24000 PE AT 100').expiry).toBe('2030-10-30');
  });
});
