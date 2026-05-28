// server/src/modules/auth/auth.validation.test.ts
import { describe, it, expect } from 'vitest';
import { isValidAccountName, isReservedAccountName } from './auth.validation.js';

describe('isValidAccountName', () => {
  it('accepts lowercase letters and digits', () => {
    expect(isValidAccountName('john123')).toBe(true);
  });
  it('accepts underscore, hyphen, dot, colon', () => {
    expect(isValidAccountName('j.ohn_do-e:1')).toBe(true);
  });
  it('rejects uppercase letters', () => {
    expect(isValidAccountName('John')).toBe(false);
  });
  it('rejects too short', () => {
    expect(isValidAccountName('ab')).toBe(false);
  });
  it('rejects too long', () => {
    expect(isValidAccountName('a'.repeat(31))).toBe(false);
  });
  it('rejects spaces', () => {
    expect(isValidAccountName('john doe')).toBe(false);
  });
});

describe('isReservedAccountName', () => {
  it('flags reserved words', () => {
    expect(isReservedAccountName('admin')).toBe(true);
    expect(isReservedAccountName('lists')).toBe(true);
    expect(isReservedAccountName('home')).toBe(true);
  });
  it('allows normal usernames', () => {
    expect(isReservedAccountName('alice')).toBe(false);
    expect(isReservedAccountName('john.doe')).toBe(false);
  });
});
