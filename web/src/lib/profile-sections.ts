import type { ProfileSections } from './api';

/**
 * Which profile sections have anything in them.
 *
 * TWO DIFFERENT KINDS OF NOTHING, and the profile page has to tell them
 * apart:
 *
 *   ABSENT   — the owner set this section to private, so the API omitted it
 *              entirely (§11: "a hidden section is ABSENT from this object —
 *              never present-and-empty, never sent for the client to hide").
 *              Nothing to render, and nothing to say about it either; that a
 *              section exists and is closed is itself a disclosure.
 *
 *   EMPTY    — the section is shared, and there is genuinely nothing in it.
 *              This is the case that used to render a heading and a line of
 *              apology: "No badges yet." "No degrees defined yet." "Nothing
 *              recent." A new account showed four such boxes in a row, which
 *              says nothing about the person and pushes what they DO have off
 *              the screen.
 *
 * Both now render nothing. The distinction still matters because the page's
 * fallback message depends on it: "hasn't shared anything" is the honest
 * sentence when everything is hidden, and it is equally honest when
 * everything is simply empty, which is why `anySectionHasContent` looks at
 * content rather than at presence.
 *
 * A separate module because this is the one piece of that page worth testing
 * directly: it is pure, it has an edge per section, and getting `courses`
 * wrong (two lists, either of which counts) is easy to do by eye.
 */

/** True when this section is present AND has something to show. */
export function sectionHasContent(sections: ProfileSections, key: keyof ProfileSections): boolean {
  switch (key) {
    case 'badges':
      return (sections.badges?.length ?? 0) > 0;
    case 'degrees':
      return (sections.degrees?.length ?? 0) > 0;
    case 'activity_feed':
      return (sections.activity_feed?.length ?? 0) > 0;
    case 'courses':
      // Two lists, and EITHER makes the section worth showing. A reader with
      // one course in progress and none finished has something to see.
      return (
        (sections.courses?.completed.length ?? 0) > 0 || (sections.courses?.inProgress.length ?? 0) > 0
      );
    case 'activity_heatmap':
      // Deliberately different: a heatmap with no activity is still a year of
      // rendered days, and a blank grid reads as "nothing yet" on its own
      // without a line of text apologising for it. `maxCount` of 0 is the
      // only way to know it is blank — `days` is always full length.
      return sections.activity_heatmap !== undefined;
    default:
      return false;
  }
}

/**
 * True when at least one section has something in it — i.e. the page has
 * anything at all to show below the header.
 */
export function anySectionHasContent(sections: ProfileSections): boolean {
  return (['badges', 'degrees', 'courses', 'activity_feed', 'activity_heatmap'] as const).some((key) =>
    sectionHasContent(sections, key),
  );
}
