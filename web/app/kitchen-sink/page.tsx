import './page.css';

/**
 * Kitchen Sink: Complete token proof sheet.
 *
 * Every token in `web/app/tokens.css` appears on this page with a visual
 * swatch (for colors) or example (for sizes, spacing, type). This page is
 * Gate 1 — a human reviews it at 375, 834, 1194, and 1440, in both light
 * and dark, to judge whether the new palette and type are right.
 *
 * A test (web/src/app/kitchen-sink.test.ts) parses tokens.css and asserts
 * that every token name appears somewhere in the rendered page. A token
 * added to tokens.css without a swatch fails that test.
 */

export const metadata = {
  title: 'Kitchen Sink | Learn App',
  robots: 'noindex',
};

/**
 * Renders a single color token as a swatch with its name and variable.
 * The role is documented in the group heading, not repeated on each swatch.
 */
function ColorSwatch({
  name,
  cssVar,
  dataTestid,
}: {
  name: string;
  cssVar: string;
  dataTestid?: string;
}) {
  return (
    <div className="token token--color" data-testid={dataTestid || cssVar}>
      <div className="token__swatch" style={{ backgroundColor: `var(${cssVar})` }} />
      <div className="token__info">
        <code className="token__name">{name}</code>
        <code className="token__var">{cssVar}</code>
      </div>
    </div>
  );
}

/**
 * Groups tokens by semantic role, with a heading that documents the role.
 */
function TokenSection({
  title,
  role,
  children,
}: {
  title: string;
  role?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <h2 className="section__title">{title}</h2>
      {role && <p className="section__role">{role}</p>}
      <div className="tokens">{children}</div>
    </section>
  );
}

/**
 * Spacing scale visual showing size differences.
 */
function SpacingSample({
  name,
  cssVar,
  dataTestid,
}: {
  name: string;
  cssVar: string;
  dataTestid?: string;
}) {
  return (
    <div className="spacing" data-testid={dataTestid || cssVar}>
      <div className="spacing__swatch">
        <div
          className="spacing__box"
          style={{ width: `var(${cssVar})`, height: `var(${cssVar})` }}
        />
      </div>
      <div className="spacing__info">
        <code className="spacing__name">{name}</code>
        <code className="spacing__var">{cssVar}</code>
      </div>
    </div>
  );
}

/**
 * Radius sample showing a rounded box.
 */
function RadiusSample({
  name,
  cssVar,
  dataTestid,
}: {
  name: string;
  cssVar: string;
  dataTestid?: string;
}) {
  return (
    <div className="radius" data-testid={dataTestid || cssVar}>
      <div
        className="radius__swatch"
        style={{ borderRadius: `var(${cssVar})` }}
      />
      <div className="radius__info">
        <code className="radius__name">{name}</code>
        <code className="radius__var">{cssVar}</code>
      </div>
    </div>
  );
}

/**
 * Border weight sample showing different stroke widths.
 */
function BorderSample({
  name,
  cssVar,
  dataTestid,
}: {
  name: string;
  cssVar: string;
  dataTestid?: string;
}) {
  return (
    <div className="border-sample" data-testid={dataTestid || cssVar}>
      <div
        className="border-sample__swatch"
        style={{ borderWidth: `var(${cssVar})` }}
      />
      <div className="border-sample__info">
        <code className="border-sample__name">{name}</code>
        <code className="border-sample__var">{cssVar}</code>
      </div>
    </div>
  );
}

/**
 * Measure (width) sample showing column widths relative to each other.
 * Shows that --measure-prose is constant while the others step at breakpoints.
 */
function MeasureSample({
  name,
  cssVar,
  dataTestid,
}: {
  name: string;
  cssVar: string;
  dataTestid?: string;
}) {
  return (
    <div className="measure" data-testid={dataTestid || cssVar}>
      <div className="measure__label">
        <code>{name}</code>
      </div>
      <div className="measure__sample" style={{ maxWidth: `var(${cssVar})` }}>
        <div className="measure__content">
          The quick brown fox jumps over the lazy dog. This text demonstrates
          the measure width, ensuring readability and consistency across the
          design system.
        </div>
      </div>
    </div>
  );
}

/**
 * Typography sample showing font, size, and weight.
 */
function TypographySample({
  name,
  style,
  text,
  dataTestid,
}: {
  name: string;
  style: React.CSSProperties;
  text: string;
  dataTestid?: string;
}) {
  return (
    <div className="typography" data-testid={dataTestid}>
      <div className="typography__sample" style={style}>
        {text}
      </div>
      <code className="typography__name">{name}</code>
    </div>
  );
}

