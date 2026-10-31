import { describe, expect, it } from 'vitest';

import {
  checkSignup, normalizeEmail, normalizeFullName,
} from '../../src/domain/profile.ts';

describe('profile', () => {
  it('collapses spaces in a name and refuses digits or a single letter', () => {
    expect(normalizeFullName("  Ravi   D'Souza-Kumar ")).toBe("Ravi D'Souza-Kumar");
    expect(normalizeFullName('रवि कुमार')).toBe('रवि कुमार');
    for (const bad of ['R', 'R2D2', '', '.Ravi']) expect(() => normalizeFullName(bad)).toThrow('Enter your full name.');
  });

  it('lower-cases an email and refuses malformed or overlong ones', () => {
    expect(normalizeEmail(' Ravi@Example.COM ')).toBe('ravi@example.com');
    for (const bad of ['ravi', 'ravi@example', `${'a'.repeat(200)}@b.co`]) expect(() => normalizeEmail(bad)).toThrow('Enter a valid email address.');
  });

  it('needs every consent ticked', () => {
    const form = { fullName: 'Ravi Kumar', email: 'r@x.co', consents: { terms: true, risk: true, dataUse: true } };
    expect(checkSignup(form)).toEqual({ fullName: 'Ravi Kumar', email: 'r@x.co' });
    for (const consents of [{ terms: false, risk: true, dataUse: true }, { terms: true, risk: true, dataUse: false }]) {
      expect(() => checkSignup({ ...form, consents })).toThrow('Please confirm each of the statements to create your account.');
    }
  });
});
