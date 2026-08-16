import { describe, expect, it } from 'vitest';
import { shortSha, statusLabel, summarizeImportCounts } from './imports';
import type { ImportCounts } from './api';

function counts(overrides: Partial<ImportCounts> = {}): ImportCounts {
  const zero = { created: 0, updated: 0, skipped: 0, archived: 0 };
  return { courses: { ...zero }, tracks: { ...zero }, modules: { ...zero }, lessons: { ...zero }, ...overrides };
}

describe('summarizeImportCounts', () => {
  it('reads "Nothing changed" when every count is zero', () => {
    expect(summarizeImportCounts(counts())).toBe('Nothing changed');
  });

  it('omits skipped and pluralizes correctly for a single created row', () => {
    const c = counts({ lessons: { created: 1, updated: 0, skipped: 5, archived: 0 } });
    expect(summarizeImportCounts(c)).toBe('1 created lesson');
  });

  it('joins multiple non-zero entity kinds', () => {
    const c = counts({
      courses: { created: 1, updated: 0, skipped: 0, archived: 0 },
      lessons: { created: 3, updated: 2, skipped: 0, archived: 1 },
    });
    expect(summarizeImportCounts(c)).toBe('1 created course · 3 created, 2 updated, 1 archived lessons');
  });
});

describe('shortSha', () => {
  it('shortens to 7 characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
  });

  it('passes null through', () => {
    expect(shortSha(null)).toBeNull();
  });
});

describe('statusLabel', () => {
  it('labels every known status', () => {
    expect(statusLabel('success')).toBe('Success');
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('running')).toBe('Running');
  });
});
