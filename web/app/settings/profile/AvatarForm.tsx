'use client';

/*
 * Choosing a picture (design §11.1).
 *
 * The whole of the validation lives in the API — this component's job is to
 * make the two outcomes legible: a face that changed, or a sentence saying
 * why it did not. It deliberately does NOT pre-validate the file's type or
 * size in the browser: doing so would produce a second, inevitably-drifting
 * copy of the rules in api/src/profile/avatar.ts, and a check the user can
 * remove from their own devtools is not one worth maintaining. `accept` on
 * the input is an affordance for the file picker, nothing more.
 *
 * The preview is the file the person just chose, read locally, so they can
 * see it before committing. It is revoked on replacement — an object URL
 * that is never released keeps the whole file alive for the lifetime of the
 * document.
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ProfileAvatar } from '../../../src/lib/api';
import Avatar from '../../_shell/Avatar';
import { AVATAR_ACCEPT } from '../../../src/lib/avatar';
import { removeAvatarAction, uploadAvatarAction } from './actions';
import styles from './settings.module.css';

export interface AvatarFormProps {
  avatar: ProfileAvatar;
}

export default function AvatarForm({ avatar: initial }: AvatarFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [avatar, setAvatar] = useState<ProfileAvatar>(initial);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // One effect for the last preview still outstanding when this unmounts;
  // replacements are revoked as they happen, below.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  /**
   * Swaps the preview, releasing the object URL it replaces. Deliberately
   * says NOTHING about the error/message state: an earlier version cleared
   * both here, which meant calling it after a failed upload silently erased
   * the message that had just been set one line above. The refusal reached
   * the browser and vanished before it could be read.
   */
  function setPreviewFile(file: File | undefined) {
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return file ? URL.createObjectURL(file) : null;
    });
    if (file === undefined && inputRef.current) inputRef.current.value = '';
  }

  /** Choosing a file from the picker: a new preview, and a clean slate. */
  function choose(file: File | undefined) {
    setError(null);
    setMessage(null);
    setPreviewFile(file);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;
    const form = new FormData(event.currentTarget);
    setError(null);
    setMessage(null);

    startTransition(async () => {
      const result = await uploadAvatarAction(form);
      if (!result.ok) {
        setError(result.message);
        // Drop the preview and restore the stored face. Nothing was saved,
        // so nothing should look as though it was — leaving a rejected file
        // on screen next to "that format is not accepted" reads as though it
        // half-worked. `setPreviewFile`, not `choose`, so the message above
        // survives.
        setPreviewFile(undefined);
        return;
      }
      setAvatar(result.avatar);
      setPreviewFile(undefined);
      setMessage('Your picture has been updated.');
      // The shell and the public page both draw this face.
      router.refresh();
    });
  }

  function remove() {
    if (isPending) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await removeAvatarAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setAvatar({ kind: 'identicon', seed: avatar.seed });
      setPreviewFile(undefined);
      setMessage('Your picture has been removed.');
      router.refresh();
    });
  }

  return (
    <form className={styles.avatarForm} onSubmit={submit}>
      <div className={styles.avatarRow}>
        {preview ? (
          // A local object URL for the file just chosen — nothing to
          // optimise and nothing to fetch.
          <img className={styles.avatarPreview} src={preview} width={64} height={64} alt="" />
        ) : (
          <Avatar avatar={avatar} size={64} label={null} />
        )}

        <div className={styles.avatarControls}>
          <label className={styles.avatarLabel} htmlFor="avatar">
            Profile picture
          </label>
          <input
            className={styles.avatarInput}
            ref={inputRef}
            id="avatar"
            name="avatar"
            type="file"
            accept={AVATAR_ACCEPT}
            onChange={(event) => choose(event.currentTarget.files?.[0])}
            disabled={isPending}
          />
          <p className={styles.avatarHint}>
            JPEG, PNG or WebP, up to 2 MB. It will be resized to a 256-pixel square, and any camera or location
            information the file carries is removed.
          </p>

          <div className={styles.avatarButtons}>
            <button className={styles.save} type="submit" disabled={isPending || preview === null}>
              {isPending ? 'Saving…' : 'Save picture'}
            </button>
            {avatar.kind === 'upload' ? (
              <button className={styles.secondary} type="button" onClick={remove} disabled={isPending}>
                Use my identicon instead
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <p aria-live="polite" className={error ? styles.error : styles.saved}>
        {error ?? message ?? ''}
      </p>
    </form>
  );
}
