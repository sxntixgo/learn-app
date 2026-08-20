import type pg from 'pg';

/**
 * Everything the instance holds about one account, for data portability
 * (plan: "Account deletion and data export").
 *
 * Two decisions worth stating:
 *
 * 1. IT INCLUDES THE EMAIL. Gate 12 asks that no endpoint return an email
 *    address to an UNAUTHENTICATED caller; this endpoint returns your own
 *    record to you, gated by `me:export` + SELF, and an export that omits the
 *    address the account is identified by is not an export. The route is what
 *    keeps that true — there is no `userId` parameter here to point at
 *    somebody else.
 *
 * 2. THE COLLECTIONS ARE RETURNED AS STORED, not remapped into the API's
 *    response vocabulary. An export exists to be complete, and every mapping
 *    layer is another place a field can be quietly dropped when a migration
 *    adds one. `profile` is the exception: it is assembled by hand because it
 *    spans columns that are not all meant to leave the database (the password
 *    hash, most obviously, which must never appear here).
 */

export interface AccountExportProfile {
  id: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  bio: string | null;
  timezone: string | null;
  createdAt: string;
  roles: string[];
}

export interface AccountExport {
  exportedAt: string;
  profile: AccountExportProfile;
  enrolments: Record<string, unknown>[];
  progress: Record<string, unknown>[];
  quizAttempts: Record<string, unknown>[];
  submissions: Record<string, unknown>[];
  badges: Record<string, unknown>[];
  degrees: Record<string, unknown>[];
  activity: Record<string, unknown>[];
}

interface UserRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  email: string | null;
  bio: string | null;
  timezone: string | null;
  created_at: Date;
}

/**
 * Columns selected explicitly, never `select *`: `users` also holds
 * `password_hash`, and a `select *` here would put it in a file the account
 * holder downloads and may well email to somebody.
 */
const PROFILE_SQL = `
  select id, handle, display_name, email, bio, timezone, created_at
    from users
   where id = $1
`;

const COLLECTIONS: readonly { key: keyof Omit<AccountExport, 'exportedAt' | 'profile'>; sql: string }[] = [
  {
    key: 'enrolments',
    sql: `select c.slug as course_slug, e.status, e.enrolled_at
            from enrollments e join courses c on c.id = e.course_id
           where e.user_id = $1 order by e.enrolled_at`,
  },
  {
    key: 'progress',
    sql: `select l.slug as lesson_slug, p.state, p.completed_at, p.last_position, p.seconds_spent, p.updated_at
            from lesson_progress p join lessons l on l.id = p.lesson_id
           where p.user_id = $1 order by p.updated_at`,
  },
  {
    key: 'quizAttempts',
    sql: `select l.slug as lesson_slug, q.*
            from quiz_attempts q join lessons l on l.id = q.lesson_id
           where q.user_id = $1 order by q.created_at`,
  },
  {
    key: 'submissions',
    sql: `select l.slug as lesson_slug, s.id, s.status, s.snapshot, s.snapshot_hash,
                 s.submitted_at, s.returned_at, s.created_at, s.updated_at
            from exercise_submissions s join lessons l on l.id = s.lesson_id
           where s.user_id = $1 order by s.created_at`,
  },
  {
    key: 'badges',
    sql: `select b.slug, b.title, ub.awarded_at
            from user_badges ub join badges b on b.id = ub.badge_id
           where ub.user_id = $1 order by ub.awarded_at`,
  },
  {
    key: 'degrees',
    sql: `select d.slug, d.title, ud.awarded_at
            from user_degrees ud join degrees d on d.id = ud.degree_id
           where ud.user_id = $1 order by ud.awarded_at`,
  },
  {
    key: 'activity',
    sql: `select type, occurred_at, meta from activity_events
           where user_id = $1 order by occurred_at`,
  },
];

/**
 * Builds the export for `userId`. Returns null when no such account exists,
 * so a route can answer 404/403 rather than shipping an empty document that
 * looks like a real (but empty) account.
 */
export async function exportAccount(pool: pg.Pool, userId: string): Promise<AccountExport | null> {
  const user = await pool.query<UserRow>(PROFILE_SQL, [userId]);
  const row = user.rows[0];
  if (!row) return null;

  const roles = await pool.query<{ role: string }>(`select role from user_roles where user_id = $1 order by role`, [
    userId,
  ]);

  const collections = {} as Record<string, Record<string, unknown>[]>;
  for (const { key, sql } of COLLECTIONS) {
    const result = await pool.query(sql, [userId]);
    collections[key] = result.rows as Record<string, unknown>[];
  }

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      email: row.email,
      bio: row.bio,
      timezone: row.timezone,
      createdAt: row.created_at.toISOString(),
      roles: roles.rows.map((r) => r.role),
    },
    ...(collections as unknown as Omit<AccountExport, 'exportedAt' | 'profile'>),
  };
}
