/**
 * Minimal postgres connection-string parsing shared by backup.ts and
 * restore.ts.
 *
 * Both need to invoke pg_dump/pg_restore, which take host/port/user/dbname
 * as separate flags. Passing the whole connection string (with an embedded
 * password) as a single CLI argument would put the password in argv, which
 * is visible to anything that can list processes on the host (`ps -ef`) and
 * would show up in any log line that captures the invoked command. Splitting
 * it lets the password travel only via `PGPASSWORD` in the child process's
 * environment, which pg_dump/pg_restore read directly and no shell or log
 * line ever sees.
 */
export interface PgConnectionParts {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function parseConnectionString(connectionString: string): PgConnectionParts {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error(`Connection string has no database name: ${redactConnectionString(connectionString)}`);
  }
  return {
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** The same connection string with the password blanked out — safe to print or log. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '***';
  }
}
