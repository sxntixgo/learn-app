import './page.css';

/**
 * Kitchen Sink: A comprehensive reference for all design tokens.
 * This page renders every token with its name and computed value,
 * used at Gate 4 to verify the design system is complete and coherent.
 */

export const metadata = {
  title: 'Kitchen Sink | Learn App',
  robots: 'noindex',
};

/**
 * Renders a single token as a swatch with its name and resolved value in monospace.
 */
function TokenSwatch({
  name,
  cssVar,
  type = 'color',
}: {
  name: string;
  cssVar: string;
  type?: 'color' | 'size' | 'text';
}) {
  return (
    <div className={`token token--${type}`}>
      <div
        className="token__swatch"
        style={
          type === 'color'
            ? { backgroundColor: `var(${cssVar})` }
            : undefined
        }
      />
      <div className="token__info">
        <code className="token__name">{name}</code>
        <code className="token__var">{cssVar}</code>
      </div>
    </div>
  );
}

/**
 * Renders a set of tokens grouped by category.
 */
function TokenSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <h2 className="section__title">{title}</h2>
      <div className="tokens">{children}</div>
    </section>
  );
}

/**
 * Typography sample showing font, size, and weight.
 */
function TypographySample({
  name,
  className,
  text,
}: {
  name: string;
  className: string;
  text: string;
}) {
  return (
    <div className="typography">
      <div className={`typography__sample ${className}`}>{text}</div>
      <code className="typography__name">{name}</code>
    </div>
  );
}

/**
 * Spacing scale visual showing size differences.
 */
