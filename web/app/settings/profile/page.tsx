import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchProfileSettings } from '../../../src/lib/api';
import { withAuthRedirect } from '../../../src/lib/require-auth';
import AvatarForm from './AvatarForm';
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
 * The avatar is editable here too (§11.1). Every account starts with the
 * generated identicon and can replace it with an uploaded image; the upload
 * is re-encoded to a metadata-free 256px WebP by the API, never stored as
 * sent. See api/src/profile/avatar.ts for what that involves and why.
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

        {/*
         * ONE face on this page, and it belongs to the form that changes it.
         * There was briefly a second copy in the identity row above — the same
         * descriptor, the same size, rendered twice — which looked harmless
         * and was not: after an upload the two disagreed until the next full
         * load (the form knows its new state immediately, the server
         * component above it does not), and any test asking for "the avatar"
         * matched two elements. It cost thirty seconds of Playwright timeout
         * to find, reported as a timeout rather than as the ambiguity it was.
         */}
        <AvatarForm avatar={settings.avatar} />
      </section>

      <ProfileSettingsForm settings={settings} />

      {/*
       * The way in to account export/deletion (plan: "Account deletion and
       * data export"). A sibling route, not a section on this page — see
       * settings/account/page.tsx's module comment for why the two screens
       * cannot share one policy floor. `profile:read` (this page's own
       * gate) is student-only, so every account that reaches this link
       * already holds the grant `me:export`/`me:delete` require; nothing
       * further to check here.
       */}
      <p className={styles.accountLinkRow}>
        <Link className={styles.profileLink} href="/settings/account">
          Export my data or delete my account
        </Link>
      </p>
    </main>
  );
}
