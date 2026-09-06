import { describe, it, expect } from 'vitest';
import { catalogTags, filterCoursesByTag, type Taggable } from './catalog';

function course(tags: string[]): Taggable {
  return { tags };
}

describe('catalogTags', () => {
  it('is empty for no courses', () => {
    expect(catalogTags([])).toEqual([]);
  });

  it('is empty when every course is untagged', () => {
    expect(catalogTags([course([]), course([])])).toEqual([]);
  });

  it('dedupes a tag shared across courses', () => {
    expect(catalogTags([course(['algorithms']), course(['algorithms', 'python'])])).toEqual(['algorithms', 'python']);
  });

  it('sorts case-sensibly and locale-aware, not insertion order', () => {
    expect(catalogTags([course(['python']), course(['Algorithms'])])).toEqual(['Algorithms', 'python']);
  });
});

describe('filterCoursesByTag', () => {
  const algo = { slug: 'algo', tags: ['algorithms', 'python'] };
  const web = { slug: 'web', tags: ['web'] };
  const untagged = { slug: 'untagged', tags: [] };
  const all = [algo, web, untagged];

  it('returns every course, in order, when the tag is null (the "All courses" chip)', () => {
    expect(filterCoursesByTag(all, null)).toEqual(all);
  });

  it('returns a NEW array for null too, not the same reference — callers may mutate it', () => {
    expect(filterCoursesByTag(all, null)).not.toBe(all);
  });

  it('keeps only courses carrying the given tag', () => {
    expect(filterCoursesByTag(all, 'algorithms')).toEqual([algo]);
  });

  it('a tag shared by more than one course keeps all of them, in their original order', () => {
    const pythonToo = { slug: 'python-too', tags: ['python'] };
    expect(filterCoursesByTag([algo, pythonToo, web], 'python')).toEqual([algo, pythonToo]);
  });

  it('a tag no course carries narrows to empty rather than throwing', () => {
    expect(filterCoursesByTag(all, 'nonexistent-tag')).toEqual([]);
  });

  it('never matches the untagged course against any real tag', () => {
    expect(filterCoursesByTag(all, 'web')).toEqual([web]);
  });
});
