import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchProfileSettings } from '../../../src/lib/api';
import { withAuthRedirect } from '../../../src/lib/require-auth';
import Identicon from '../../_shell/Identicon';
import ProfileSettingsForm from './ProfileSettingsForm';
import styles from './settings.module.css';

export const metadata: Metadata = {
  title: 'Profile & visibility — Learn App',
  // A settings screen is never something to index, whatever the account
  // holder chose for their own public page.
  robots: { index: false, follow: false },
};

/*
 * The owner's controls for design §11's profile: the five section toggles,
 * the per-student `noindex` switch, and the bio.
 *
 * The avatar is shown but not editable: §11.1's uploads need a re-encode
 * step (`sharp`), whose current releases carry unpatched libvips CVEs and
 * whose fixed line requires a Next 16 upgrade this project has deferred. The
 * generated identicon is the whole avatar story until then.
 */
export default async function ProfileSettingsPage() {
  const settings = await withAuthRedirect('/settings/profile', fetchProfileSettings);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Profile &amp; visibility</h1>

      <section className={styles.identity} aria-labelledby="identity-heading">
        <h2 className={styles.groupTitle} id="identity-heading">
          Your profile
        </h2>
        <div className={styles.identityRow}>
          {/* The very same seed the public page is served, so the face here
              and the face at /u/{handle} can never disagree. */}
          <Identicon seed={settings.avatar.seed} size={64} label={null} />
          <div>
            <p className={styles.name}>{settings.displayName ?? settings.handle}</p>
            {settings.handle ? (
              <Link className={styles.profileLink} href={`/u/${settings.handle}`}>
                View your public page
              </Link>
            ) : (
              <p className={styles.noHandle}>
                Your account has no handle yet, so it has no profile page. Ask an administrator to set one.
              </p>
            )}
          </div>
        </div>
      </section>

      <ProfileSettingsForm settings={settings} />
    </main>
  );
}
