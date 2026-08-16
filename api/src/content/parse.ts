import type { Code, Heading, Root, RootContent, Yaml } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';
import { proseSanitizeSchema } from './sanitize.ts';

// Phase 1 supports exactly two block types (design §... / CLAUDE.md rule 5:
// content is a typed block array, not HTML or a rehype AST). Do not add
// chart/quiz/rubric/callout/figure here — those are later phases.
export interface Annotation {
  line: number;
  track?: string;
  body: string;
}

export type Block =
  | { type: 'prose'; html: string }
  | { type: 'code'; lang: string | null; source: string; annotations?: Annotation[] };

export type LessonKind = 'lesson' | 'exercise' | 'quiz';

const LESSON_KINDS: ReadonlySet<string> = new Set(['lesson', 'exercise', 'quiz']);

export interface ParsedLesson {
  title: string;
  blocks: Block[];
  /** Optional track id from frontmatter `track:`, matching a course.yaml track id (design §6.1). */
  track?: string;
  /** Frontmatter `kind:`, defaulting to "lesson" when absent (design §6.1). */
  kind: LessonKind;
  /** Frontmatter `estimate:` (e.g. "25m"), converted to whole minutes. */
  estimateMinutes?: number;
}

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);

// Prose HTML is produced under TWO independent guarantees, because a content
// repo is untrusted input (design §8.1) and one of these is a configuration
// flag someone could plausibly flip later:
//
//  1. `remark-rehype` runs WITHOUT `allowDangerousHtml`, so raw HTML written
//     in a markdown file is discarded rather than rendered. Do not add
//     `allowDangerousHtml` + `rehype-raw` here without reading (2).
//  2. `rehype-sanitize` applies an allowlist to whatever hast the pipeline
//     did produce. That is not redundant with (1): markdown alone is enough
//     to emit `<a href="javascript:…">` from `[x](javascript:…)`, which is a
//     stored-XSS payload that needs no raw HTML at all. This is also what
//     makes (1) safe to revisit — the sanitizer, not the drop, is the
//     security boundary.
const htmlSerializer = unified().use(remarkRehype).use(rehypeSanitize, proseSanitizeSchema).use(rehypeStringify);

/**
 * Converts a markdown lesson document into a title and a typed block array.
 *
 * Title resolution: YAML frontmatter `title:` wins; otherwise the first
 * level-1 heading; otherwise this throws. Whichever source supplies the
 * title is removed from the block output — frontmatter is metadata, and an
 * H1 used as the title would otherwise duplicate the page heading the
 * reader renders separately.
 */
export function parseLesson(markdown: string): ParsedLesson {
  const tree = markdownParser.parse(markdown) as Root;
  const children: RootContent[] = [...tree.children];

  let title: string | undefined;
  let frontmatter: Record<string, unknown> | undefined;

  const first = children[0];
  if (first?.type === 'yaml') {
    frontmatter = parseYamlFrontmatter((first as Yaml).value);
    if (typeof frontmatter?.title === 'string' && frontmatter.title.trim() !== '') {
      title = frontmatter.title.trim();
    }
    children.shift();
  }

  if (title === undefined) {
    const headingIndex = children.findIndex((node): node is Heading => node.type === 'heading' && node.depth === 1);
    if (headingIndex !== -1) {
      const heading = children[headingIndex] as Heading;
      const headingText = mdastToString(heading).trim();
      if (headingText !== '') {
        title = headingText;
        children.splice(headingIndex, 1);
      }
    }
  }

  if (title === undefined) {
    throw new Error(
      'Could not determine lesson title: no YAML frontmatter "title" field and no level-1 heading found.',
    );
  }

  const track = parseTrack(frontmatter?.track);
  const kind = parseKind(frontmatter?.kind);
  const estimateMinutes = parseEstimate(frontmatter?.estimate);

  return {
    title,
    blocks: buildBlocks(children),
    kind,
    ...(track !== undefined ? { track } : {}),
    ...(estimateMinutes !== undefined ? { estimateMinutes } : {}),
  };
}

function parseTrack(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  throw new Error(`Invalid lesson frontmatter "track": expected a non-empty string, got ${JSON.stringify(raw)}.`);
}

function parseKind(raw: unknown): LessonKind {
  if (raw === undefined) return 'lesson';
  if (typeof raw === 'string' && LESSON_KINDS.has(raw)) return raw as LessonKind;
  throw new Error(
    `Invalid lesson frontmatter "kind": ${JSON.stringify(raw)} — must be one of "lesson", "exercise", "quiz".`,
  );
}

// Only "<N>m" (whole minutes) is supported — that is the one form design §6.1
// shows ("estimate: 25m"). Not exhaustive by design; extend when a real
// lesson needs hours.
const ESTIMATE_RE = /^(\d+)m$/;

function parseEstimate(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const match = ESTIMATE_RE.exec(raw.trim());
    if (match) return Number(match[1]);
  }
  throw new Error(
    `Invalid lesson frontmatter "estimate": ${JSON.stringify(raw)} — expected a duration like "25m".`,
  );
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> | undefined {
  const parsed: unknown = parseYaml(raw);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

function buildBlocks(nodes: RootContent[]): Block[] {
  const blocks: Block[] = [];
  let proseGroup: RootContent[] = [];

  const flushProse = () => {
    if (proseGroup.length === 0) return;
    const proseRoot: Root = { type: 'root', children: proseGroup };
    const hast = htmlSerializer.runSync(proseRoot);
    const html = htmlSerializer.stringify(hast).trim();
    if (html !== '') {
      blocks.push({ type: 'prose', html });
    }
    proseGroup = [];
  };

  for (const node of nodes) {
    if (node.type === 'code') {
      flushProse();
      const codeNode = node as Code;
      const { source, annotations } = extractAnnotations(codeNode.value);
      const block: Block = { type: 'code', lang: codeNode.lang ?? null, source };
      if (annotations.length > 0) block.annotations = annotations;
      blocks.push(block);
    } else {
      proseGroup.push(node);
    }
  }
  flushProse();

  return blocks;
}

// In-source annotation markers (design §6.3): a trailing comment of the form
// `[!note <track>] <body>`, where <track> is optional. Supports the three
// comment styles that actually appear in target content — `#`, `//`, `--` —
// deliberately not an exhaustive comment-syntax table (Task A instructions).
// Not anchored to end-of-line-only content before the marker, so it also
// tolerates a marker as the entirety of its own line.
const ANNOTATION_MARKER_RE = /[ \t]*(?:#|\/\/|--)[ \t]*\[!note(?:[ \t]+([A-Za-z0-9][\w-]*))?\][ \t]*(.*)$/;

/**
 * Strips `[!note ...]` marker comments out of a code fence's raw source and
 * collects them as annotations with their 1-based source line number.
 *
 * When no marker is present, `source` is returned completely unmodified —
 * this is the regression guard from Task A: a fence with no markers must be
 * byte-identical to the pre-annotation-support output.
 */
function extractAnnotations(source: string): { source: string; annotations: Annotation[] } {
  const lines = source.split('\n');
  const annotations: Annotation[] = [];
  let changed = false;

  const strippedLines = lines.map((line, index) => {
    const match = ANNOTATION_MARKER_RE.exec(line);
    if (!match) return line;
    const body = (match[2] ?? '').trim();
    if (body === '') return line;

    changed = true;
    const track = match[1];
    annotations.push({ line: index + 1, ...(track !== undefined ? { track } : {}), body });
    return line.slice(0, match.index);
  });

  if (!changed) {
    return { source, annotations: [] };
  }
  return { source: strippedLines.join('\n'), annotations };
}
