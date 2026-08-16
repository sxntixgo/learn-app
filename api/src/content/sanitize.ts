import { fromHtml } from 'hast-util-from-html';
import { defaultSchema, sanitize } from 'hast-util-sanitize';
import type { Schema } from 'hast-util-sanitize';
import { toHtml } from 'hast-util-to-html';

// ---------------------------------------------------------------------------
// Output sanitization (design §8.1).
//
// A content repo is untrusted input, and the two things it can hand us that
// end up inside an authenticated page are prose HTML and (from Phase 10) SVG
// figures. Both go through an ALLOWLIST here: anything not named below is
// removed, so a new HTML/SVG feature is invisible to content until someone
// deliberately adds it. A denylist would have the opposite failure mode.
//
// This module owns the policy; `parse.ts` owns where it is applied.
// ---------------------------------------------------------------------------

/**
 * Prose policy: GitHub's schema (the `hast-util-sanitize` default), plus a
 * bigger `strip` list.
 *
 * `strip` is the difference between "unwrap this element and keep its text"
 * and "delete this subtree". The default only strips `script`, so a
 * `<style>body{…}</style>` would survive as its own CSS printed as visible
 * text, and `<script>alert(1)</script>` would leave `alert(1)` behind as
 * prose. Neither is exploitable, both are wrong, and the shape of the fix is
 * the same one an XSS filter needs: content, not just the tag, goes.
 *
 * `svg` is stripped here on purpose. Figures are their own block type with
 * their own sanitizer (`sanitizeSvg`); inline SVG smuggled into prose is not
 * a supported authoring feature, and allowing it would create a second,
 * weaker path to the same renderer.
 */
export const proseSanitizeSchema: Schema = {
  ...defaultSchema,
  strip: [
    'script',
    'style',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'applet',
    'link',
    'meta',
    'base',
    'form',
    'button',
    'textarea',
    'select',
    'option',
    'template',
    'noscript',
    'svg',
    'math',
    'title',
    'head',
    'audio',
    'video',
    'canvas',
    'dialog',
    'portal',
  ],
};

/**
 * Sanitizes a fragment of prose HTML against `proseSanitizeSchema`.
 *
 * This is the chokepoint for HTML that arrives as a *string*. The markdown
 * pipeline in `parse.ts` applies the same schema to the hast tree before it
 * is ever serialized (one policy, two entry points — the schema above is the
 * single source of truth for both).
 */
