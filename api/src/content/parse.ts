import type { Code, Heading, Root, RootContent, Yaml } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';

// Phase 1 supports exactly two block types (design §... / CLAUDE.md rule 5:
// content is a typed block array, not HTML or a rehype AST). Do not add
// chart/quiz/rubric/callout/figure here — those are later phases.
export type Block = { type: 'prose'; html: string } | { type: 'code'; lang: string | null; source: string };

export interface ParsedLesson {
  title: string;
  blocks: Block[];
}

const markdownParser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']);
const htmlSerializer = unified().use(remarkRehype).use(rehypeStringify);

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

  const first = children[0];
  if (first?.type === 'yaml') {
    const frontmatter = parseYamlFrontmatter((first as Yaml).value);
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

  return { title, blocks: buildBlocks(children) };
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
      blocks.push({ type: 'code', lang: codeNode.lang ?? null, source: codeNode.value });
    } else {
      proseGroup.push(node);
    }
  }
  flushProse();

  return blocks;
}
