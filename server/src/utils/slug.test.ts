import { describe, expect, it } from 'vitest';
import { slugify, withUniqueSuffix } from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugify('Acme & Sons, Inc.!!')).toBe('acme-sons-inc');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  --Acme--  ')).toBe('acme');
  });

  it('collapses repeated separators', () => {
    expect(slugify('Acme    Corp---LLC')).toBe('acme-corp-llc');
  });
});

describe('withUniqueSuffix', () => {
  it('appends a short random suffix', () => {
    expect(withUniqueSuffix('acme')).toMatch(/^acme-[a-z0-9]{6}$/);
  });

  it('produces different suffixes across calls', () => {
    const a = withUniqueSuffix('acme');
    const b = withUniqueSuffix('acme');

    expect(a).not.toBe(b);
  });
});
