/*
 * Colour-scheme control (design §14: "Keep it quiet — design §14 spends
 * delight elsewhere"). A plain Server Component, not a client component: the
 * three buttons are separate `<form>`s, each bound to setThemeAction with
 * its own value, so the whole control works via ordinary form submission —
 * no hover-only affordance, no client JS required, and the SSR'd `current`
 * prop (read from the cookie in layout.tsx) means the pressed state is
 * correct on the very first paint too, same as the theme itself.
 */

import { setThemeAction } from './theme-actions';
import type { ThemePreference } from '../../src/lib/theme';
import styles from './theme-toggle.module.css';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
];

export default function ThemeToggle({ current }: { current: ThemePreference }) {
  return (
    <div className={styles.group} role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => {
        const isCurrent = option.value === current;
        const submit = setThemeAction.bind(null, option.value);
        return (
          <form key={option.value} action={submit} className={styles.form}>
            <button
              type="submit"
              className={styles.button}
              aria-pressed={isCurrent}
              disabled={isCurrent}
              title={`Use ${option.label.toLowerCase()} theme`}
            >
              {option.label}
            </button>
          </form>
        );
      })}
    </div>
  );
}
