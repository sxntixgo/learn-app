/**
 * Stylelint plugin exporting the no-raw-tokens rule
 *
 * Bans hard-coded values that should use design tokens instead:
 * - Hex colours (#fff, #1a1a1a, etc.)
 * - CSS color functions (rgb(), hsl(), oklch())
 * - Raw font-family declarations
 *
 * Exempts: tokens.css and kitchen-sink pages where literals are intentional.
 */

const ruleImplementation = {
  ruleName: 'learn-app/no-raw-tokens',
  messages: {
    rejectedHex: 'Hard-coded hex color found. Use a --color-* token instead.',
    rejectedRgb: 'Hard-coded rgb() color found. Use a --color-* token instead.',
    rejectedHsl: 'Hard-coded hsl() color found. Use a --color-* token instead.',
    rejectedOklch: 'Hard-coded oklch() color found. Use a --color-* token instead.',
    rejectedFontFamily:
      'Hard-coded font-family found. Use --font-sans, --font-serif, or --font-mono token instead.',
  },

  meta: {
    url: 'web/app/tokens.css',
    fixable: false,
  },

  /**
   * Rule implementation. Checks all declarations for raw values.
   */
  create(root, { report, result }) {
    const filePath = root.source.input.file || '';

    // Exempt token definition files where raw literals are intentional
    if (
      filePath.includes('tokens.css') ||
      filePath.includes('kitchen-sink/page.css')
    ) {
      return;
    }

    root.walkDecls((decl) => {
      const value = decl.value;

      // Check for hex colors: #rrggbb, #rgb, #rrggbbaa, #rgba
      if (/#[0-9a-fA-F]{3,8}\b/.test(value)) {
        report({
          message: ruleImplementation.messages.rejectedHex,
          node: decl,
          word: value,
          result,
          ruleName: ruleImplementation.ruleName,
        });
      }

      // Check for rgb() or rgba()
      if (/rgb\(|rgba\(/.test(value)) {
        report({
          message: ruleImplementation.messages.rejectedRgb,
          node: decl,
          word: value,
          result,
          ruleName: ruleImplementation.ruleName,
        });
      }

      // Check for hsl() or hsla()
      if (/hsl\(|hsla\(/.test(value)) {
        report({
          message: ruleImplementation.messages.rejectedHsl,
          node: decl,
          word: value,
          result,
          ruleName: ruleImplementation.ruleName,
        });
      }

      // Check for oklch()
      if (/oklch\(/.test(value)) {
        report({
          message: ruleImplementation.messages.rejectedOklch,
          node: decl,
          word: value,
          result,
          ruleName: ruleImplementation.ruleName,
        });
      }

      // Check for raw font-family (but allow var() references and generic families)
      if (decl.prop === 'font-family') {
        // Allow var() references and single generic families (serif, sans-serif, monospace, etc.)
        // Only ban when there's an actual font name without var()
        const hasVar = /var\(/.test(value);
        const isGenericOnly =
          /^(serif|sans-serif|monospace|fantasy|cursive|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)/.test(
            value
          );

        if (!hasVar && !isGenericOnly) {
          // If it doesn't contain var() and isn't a generic-only value, it's likely a raw font name
          report({
            message: ruleImplementation.messages.rejectedFontFamily,
            node: decl,
            word: value,
            result,
            ruleName: ruleImplementation.ruleName,
          });
        }
      }
    });
  },
};

// Export as a plugin with the rule namespace
export default {
  'no-raw-tokens': ruleImplementation,
};