export default function KitchenSink() {
  return (
    <div className="kitchen-sink">
      <header className="header">
        <h1 className="header__title">Design Tokens — Gate 1</h1>
        <p className="header__desc">
          Complete proof sheet for all design tokens: colours grouped by role,
          typography showing the three type families at their weights, spacing,
          radii, borders, and measures. This page renders in both light and dark
          themes. Toggle <code>data-theme</code> on <code>&lt;html&gt;</code> to
          verify both.
        </p>
      </header>

      {/* COLOURS */}

      <TokenSection
        title="Surfaces"
        role="Backgrounds: the page, raised panels, cards, and the hairline divider used throughout."
      >
        <ColorSwatch name="--color-page" cssVar="--color-page" />
        <ColorSwatch name="--color-canvas" cssVar="--color-canvas" />
        <ColorSwatch name="--color-surface-raised" cssVar="--color-surface-raised" />
        <ColorSwatch name="--color-surface-card" cssVar="--color-surface-card" />
        <ColorSwatch name="--color-border-hairline" cssVar="--color-border-hairline" />
      </TokenSection>

      <TokenSection
        title="Text"
        role="Body copy, secondary/muted text, and text inside the prose measure (60ch)."
      >
        <ColorSwatch name="--color-text" cssVar="--color-text" />
        <ColorSwatch name="--color-text-secondary" cssVar="--color-text-secondary" />
        <ColorSwatch name="--color-text-reading" cssVar="--color-text-reading" />
      </TokenSection>

      <TokenSection
        title="Teal Family — Links, Rail, Tags"
        role="Six teal roles: general links/progress/active state, the 224px nav rail background and text, and enrolled-tag background/text."
      >
        <ColorSwatch name="--color-link" cssVar="--color-link" />
        <ColorSwatch name="--color-rail-bg" cssVar="--color-rail-bg" />
        <ColorSwatch name="--color-rail-text" cssVar="--color-rail-text" />
        <ColorSwatch name="--color-text-on-accent" cssVar="--color-text-on-accent" />
        <ColorSwatch name="--color-tag-bg" cssVar="--color-tag-bg" />
        <ColorSwatch name="--color-tag-text" cssVar="--color-tag-text" />
      </TokenSection>

      <TokenSection
        title="Gold — Indicator and Text"
        role="Two tiers: --color-accent-gold for border-left and tinted backgrounds (3:1 floor), --color-accent-gold-text for link :hover and small labels (4.5:1)."
      >
        <ColorSwatch name="--color-accent-gold" cssVar="--color-accent-gold" />
        <ColorSwatch name="--color-accent-gold-text" cssVar="--color-accent-gold-text" />
      </TokenSection>

      <TokenSection
        title="Error"
        role="Destructive actions (delete account button text/border)."
      >
        <ColorSwatch name="--color-error" cssVar="--color-error" />
      </TokenSection>

      <TokenSection
        title="Heatmap Ramp"
        role="Five steps (0..4) for activity heatmap cells: NONE to MORE. Plus a hairline for cell edges."
      >
        <ColorSwatch name="--color-heat-0" cssVar="--color-heat-0" />
        <ColorSwatch name="--color-heat-1" cssVar="--color-heat-1" />
        <ColorSwatch name="--color-heat-2" cssVar="--color-heat-2" />
        <ColorSwatch name="--color-heat-3" cssVar="--color-heat-3" />
        <ColorSwatch name="--color-heat-4" cssVar="--color-heat-4" />
        <ColorSwatch name="--color-heat-cell-edge" cssVar="--color-heat-cell-edge" />
      </TokenSection>

      <TokenSection
        title="Track Hues"
        role="Five OKLCH siblings of the link teal, for course/content colour coding. No artboard source; carried forward unchanged."
      >
        <ColorSwatch name="--color-track-blue" cssVar="--color-track-blue" />
        <ColorSwatch name="--color-track-teal" cssVar="--color-track-teal" />
        <ColorSwatch name="--color-track-ochre" cssVar="--color-track-ochre" />
        <ColorSwatch name="--color-track-maroon" cssVar="--color-track-maroon" />
        <ColorSwatch name="--color-track-slate" cssVar="--color-track-slate" />
      </TokenSection>

      {/* DEPRECATED ALIASES */}

      <TokenSection
        title="Deprecated Aliases"
        role="These names survive only until their consumers migrate (Phases 2-5). Do not reach for them in new code."
      >
        <ColorSwatch
          name="--color-accent-yellow"
          cssVar="--color-accent-yellow"
          dataTestid="--color-accent-yellow"
        />
        <ColorSwatch
          name="--color-banner-bg"
          cssVar="--color-banner-bg"
          dataTestid="--color-banner-bg"
        />
        <ColorSwatch
          name="--color-banner-text"
          cssVar="--color-banner-text"
          dataTestid="--color-banner-text"
        />
        <ColorSwatch
          name="--color-banner-divider"
          cssVar="--color-banner-divider"
          dataTestid="--color-banner-divider"
        />
        <ColorSwatch
          name="--color-footer-bg"
          cssVar="--color-footer-bg"
          dataTestid="--color-footer-bg"
        />
        <ColorSwatch
          name="--color-footer-text"
          cssVar="--color-footer-text"
          dataTestid="--color-footer-text"
        />
        <ColorSwatch
          name="--color-logo-tile"
          cssVar="--color-logo-tile"
          dataTestid="--color-logo-tile"
        />
      </TokenSection>

      {/* MEASURES — WIDTH CONSTRAINTS */}

      <TokenSection
        title="Type Measures"
        role="Column widths. Prose is constant (60ch); breakout and full step at 834 and 1440."
      >
        <MeasureSample name="--measure-prose" cssVar="--measure-prose" />
        <MeasureSample name="--measure-breakout" cssVar="--measure-breakout" />
        <MeasureSample name="--measure-full" cssVar="--measure-full" />
      </TokenSection>

      {/* SPACING SCALE */}

      <TokenSection
        title="Spacing Scale"
        role="Eight values, 4px to 64px, with ~1.5x step ratio. Replace hardcoded margin/padding."
      >
        <SpacingSample name="--space-0" cssVar="--space-0" />
        <SpacingSample name="--space-1" cssVar="--space-1" />
        <SpacingSample name="--space-2" cssVar="--space-2" />
        <SpacingSample name="--space-3" cssVar="--space-3" />
        <SpacingSample name="--space-4" cssVar="--space-4" />
        <SpacingSample name="--space-5" cssVar="--space-5" />
        <SpacingSample name="--space-6" cssVar="--space-6" />
        <SpacingSample name="--space-7" cssVar="--space-7" />
      </TokenSection>

      {/* RADIUS SCALE */}

      <TokenSection
        title="Border Radii"
        role="Small to large rounded corners, plus pill for fully-round shapes."
      >
        <RadiusSample name="--radius-sm" cssVar="--radius-sm" />
        <RadiusSample name="--radius-md" cssVar="--radius-md" />
        <RadiusSample name="--radius-lg" cssVar="--radius-lg" />
        <RadiusSample name="--radius-pill" cssVar="--radius-pill" />
      </TokenSection>

      {/* BORDER WEIGHTS */}

      <TokenSection
        title="Border Weights"
        role="Hairline for faint grid lines and dividers; regular for general borders; thick for emphasis."
      >
        <BorderSample name="--border-hairline" cssVar="--border-hairline" />
        <BorderSample name="--border-regular" cssVar="--border-regular" />
        <BorderSample name="--border-thick" cssVar="--border-thick" />
      </TokenSection>

      {/* TYPOGRAPHY */}

      <TokenSection
        title="Typography"
        role="Three families at their declared weights, rendering at sizes observed in the artboards."
      >
        <div className="typography-group">
          <h3 className="typography-group__title">Plus Jakarta Sans</h3>
          <p className="typography-group__note">500, 700, 800</p>
          <TypographySample
            name="Weight 500"
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '1rem',
              fontWeight: 500,
            }}
            text="Plus Jakarta Sans · Weight 500"
            dataTestid="font-weight-500-sans"
          />
          <TypographySample
            name="Weight 700"
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '1.25rem',
              fontWeight: 700,
            }}
            text="Plus Jakarta Sans · Weight 700"
            dataTestid="font-weight-700-sans"
          />
          <TypographySample
            name="Weight 800"
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '1.75rem',
              fontWeight: 800,
            }}
            text="Plus Jakarta Sans · Weight 800"
            dataTestid="font-weight-800-sans"
          />
        </div>

        <div className="typography-group">
          <h3 className="typography-group__title">Source Serif 4</h3>
          <p className="typography-group__note">400, 600</p>
          <TypographySample
            name="Weight 400"
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '1rem',
              fontWeight: 400,
            }}
            text="Source Serif 4 · Weight 400 · Lesson prose (19px) and inline code."
            dataTestid="font-weight-400-serif"
          />
          <TypographySample
            name="Weight 600"
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '1.25rem',
              fontWeight: 600,
            }}
            text="Source Serif 4 · Weight 600"
            dataTestid="font-weight-600-serif"
          />
        </div>

        <div className="typography-group">
          <h3 className="typography-group__title">IBM Plex Mono</h3>
          <p className="typography-group__note">400, 500</p>
          <TypographySample
            name="Weight 400"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
              fontWeight: 400,
            }}
            text="const token = 'value';"
            dataTestid="font-weight-400-mono"
          />
          <TypographySample
            name="Weight 500"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
            text="const token = 'value';"
            dataTestid="font-weight-500-mono"
          />
        </div>
      </TokenSection>
    </div>
  );
}
