'use client';

/*
 * The five visibility toggles, the noindex switch, and the bio (design §11).
 *
 * THE ORDER OF THE OPTIONS IS THE POINT. Every section offers exactly the
 * three values the API and the database know about, listed least-visible
 * first, and every one of them starts at "Only me" for an account that has
 * never touched this screen — a privacy control shipped defaulted-open is
 * not a privacy control (§11). Nothing here invents a fourth state, and
 * nothing here defaults a control to anything but what the server sent.
 *
 * The feed and the heatmap are two separate rows and must stay that way:
 * one reveals WHAT you study, the other WHEN you are at your desk.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ProfileSection, ProfileSettings, SectionVisibility } from '../../../src/lib/api';
import { saveProfileSettingsAction } from './actions';
import styles from './settings.module.css';

const SECTIONS: { section: ProfileSection; label: string; reveals: string }[] = [
  { section: 'badges', label: 'Badges', reveals: 'What you’ve earned' },
  { section: 'degrees', label: 'Degrees', reveals: 'Earned, and progress toward unearned' },
  { section: 'courses', label: 'Courses', reveals: 'Completed and in progress, shown separately' },
  { section: 'activity_feed', label: 'Activity feed', reveals: 'What you study' },
  { section: 'activity_heatmap', label: 'Activity heatmap', reveals: 'When you’re at your desk' },
];

const VISIBILITIES: { value: SectionVisibility; label: string }[] = [
  { value: 'private', label: 'Only me' },
  { value: 'signed_in', label: 'Signed-in people' },
  { value: 'public', label: 'Anyone with the link' },
];

export interface ProfileSettingsFormProps {
  settings: ProfileSettings;
}

export default function ProfileSettingsForm({ settings: initial }: ProfileSettingsFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState<ProfileSettings>(initial);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [noindex, setNoindex] = useState(initial.noindex);
  const [bio, setBio] = useState(initial.bio ?? '');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const savedBio = saved.bio ?? '';
  const changedSections = SECTIONS.filter(({ section }) => visibility[section] !== saved.visibility[section]);
  const dirty = changedSections.length > 0 || noindex !== saved.noindex || bio.trim() !== savedBio.trim();

  function handleSave() {
    if (isPending || !dirty) return;
    setError(null);
    setMessage(null);

    // Only what actually changed: an omitted field is left alone by the API,
    // so a stale tab cannot re-open a section that was closed elsewhere.
    const update: Parameters<typeof saveProfileSettingsAction>[0] = {};
    if (changedSections.length > 0) {
      update.visibility = Object.fromEntries(changedSections.map(({ section }) => [section, visibility[section]]));
    }
    if (noindex !== saved.noindex) update.noindex = noindex;
    if (bio.trim() !== savedBio.trim()) update.bio = bio;

    startTransition(async () => {
      const result = await saveProfileSettingsAction(update);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The server's answer wins over the local state, so what the form shows
      // afterwards is what is actually stored.
      setSaved(result.settings);
      setVisibility(result.settings.visibility);
      setNoindex(result.settings.noindex);
      setBio(result.settings.bio ?? '');
      setMessage('Saved.');
      router.refresh();
    });
  }

  return (
    <div className={styles.form}>
      <section className={styles.group} aria-labelledby="visibility-heading">
        <h2 className={styles.groupTitle} id="visibility-heading">
          What people can see
        </h2>
        <p className={styles.groupNote}>
          Each section is separate, and every one of them starts private. Changes take effect as soon as you save.
        </p>

        <ul className={styles.sectionList}>
          {SECTIONS.map(({ section, label, reveals }) => (
            <li className={styles.sectionRow} key={section}>
              <label className={styles.sectionLabel} htmlFor={`visibility-${section}`}>
                {label}
                <span className={styles.sectionReveals}>{reveals}</span>
              </label>
              <select
                id={`visibility-${section}`}
                className={styles.select}
                value={visibility[section]}
                disabled={isPending}
                onChange={(event) =>
                  setVisibility({ ...visibility, [section]: event.target.value as SectionVisibility })
                }
              >
                {VISIBILITIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.group} aria-labelledby="search-heading">
        <h2 className={styles.groupTitle} id="search-heading">
          Search engines
        </h2>
        <label className={styles.checkboxRow} htmlFor="profile-noindex">
          <input
            id="profile-noindex"
            className={styles.checkbox}
            type="checkbox"
            checked={noindex}
            disabled={isPending}
            onChange={(event) => setNoindex(event.target.checked)}
          />
          <span>
            Ask search engines not to index my profile
            <span className={styles.checkboxNote}>
              On by default. Turning it off does not make a private section public — it only affects the page you have
              already chosen to share.
            </span>
          </span>
        </label>
      </section>

      <section className={styles.group} aria-labelledby="bio-heading">
        <h2 className={styles.groupTitle} id="bio-heading">
          Bio
        </h2>
        <label className={styles.bioLabel} htmlFor="profile-bio">
          Shown on your profile to anyone who can see the page. Up to 2000 characters.
        </label>
        <textarea
          id="profile-bio"
          className={styles.textarea}
          value={bio}
          rows={4}
          maxLength={2000}
          disabled={isPending}
          onChange={(event) => setBio(event.target.value)}
        />
      </section>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.save}
          onClick={handleSave}
          disabled={isPending || !dirty}
          aria-busy={isPending}
        >
          {isPending ? 'Saving…' : 'Save changes'}
        </button>
        {/* Both messages are live regions: a status that only appears
            visually is invisible to a screen-reader user (design §14). */}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className={styles.saved} role="status">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
