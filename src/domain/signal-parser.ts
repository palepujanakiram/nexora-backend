import { SignalParseError } from './errors.ts';
import { must } from './invariant.ts';
import { istDate } from './ist.ts';
import { normalizeSignalText, type TradeSignal } from './signal.ts';

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const NUM = String.raw`(\d+(?:\.\d+)?)`;

const HEAD = new RegExp(
  String.raw`\b(BUY|SELL)\s+([A-Z][A-Z0-9&]*)\s+` +
    String.raw`(\d{1,2})(?:ST|ND|RD|TH)?[\s\-/]*` +
    String.raw`(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?` +
    String.raw`(?:[\s\-/]*(\d{4}|\d{2}))?\s+` +
    `${NUM}\\s*(CE|PE|CALL|PUT)\\b`,
);
const ENTRY = new RegExp(
  String.raw`^\s*(?:(?:AT|@|ABOVE|NEAR|AROUND|BETWEEN|RANGE|CMP)\s*:?\s*)?` +
    `${NUM}(?:\\s*(?:-|TO|/|AND)\\s*${NUM})?`,
);
const SL = new RegExp(String.raw`\b(?:SL|STOP\s*LOSS|STOPLOSS)\s*(?:OF|IS|AT|:|-|@|=)?\s*:?\s*` + NUM);
const TARGET_KEYWORD = /\b(?:TGT|TARGETS?|TP)/;
const TARGET_LABEL = /\b(?:TGT|TARGETS?|TP)\s*(?:\d{1,2}\s*[:=\-)]|\d{1,2}\b(?=\s))?/g;
const SL_TAIL = /\b(?:SL|STOP\s*LOSS|STOPLOSS)\b.*$/;
const NUMBERS = new RegExp(NUM, 'g');

/**
 * Parses free-text option signals such as:
 *
 *   BUY SENSEX 29 OCT 73100 PUT AT 400-420 WITH SL OF 300 TGT1 540, TGT2 600
 *   SELL NIFTY 30-OCT-2026 24500 CE @ 120 TO 125 SL 160 TARGET 90/70
 *
 * When the year is omitted, the next occurrence of that day/month (today in
 * India included) is used. Mirrors `SignalParser` in nexora-app.
 */
export class SignalParser {
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  parse(input: string): TradeSignal {
    const text = normalizeSignalText(input);
    if (!text) throw new SignalParseError('Signal is empty.');

    const head = HEAD.exec(text);
    if (!head) {
      throw new SignalParseError(
        'Could not find "<BUY|SELL> <SYMBOL> <DD> <MON> <STRIKE> <CALL|PUT>" in the signal.',
      );
    }
    const [, actionText, underlying = '', dayText, monthText = '', yearText, strikeText, typeText] = head;
    const action = actionText === 'BUY' ? 'BUY' : 'SELL';
    const expiry = this.expiry(Number(dayText), must(MONTHS[monthText], 'a month the pattern matched'), yearText);
    const optionType = typeText === 'CE' || typeText === 'CALL' ? 'CE' : 'PE';

    const tail = text.slice(head.index + head[0].length);
    const entry = ENTRY.exec(tail);
    if (!entry) throw new SignalParseError('Could not find the entry price (e.g. "AT 400-420").');
    let low = Number(entry[1]);
    let high = entry[2] !== undefined ? Number(entry[2]) : low;
    if (low > high) [low, high] = [high, low];

    const slMatch = SL.exec(tail);
    const stopLoss = slMatch ? Number(slMatch[1]) : null;

    const targets: number[] = [];
    const tgtStart = TARGET_KEYWORD.exec(tail);
    if (tgtStart) {
      const section = tail.slice(tgtStart.index).replace(SL_TAIL, ' ').replace(TARGET_LABEL, ' ');
      for (const m of section.matchAll(NUMBERS)) targets.push(Number(m[1]));
    }

    const buy = action === 'BUY';
    const warnings: string[] = [];
    if (stopLoss === null) warnings.push('No stop loss found.');
    if (targets.length === 0) warnings.push('No targets found.');
    if (stopLoss !== null && (buy ? stopLoss >= low : stopLoss <= high)) {
      warnings.push('Stop loss is on the wrong side of the entry price.');
    }
    if (targets.some((t) => (buy ? t <= high : t >= low))) {
      warnings.push('A target is on the wrong side of the entry price.');
    }

    return {
      action,
      underlying,
      expiry,
      strike: Number(strikeText),
      optionType,
      entryLow: low,
      entryHigh: high,
      stopLoss,
      targets,
      raw: input.trim(),
      warnings,
    };
  }

  private expiry(day: number, month: number, yearText: string | undefined): string {
    const today = istDate(this.clock());
    let year: number;
    if (yearText !== undefined) {
      year = Number(yearText);
      if (year < 100) year += 2000;
    } else {
      year = Number(today.slice(0, 4));
      if (isoDate(year, month, day) < today) year++;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new SignalParseError(`Invalid expiry date: ${day}/${month}/${year}.`);
    }
    return isoDate(year, month, day);
  }
}

const isoDate = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