function SpacingSample({
  name,
  cssVar,
}: {
  name: string;
  cssVar: string;
}) {
  return (
    <div className="spacing">
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
}: {
  name: string;
  cssVar: string;
}) {
  return (
    <div className="radius">
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
}: {
  name: string;
  cssVar: string;
}) {
  return (
    <div className="border-sample">
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
 * Measure (width) sample showing column widths.
 */
function MeasureSample({
  name,
  cssVar,
}: {
  name: string;
  cssVar: string;
}) {
  return (
    <div className="measure">
      <div className="measure__label">
        <code>{name}</code>
      </div>
      <div
        className="measure__sample"
        style={{ maxWidth: `var(${cssVar})` }}
      >
        <div className="measure__content">
          The quick brown fox jumps over the lazy dog. This text demonstrates
          the measure width, ensuring readability and consistency across the
          design system.
        </div>
      </div>
    </div>
  );
}

export default function KitchenSink() {
  return (
    <main className="kitchen-sink">
      <header className="header">
        <h1 className="header__title">Design Tokens</h1>
        <p className="header__desc">
          Complete reference for all design tokens: colours, spacing, sizing,
          typography, and structural values. This page renders in both light
          and dark themes.
        </p>
      </header>

      {/* Colours */}
      <TokenSection title="Surfaces">
        <TokenSwatch name="--color-page" cssVar="--color-page" type="color" />
        <TokenSwatch
          name="--color-surface-raised"
          cssVar="--color-surface-raised"
          type="color"
        />
        <TokenSwatch
          name="--color-border-hairline"
          cssVar="--color-border-hairline"
          type="color"
        />
      </TokenSection>

      <TokenSection title="Text">
        <TokenSwatch
          name="--color-text"
          cssVar="--color-text"
          type="color"
        />
        <TokenSwatch
          name="--color-text-secondary"
          cssVar="--color-text-secondary"
          type="color"
        />
      </TokenSection>

      <TokenSection title="Top Banner">
        <TokenSwatch
          name="--color-banner-bg"
          cssVar="--color-banner-bg"
          type="color"
        />
        <TokenSwatch
          name="--color-banner-text"
          cssVar="--color-banner-text"
          type="color"
        />
        <TokenSwatch
          name="--color-banner-divider"
          cssVar="--color-banner-divider"
          type="color"
        />
      </TokenSection>

      <TokenSection title="Footer">
        <TokenSwatch
          name="--color-footer-bg"
          cssVar="--color-footer-bg"
          type="color"
        />
        <TokenSwatch
          name="--color-footer-text"
          cssVar="--color-footer-text"
          type="color"
        />
      </TokenSection>

      <TokenSection title="Links & Tags">
        <TokenSwatch
          name="--color-link"
          cssVar="--color-link"
          type="color"
        />
        <TokenSwatch
          name="--color-tag-bg"
          cssVar="--color-tag-bg"
          type="color"
        />
        <TokenSwatch
          name="--color-tag-text"
          cssVar="--color-tag-text"
          type="color"
        />
      </TokenSection>

      <TokenSection title="Accent">
        <TokenSwatch
          name="--color-accent-yellow"
          cssVar="--color-accent-yellow"
          type="color"
        />
        <TokenSwatch
          name="--color-logo-tile"
          cssVar="--color-logo-tile"
          type="color"
        />
      </TokenSection>

      {/* Activity Heatmap */}
      <TokenSection title="Activity Heatmap">
        <TokenSwatch
          name="--color-heat-0"
          cssVar="--color-heat-0"
          type="color"
        />
        <TokenSwatch
          name="--color-heat-1"
          cssVar="--color-heat-1"
          type="color"
        />
        <TokenSwatch
          name="--color-heat-2"
          cssVar="--color-heat-2"
          type="color"
        />
        <TokenSwatch
          name="--color-heat-3"
          cssVar="--color-heat-3"
          type="color"
        />
        <TokenSwatch
          name="--color-heat-4"
          cssVar="--color-heat-4"
          type="color"
        />
        <TokenSwatch
          name="--color-heat-5"
          cssVar="--color-heat-5"
          type="color"
        />
        <TokenSwatch
          name="--color-heat-cell-edge"
          cssVar="--color-heat-cell-edge"
          type="color"
        />
      </TokenSection>

      {/* Track Hues */}
      <TokenSection title="Track Hues">
        <TokenSwatch
          name="--color-track-blue"
          cssVar="--color-track-blue"
          type="color"
        />
        <TokenSwatch
          name="--color-track-teal"
          cssVar="--color-track-teal"
          type="color"
        />
        <TokenSwatch
          name="--color-track-ochre"
          cssVar="--color-track-ochre"
          type="color"
        />
        <TokenSwatch
          name="--color-track-maroon"
          cssVar="--color-track-maroon"
          type="color"
        />
        <TokenSwatch
          name="--color-track-slate"
          cssVar="--color-track-slate"
          type="color"
        />
      </TokenSection>

      {/* Measures */}
      <TokenSection title="Type Measures (Width Constraints)">
        <MeasureSample name="--measure-prose" cssVar="--measure-prose" />
        <MeasureSample name="--measure-breakout" cssVar="--measure-breakout" />
        <MeasureSample name="--measure-full" cssVar="--measure-full" />
      </TokenSection>

      {/* Spacing Scale */}
      <TokenSection title="Spacing Scale">
        <SpacingSample name="--space-0" cssVar="--space-0" />
        <SpacingSample name="--space-1" cssVar="--space-1" />
        <SpacingSample name="--space-2" cssVar="--space-2" />
        <SpacingSample name="--space-3" cssVar="--space-3" />
        <SpacingSample name="--space-4" cssVar="--space-4" />
        <SpacingSample name="--space-5" cssVar="--space-5" />
        <SpacingSample name="--space-6" cssVar="--space-6" />
        <SpacingSample name="--space-7" cssVar="--space-7" />
      </TokenSection>

      {/* Radius Scale */}
      <TokenSection title="Border Radius">
        <RadiusSample name="--radius-sm" cssVar="--radius-sm" />
        <RadiusSample name="--radius-md" cssVar="--radius-md" />
        <RadiusSample name="--radius-lg" cssVar="--radius-lg" />
        <RadiusSample name="--radius-pill" cssVar="--radius-pill" />
      </TokenSection>

      {/* Border Weights */}
      <TokenSection title="Border Weights">
        <BorderSample name="--border-hairline" cssVar="--border-hairline" />
        <BorderSample name="--border-regular" cssVar="--border-regular" />
        <BorderSample name="--border-thick" cssVar="--border-thick" />
      </TokenSection>

      {/* Typography */}
      <TokenSection title="Typography">
        <div className="typography-group">
          <h3 className="typography-group__title">Sans-Serif (Libre Franklin)</h3>
          <TypographySample
            name="Heading (700, large)"
            className="typography__sans-lg"
            text="The quick brown fox"
          />
          <TypographySample
            name="Heading (700, medium)"
            className="typography__sans-md"
            text="The quick brown fox"
          />
          <TypographySample
            name="Heading (700, small)"
            className="typography__sans-sm"
            text="The quick brown fox"
          />
        </div>

        <div className="typography-group">
          <h3 className="typography-group__title">Serif (Source Serif 4)</h3>
          <TypographySample
            name="Body (400, regular)"
            className="typography__serif"
            text="The quick brown fox jumps over the lazy dog."
          />
        </div>

        <div className="typography-group">
          <h3 className="typography-group__title">Monospace (IBM Plex Mono)</h3>
          <TypographySample
            name="Code (400)"
            className="typography__mono"
            text="const token = 'value';"
          />
        </div>
      </TokenSection>
    </main>
  );
}
