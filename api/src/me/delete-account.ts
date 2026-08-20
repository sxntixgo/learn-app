import type pg from 'pg';

/**
 * Permanently deletes one account and everything personal to it.
 *
 * WHAT GOES, and by what mechanism: the row in `users`, and every table whose
 * FK to it is `on delete cascade` — progress, enrolments, quiz attempts,
 * exercise submissions (and, through the submission, the annotations and
 * rubric scores hanging off it), badges, degrees, profile visibility, roles,
 * refresh tokens, and the activity history.
 *
 * `activity_events` is the one that needs help. It is append-only by trigger
 * (migration 0004) AND cascades from `users`, which for most of this
 * project's life meant an account with any history could not be deleted at
 * all: Postgres issues a real DELETE to satisfy its own cascade and the
 * trigger refused it. Migration 0017 added the one carve-out this function
 * uses — `app.erasing_user`, set for this transaction and matched per row, so
 * the exception covers exactly this account and nobody else's history.
 *
 * WHAT SURVIVES, deliberately, de-attributed rather than deleted:
 *   - grades (`rubric_scores`) and inline feedback (`annotations`) this
 *     account left on OTHER people's submissions. Migration 0018 made these
 *     `set null`; before it, a teacher closing their account silently deleted
 *     their students' grades.
 *   - courses it owned, which become unowned and can be adopted (0007).
 *   - invites it issued, and the roles it granted.
 *   - `audit_log` rows describing what it did — a bare `actor_id` by design
 *     (0005), because an audit record must outlive the account it describes.
 *
 * The distinction throughout is whose data it is. Erasure removes what is
 * yours; it does not reach into other people's records to remove your name
 * from things you did to them.
 *
 * @returns true if an account was deleted, false if the id matched nothing.
 */
export async function deleteAccount(pool: pg.Pool, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    // Parameterised via set_config rather than string-interpolated into a
    // `set local`: SET does not take bind parameters, and this value reaches
    // it from a route. `true` scopes it to the transaction, exactly as
    // `set local` would.
    await client.query(`select set_config('app.erasing_user', $1, true)`, [userId]);

    const result = await client.query(`delete from users where id = $1`, [userId]);
    await client.query('commit');
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
