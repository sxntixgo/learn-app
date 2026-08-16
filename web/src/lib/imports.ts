/*
 * Pure formatting helpers for the admin import history screen, kept out of
 * the component so they're testable without a browser (same split as
 * src/lib/activity.ts).
 */

import type { ImportCounts, ImportRunSummary } from './api';

const ENTITY_LABELS: Array<{ key: keyof ImportCounts; label: string }> = [
  { key: 'courses', label: 'course' },
  { key: 'tracks', label: 'track' },
  { key: 'modules', label: 'module' },
  { key: 'lessons', label: 'lesson' },
];

/**
 * A compact one-line summary of a successful import's counts, e.g.
 * "3 lessons created, 1 updated, 2 archived" — entity kinds untouched by
 * this run (every count 0) are omitted entirely, and within a kind only the
 * non-zero buckets are named, so an unchanged re-import reads as "Nothing
 * changed" rather than a wall of zeroes.
 */
export function summarizeImportCounts(counts: ImportCounts): string {
  const parts: string[] = [];

  for (const { key, label } of ENTITY_LABELS) {
    const c = counts[key];
    const bits: string[] = [];
    if (c.created > 0) bits.push(`${c.created} created`);
    if (c.updated > 0) bits.push(`${c.updated} updated`);
    if (c.archived > 0) bits.push(`${c.archived} archived`);
    if (bits.length === 0) continue;
    parts.push(`${bits.join(', ')} ${label}${c.created + c.updated + c.archived === 1 ? '' : 's'}`);
  }

  return parts.length === 0 ? 'Nothing changed' : parts.join(' · ');
}

/** Shortens a git commit sha to its conventional 7-character display form, or null through unchanged. */
export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, 7);
}

/** A short, human label for an import_runs row's status, for a status pill. */
export function statusLabel(status: ImportRunSummary['status']): string {
  switch (status) {
    case 'success':
      return 'Success';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Running';
    default:
      return status;
  }
}
