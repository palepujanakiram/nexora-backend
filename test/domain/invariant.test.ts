import { describe, expect, it } from 'vitest';

import { must, single } from '../../src/domain/invariant.ts';

describe('must', () => {
  it('returns present values, including falsy ones', () => {
    expect(must(0, 'a count')).toBe(0);
    expect(must('', 'a label')).toBe('');
    expect(must(false, 'a flag')).toBe(false);
  });

  it('throws an internal error naming what was missing', () => {
    expect(() => must(null, 'the parent order')).toThrow('Internal error: expected the parent order.');
    expect(() => {
      must(undefined, 'a session');
    }).toThrow('Internal error: expected a session.');
  });
});

describe('single', () => {
  it('returns the first row, or throws when there is none', () => {
    expect(single([{ n: 3 }], 'a count')).toEqual({ n: 3 });
    expect(() => single([], 'a count')).toThrow('expected a count');
  });
});
