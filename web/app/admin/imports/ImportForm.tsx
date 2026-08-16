'use client';

/*
 * The import form + live progress area (design plan phase 5). POSTs to the
 * same-origin proxy (./stream/route.ts), which forwards to the API's
 * streamed POST /api/v1/admin/imports and pipes the newline-delimited JSON
 * body straight back — this component reads it chunk by chunk with the
 * Streams API rather than waiting for the whole response, since the whole
 * point of streaming is showing progress before the import finishes.
 *
 * ImportHistory below (a server component, rendered by the page) is
 * refreshed via router.refresh() once the stream ends, success or failure —
 * design brief: "A failed import must still leave an import_runs row",
 * and this is what makes that row show up without a manual reload.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ImportProgressEvent } from '../../../src/lib/api';
import styles from './imports.module.css';

const STAGE_ORDER: ImportProgressEvent['stage'][] = ['cloning', 'validating', 'parsing', 'writing'];

const STAGE_LABELS: Record<ImportProgressEvent['stage'], string> = {
  cloning: 'Cloning',
  validating: 'Validating',
  parsing: 'Parsing',
  writing: 'Writing',
  done: 'Done',
  failed: 'Failed',
};

type StageStatus = 'pending' | 'active' | 'complete' | 'failed';

function stageStatus(stage: ImportProgressEvent['stage'], events: ImportProgressEvent[]): StageStatus {
  const index = STAGE_ORDER.indexOf(stage);
  const reachedIndex = STAGE_ORDER.reduce(
    (acc, s, i) => (events.some((e) => e.stage === s) ? i : acc),
    -1,
  );
  const terminal = events.find((e) => e.stage === 'done' || e.stage === 'failed');

  if (index < reachedIndex) return 'complete';
  if (index > reachedIndex) return 'pending';
  // index === reachedIndex: this is the furthest stage reached so far.
  if (terminal?.stage === 'done') return 'complete';
  if (terminal?.stage === 'failed') return 'failed';
  return 'active';
}

/** Parses complete NDJSON lines out of `buffer`, returning the parsed events and whatever partial line is left. */
function parseNdjsonChunk(buffer: string): { events: ImportProgressEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events = lines.filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as ImportProgressEvent);
  return { events, rest };
}

export default function ImportForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [events, setEvents] = useState<ImportProgressEvent[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const bufferRef = useRef('');

  const terminal = events.find((e) => e.stage === 'done' || e.stage === 'failed');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setEvents([]);
    setRequestError(null);
    bufferRef.current = '';

    try {
      const res = await fetch('/admin/imports/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, ref: ref.trim() === '' ? undefined : ref.trim() }),
      });

      if (!res.ok || !res.body) {
        const parsed = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(parsed?.message ?? `Import request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bufferRef.current += decoder.decode(value, { stream: true });
        const { events: newEvents, rest } = parseNdjsonChunk(bufferRef.current);
        bufferRef.current = rest;
        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents]);
        }
      }
      if (bufferRef.current.trim() !== '') {
        setEvents((prev) => [...prev, JSON.parse(bufferRef.current) as ImportProgressEvent]);
      }

      router.refresh();
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'The import request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.formSection}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="import-url">
            Repository URL
          </label>
          <input
            id="import-url"
            name="url"
            type="url"
            required
            placeholder="https://github.com/org/course-repo.git"
            className={styles.input}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="import-ref">
            Ref <span className={styles.optional}>(optional — defaults to the repo&rsquo;s default branch)</span>
          </label>
          <input
            id="import-ref"
            name="ref"
            type="text"
            placeholder="main"
            className={styles.input}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            disabled={submitting}
          />
        </div>

        <button type="submit" className={styles.submitButton} disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Importing…' : 'Import'}
        </button>
      </form>

      {requestError ? (
        <p className={styles.requestError} role="alert">
          {requestError}
        </p>
      ) : null}

      {events.length > 0 ? (
        <div className={styles.progress} aria-live="polite">
          <ol className={styles.steps}>
            {STAGE_ORDER.map((stage) => {
              const status = stageStatus(stage, events);
              return (
                <li key={stage} className={styles.step} data-status={status}>
                  <span className={styles.stepMarker} aria-hidden="true" />
                  <span className={styles.stepLabel}>{STAGE_LABELS[stage]}</span>
                </li>
              );
            })}
          </ol>

          {terminal?.stage === 'done' ? (
            <p className={styles.resultDone}>
              Imported <strong>{terminal.slug}</strong>
              {terminal.commitSha ? (
                <>
                  {' '}
                  at <code>{terminal.commitSha.slice(0, 7)}</code>
                </>
              ) : null}
              .
            </p>
          ) : null}

          {terminal?.stage === 'failed' ? (
            <div className={styles.resultFailed}>
              <p className={styles.resultFailedTitle}>
                Import failed{terminal.problems ? ` — ${terminal.problems.length} problem(s)` : ''}:
              </p>
              <ul className={styles.problemList}>
                {(terminal.problems ?? []).map((problem, index) => (
                  <li key={`${terminal.importRunId ?? 'run'}-problem-${index}`}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
