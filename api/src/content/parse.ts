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
// content is a typed block array, not HTML or a rehype AST). Phase 7 adds
// `quiz` — the first TAGGED fenced block (design §6.3: "tagged fenced
// blocks with YAML"), a ```quiz fence whose body is a YAML mapping rather
// than a language source. Do not add chart/rubric/callout/figure here —
// those are later phases.
export interface Annotation {
  line: number;
  track?: string;
  body: string;
}

export interface QuizChoice {
  text: string;
  /**
   * True only on the correct choice(s). Present in the STORED block (this
   * is what the scoring endpoint checks answers against) but stripped from
   * every response the browser receives — see
   * api/src/routes/courses.ts's stripQuizAnswers. Never trust a `Block`
   * read straight off an HTTP response to carry this field.
   */
  correct?: boolean;
}

export interface QuizQuestion {
  prompt: string;
  /** Optional track id (design §6.1's course.yaml tracks), for per-track scoring (design §9.1/§9.3). */
  track?: string;
  choices: QuizChoice[];
}

export interface QuizBlock {
  type: 'quiz';
  /** Passing threshold as a fraction of correctly-answered questions, e.g. 0.7 (design §9.1). */
  pass: number;
  questions: QuizQuestion[];
}

export type Block =
  | { type: 'prose'; html: string }
  | { type: 'code'; lang: string | null; source: string; annotations?: Annotation[] }
  | QuizBlock;

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
      if (codeNode.lang === 'quiz') {
        blocks.push(buildQuizBlock(codeNode));
        continue;
      }
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

// ---------------------------------------------------------------------------
// The quiz block (design §6.3, Task A): the first TAGGED fenced block. A
// ```quiz fence's body is a YAML mapping, not a language source — CommonMark
// core handles the fence itself, so this is the whole "parser extension" cost.
// ---------------------------------------------------------------------------

/** The shape `yaml`'s YAMLParseError carries — duck-typed rather than an
 * `instanceof` import, since the position is what error quality needs here,
 * not the error's identity. */
interface YamlPositionedError {
  linePos?: Array<{ line: number; col: number }>;
  message: string;
}

function hasLinePos(err: unknown): err is YamlPositionedError {
  return typeof err === 'object' && err !== null && 'message' in err;
}

/**
 * The 1-based line IN THE WHOLE LESSON FILE a ```quiz fence's Nth content
 * line falls on, given the fence's own mdast position. Content starts the
 * line after the opening fence, and `yaml`'s `linePos[0].line` is 1-based
 * within the fence body — so line 1 of the body is `fenceStartLine + 1`.
 */
function quizContentLine(codeNode: Code, relativeLine: number): number {
  const fenceStartLine = codeNode.position?.start.line ?? 0;
  return fenceStartLine + relativeLine;
}

/**
 * Parses a ```quiz fence's body into a typed QuizBlock.
 *
 * Error quality (design §8: "the authoring experience"): a YAML syntax
 * error names the file line it occurred on, computed from the fence's own
 * mdast position plus the YAML parser's own line-within-the-block position.
 * (The caller, manifest.ts's loadCourse, prefixes the file name onto
 * whatever this throws — this function only owns the line.) Everything
 * ELSE about a malformed quiz block (missing `pass`, no correct choice, a
 * choice with no text, ...) is deliberately NOT re-validated here: that is
 * schemas/blocks.schema.json's job (validateBlocks, run at import time),
 * exactly like annotations' line/lines mutual-exclusivity is a schema
 * concern, not a parse.ts concern.
 */
function buildQuizBlock(codeNode: Code): QuizBlock {
  let parsed: unknown;
  try {
    parsed = parseYaml(codeNode.value);
  } catch (err) {
    const relativeLine = hasLinePos(err) ? (err.linePos?.[0]?.line ?? 1) : 1;
    const line = quizContentLine(codeNode, relativeLine);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid quiz block YAML at line ${line}: ${detail}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const line = quizContentLine(codeNode, 1);
    throw new Error(
      `invalid quiz block at line ${line}: the \`\`\`quiz fence body must be a YAML mapping with "pass" and ` +
        `"questions" keys, got ${Array.isArray(parsed) ? 'a list' : typeof parsed}.`,
    );
  }

  const record = parsed as Record<string, unknown>;
  return { type: 'quiz', pass: record.pass as number, questions: record.questions as QuizQuestion[] };
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
