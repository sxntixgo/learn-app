/*
 * The face on a profile (design §11.1).
 *
 * One component for both kinds, so no caller has to remember the fallback
 * rule. The API always sends the identicon seed, even for an account with an
 * uploaded image, precisely so there is something to draw when the image
 * cannot be: offline, a 404 because the owner removed it a second ago, a
 * rate-limited proxy.
 *
 * A plain <img>, not next/image. The bytes are already exactly what the
 * browser should receive — a 256px square WebP, re-encoded by the API — so
 * next/image would add a second optimiser pass over an image that needs
 * none, and route it through the very libvips the upload pipeline exists to
 * keep at arm's length.
 */

import Identicon from './Identicon';
import { localAvatarUrl } from '../../src/lib/avatar';
import styles from './identicon.module.css';

export interface AvatarDescriptor {
  kind: 'identicon' | 'upload';
  seed: string;
  url?: string | null;
}

export interface AvatarProps {
  avatar: AvatarDescriptor;
  /** Rendered size in px. */
  size?: number;
  /**
   * Who this is a picture of, for the accessible name. Pass null next to a
   * visible name — the avatar is decorative there, and announcing it would
   * repeat what the reader has just been told.
   */
  label: string | null;
}

export default function Avatar({ avatar, size = 96, label }: AvatarProps) {
  const src = avatar.kind === 'upload' ? localAvatarUrl(avatar.url) : null;

  // `localAvatarUrl` returns null for anything that is not one of ours, so a
  // payload carrying a hostile URL renders the identicon rather than an
  // <img> pointed at someone else's server.
  if (src === null) {
    return <Identicon seed={avatar.seed} size={size} label={label} />;
  }

  return (
    <img
      className={styles.identicon}
      src={src}
      width={size}
      height={size}
      alt={label ?? ''}
      aria-hidden={label === null ? true : undefined}
      // The image is one fixed square; there is nothing to lay out around.
      decoding="async"
      loading="lazy"
    />
  );
}
