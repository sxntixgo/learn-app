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

import { removeAvatar, updateProfileSettings, uploadAvatar } from '../../../src/lib/api';
import type { ProfileAvatar, ProfileSettings, ProfileSettingsUpdateRequest } from '../../../src/lib/api';
import { revalidatePath } from 'next/cache';

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

export type AvatarResult = { ok: true; avatar: ProfileAvatar } | { ok: false; message: string };

/**
 * Uploads the chosen file (§11.1).
 *
 * Takes FormData rather than bytes because a Server Action is what the form
 * posts to, and a `File` is what an `<input type="file">` puts in it. The
 * bytes go on to the API as a raw body — see src/lib/api.ts's `uploadAvatar`
 * for why there is no multipart envelope beyond this point.
 */
export async function uploadAvatarAction(formData: FormData): Promise<AvatarResult> {
  const file = formData.get('avatar');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an image first.' };
  }

  try {
    const avatar = await uploadAvatar(await file.arrayBuffer(), file.type || 'application/octet-stream');
    // The face appears in the shell and on the public page, both of which
    // this render does not own.
    revalidatePath('/settings/profile');
    return { ok: true, avatar };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not upload that image.' };
  }
}

/** Reverts to the generated identicon. */
export async function removeAvatarAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await removeAvatar();
    revalidatePath('/settings/profile');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not remove your avatar.' };
  }
}