export function sanitizeProseHtml(html: string): string {
  return toHtml(sanitize(fromHtml(html, { fragment: true }), proseSanitizeSchema));
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * A paint value: a colour, or a reference to a gradient/pattern defined
 * INSIDE this same document. `url(https://…)` is refused — an external paint
 * server is a request to a third party made from an authenticated page.
 */
const PAINT_VALUE = /^(?:none|transparent|currentColor|#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|hsl)a?\([\d\s.,%/]+\)|url\(#[A-Za-z0-9_.:-]+\))$/;

/** `clip-path`, `mask`, `marker-*`, `filter`: a same-document reference only. */
const LOCAL_FUNC_REF = /^(?:none|url\(#[A-Za-z0-9_.:-]+\))$/;

/** `<use href>` / `<textPath href>`: a same-document fragment only. */
const LOCAL_FRAGMENT = /^#[A-Za-z0-9_.:-]+$/;

/**
 * SVG figure policy (design §8.1: "SVG figures are sanitized — scripts,
 * event handlers, foreignObject stripped").
 *
 * SVG is not a picture format, it is a document format that happens to draw:
 * it can run script, load remote documents, and (via `foreignObject`) embed
 * arbitrary HTML. So the allowlist is drawing primitives and presentation
 * attributes, and nothing that fetches or executes.
 *
 * Note the attribute names are hast property names (`strokeWidth`,
 * `xLinkHref`), not raw attribute names — an unlisted attribute such as
 * `onLoad` never reaches the allowlist branch at all, it simply has no
 * definition and is dropped.
 *
 * NOT USED YET. The `figure` block type lands in Phase 10; this ships now so
 * the hardening lives in one place with the rest of it, tested against real
 * payloads rather than written under deadline next to a rendering bug.
 */
export const svgSanitizeSchema: Schema = {
  allowComments: false,
  allowDoctypes: false,
  ancestors: {},
  // `id` is NOT clobbered: `url(#grad)` and `<use href="#x">` are how a
  // legitimate diagram refers to its own defs, and prefixing the id without
  // rewriting every reference would silently break the drawing. The cost is
  // that a figure's ids share a namespace with the host page — see the
  // renderer note in Phase 10, where the fix belongs (render figures into an
  // isolated subtree, or namespace ids at render time).
  clobber: [],
  clobberPrefix: '',
  protocols: {},
  required: {},
  // Elements whose CONTENT must go with them. `foreignObject` is the reason
  // this list matters most: unwrapping it would splice raw HTML — including
  // the `<script>` it was carrying — into the surrounding document.
  //
  // `a` is deliberately NOT here. It is not in `tagNames` either, so an SVG
  // link is removed — but by unwrapping, which keeps the label it was
  // wrapping. Deleting a hyperlinked caption would damage a legitimate
  // diagram to defend against a link that has already been neutralised.
  strip: [
    'script',
    'style',
    'foreignObject',
    'image',
    'animate',
    'animateMotion',
    'animateTransform',
    'set',
    'discard',
    'handler',
    'filter',
    'feImage',
    'iframe',
    'audio',
    'video',
    'canvas',
    'metadata',
    'switch',
    'view',
  ],
  tagNames: [
    'svg',
    'title',
    'desc',
    'defs',
    'g',
    'symbol',
    'use',
    'marker',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'textPath',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'pattern',
  ],
  attributes: {
    use: [['href', LOCAL_FRAGMENT]],
    textPath: [['href', LOCAL_FRAGMENT]],
    '*': [
      // identity / metadata
      'id',
      'lang',
      'role',
      'ariaLabel',
      'ariaHidden',
      'xmlns',
      // geometry
      'viewBox',
      'width',
      'height',
      'x',
      'y',
      'dx',
      'dy',
      'x1',
      'y1',
      'x2',
      'y2',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'd',
      'points',
      'pathLength',
      'transform',
      'transformOrigin',
      'preserveAspectRatio',
      'overflow',
      // presentation
      'opacity',
      'fillOpacity',
      'fillRule',
      'strokeOpacity',
      'strokeWidth',
      'strokeLineCap',
      'strokeLineJoin',
      'strokeMiterLimit',
      'strokeDashArray',
      'strokeDashOffset',
      'visibility',
      'display',
      'pointerEvents',
      'vectorEffect',
      'shapeRendering',
      'textRendering',
      'clipRule',
      // text
      'fontFamily',
      'fontSize',
      'fontStyle',
      'fontWeight',
      'textAnchor',
      'dominantBaseline',
      'alignmentBaseline',
      'letterSpacing',
      'wordSpacing',
      'textDecoration',
      'writingMode',
      // gradients / markers / patterns / clips
      'offset',
      'stopOpacity',
      'gradientUnits',
      'gradientTransform',
      'spreadMethod',
      'markerUnits',
      'markerWidth',
      'markerHeight',
      'refX',
      'refY',
      'orient',
      'patternUnits',
      'patternContentUnits',
      'patternTransform',
      'clipPathUnits',
      'maskUnits',
      'maskContentUnits',
      // value-constrained: colours and same-document references only
      ['fill', PAINT_VALUE],
      ['stroke', PAINT_VALUE],
      ['color', PAINT_VALUE],
      ['stopColor', PAINT_VALUE],
      ['floodColor', PAINT_VALUE],
      ['clipPath', LOCAL_FUNC_REF],
      ['mask', LOCAL_FUNC_REF],
      ['markerStart', LOCAL_FUNC_REF],
      ['markerMid', LOCAL_FUNC_REF],
      ['markerEnd', LOCAL_FUNC_REF],
      ['filter', LOCAL_FUNC_REF],
    ],
  },
};

/**
 * Sanitizes an SVG document against `svgSanitizeSchema` and returns it
 * serialized.
 *
 * Parsing is done with the HTML parser in fragment mode, which puts `<svg>`
 * into foreign-content mode — the same code path a browser takes, so what is
 * sanitized is what a browser would actually build. It also means no DTD is
 * processed, so entity-expansion and external-entity attacks (billion laughs,
 * XXE) do not arise here the way they would with a real XML parser.
 *
 * NOT USED YET — see `svgSanitizeSchema`. Phase 10's `figure` block is the
 * caller this is waiting for.
 */
export function sanitizeSvg(svg: string): string {
  return toHtml(sanitize(fromHtml(svg, { fragment: true }), svgSanitizeSchema));
}
