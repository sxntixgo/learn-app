// The shape of a new account's fields, in one place.
//
// These rules were written for the first-run bootstrap (auth/bootstrap.ts)
// and are now also what an invited registration is held to
// (invites/accept.ts). They are here rather than exported from bootstrap.ts
// because two callers make them a shared rule rather than one module's
// private detail — and because the failure worth engineering against is the
// second call site quietly accepting a handle or a password the first one
// would have refused.
//
// The patterns mirror what the database enforces (migration 0005:
// users_handle_url_safe), so a value that passes here cannot fail there.

export const MIN_PASSWORD_LENGTH = 12;
// Bounded so an Argon2id call site cannot be turned into a CPU exhaustion
// primitive by a megabyte-long "password".
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_DISPLAY_NAME_LENGTH = 80;

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}$/;

// Deliberately loose: real address validation is delivery, not a regex. This
// only rejects what is obviously not an address (the design has no SMTP at
// all — §13's "password recovery without SMTP").
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Handles appear at `/u/<handle>` (design §11) and in the API surface. These
// are held back so no account can claim a name that reads as platform
// infrastructure to another student.
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'assets',
  'help',
  'login',
  'logout',
  'me',
  'moderator',
  'public',
  'register',
  'root',
  'settings',
  'setup',
  'static',
  'support',
  'system',
  'u',
]);

/** Either the normalized value, or the message that explains the refusal. */
export type FieldResult = { ok: true; value: string } | { ok: false; message: string };

/** Normalizes and checks a handle. Same rule, same message, at every call site. */
export function parseHandle(label: string, raw: unknown): FieldResult {
  if (typeof raw !== 'string') return { ok: false, message: `${label}.handle is required.` };
  const handle = raw.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    return {
      ok: false,
      message: `${label}.handle must be 2-31 characters of a-z, 0-9, hyphen or underscore, starting with a letter or digit.`,
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { ok: false, message: `${label}.handle "${handle}" is reserved.` };
  }
  return { ok: true, value: handle };
}

/** Checks a password's length bounds. Never trims or normalizes it. */
export function parsePassword(label: string, raw: unknown): FieldResult {
  if (typeof raw !== 'string' || raw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `${label}.password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `${label}.password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return { ok: true, value: raw };
}
