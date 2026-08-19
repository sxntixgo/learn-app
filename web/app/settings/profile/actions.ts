'use server';

/*
 * The profile settings screen's one Server Action (design §11). Same shape
 * as the other actions.ts files in this app: it runs on the Next.js server,
 * so the browser never talks to the API directly and web never needs
 * DATABASE_URL (CLAUDE.md rule 1).
 *
 * It sends a PARTIAL update — only the fields the form changed — because the
 * API treats an omitted field as "leave it alone". Sending the whole object
 * back every time would let a stale form quietly re-open a section its owner
 * closed in another tab.
 */

import { updateProfileSettings } from '../../../src/lib/api';
import type { ProfileSettings, ProfileSettingsUpdateRequest } from '../../../src/lib/api';

export type SaveProfileSettingsResult = { ok: true; settings: ProfileSettings } | { ok: false; message: string };

export async function saveProfileSettingsAction(
  update: ProfileSettingsUpdateRequest,
): Promise<SaveProfileSettingsResult> {
  try {
    return { ok: true, settings: await updateProfileSettings(update) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not save your profile settings.' };
  }
}
