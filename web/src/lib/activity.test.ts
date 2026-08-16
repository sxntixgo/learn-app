import { describe, it, expect } from 'vitest';
import { formatActivityLine, formatOccurredAt, formatRelativeTime } from './activity';
import type { ActivityEvent } from './api';

const COURSE = { slug: 'claude-code-docs', title: 'Claude Code Docs' };
const LESSON = { slug: 'getting-started', title: 'Getting started' };

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    type: 'lesson_completed',
    occurredAt: '2026-08-15T12:00:00.000Z',
    course: COURSE,
    lesson: LESSON,
    ...overrides,
  };
}

describe('formatActivityLine', () => {
  it('describes a completed lesson and links to it', () => {
    const line = formatActivityLine(event({ type: 'lesson_completed' }));
    expect(line.text).toBe('Completed “Getting started” in Claude Code Docs');
    expect(line.href).toBe('/courses/claude-code-docs/lessons/getting-started');
  });

  it('handles every documented event type without throwing, course+lesson present', () => {
    const types: ActivityEvent['type'][] = [
      'lesson_completed',
      'exercise_submitted',
      'exercise_returned',
      'quiz_passed',
      'course_enrolled',
      'course_completed',
      'degree_earned',
      'badge_awarded',
    ];
    for (const type of types) {
      const line = formatActivityLine(event({ type }));
      expect(line.text.length).toBeGreaterThan(0);
    }
  });

  it('links only when a lesson is present (course-only events do not link)', () => {
    const enrolled = formatActivityLine(event({ type: 'course_enrolled', lesson: null }));
    expect(enrolled.href).toBeNull();
    expect(enrolled.text).toContain('Claude Code Docs');
  });

  it('renders sensibly when course and lesson are both null (degree/badge events)', () => {
    const line = formatActivityLine(event({ type: 'degree_earned', course: null, lesson: null }));
    expect(line.text).toBe('Earned a degree');
    expect(line.href).toBeNull();
  });

  it('degrades an unrecognised type to a readable generic line instead of throwing', () => {
    const line = formatActivityLine(event({ type: 'mystery_event' as ActivityEvent['type'] }));
    expect(line.text).toContain('Mystery event');
    expect(line.text).not.toContain('undefined');
  });

  it('never crashes when course/lesson are null for a normally-lesson-scoped type', () => {
    expect(() => formatActivityLine(event({ type: 'exercise_submitted', course: null, lesson: null }))).not.toThrow();
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');

  it('renders "just now" for events seconds old', () => {
    expect(formatRelativeTime('2026-08-15T11:59:45.000Z', now)).toBe('just now');
  });

  it('renders whole minutes', () => {
    expect(formatRelativeTime('2026-08-15T11:58:00.000Z', now)).toBe('2 minutes ago');
  });

  it('renders whole days, matching the task example', () => {
    expect(formatRelativeTime('2026-08-13T12:00:00.000Z', now)).toBe('2 days ago');
  });

  it('singularizes the unit at exactly 1', () => {
    expect(formatRelativeTime('2026-08-14T12:00:00.000Z', now)).toBe('1 day ago');
  });
});

describe('formatOccurredAt', () => {
  const now = new Date('2026-08-15T12:00:00.000Z');

  it('renders an absolute date in the given timezone, not UTC or the host zone', () => {
    // 06:00 in Denver (Mountain Daylight Time, UTC-6 in August) for a 12:00 UTC instant.
    const result = formatOccurredAt('2026-08-15T12:00:00.000Z', 'America/Denver', now);
    expect(result.absolute).toContain('2026');
    expect(result.absolute).toMatch(/6:00\s*AM/);
    expect(result.relative).toBe('just now');
    expect(result.iso).toBe('2026-08-15T12:00:00.000Z');
  });

  it('falls back sensibly for UTC', () => {
    const result = formatOccurredAt('2026-08-13T12:00:00.000Z', 'UTC', now);
    expect(result.absolute).toMatch(/12:00\s*PM/);
    expect(result.relative).toBe('2 days ago');
  });
});
