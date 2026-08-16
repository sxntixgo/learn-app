#!/usr/bin/env node
/* global console, process */
/**
 * CSS Token Validation Tool
 *
 * Checks CSS files for hard-coded values that should use design tokens instead.
 * Bans:
 * - Hex colours (#fff, #1a1a1a, etc.)
 * - CSS color functions (rgb(), hsl(), oklch())
 * - Raw font-family declarations
 *
 * Exempts: tokens.css and kitchen-sink pages where raw values are intentional.
 */

import fs from 'fs';
import { globSync } from 'glob';

const RULE_NAME = 'learn-app/no-raw-tokens';

// Patterns to check for
const patterns = {
  hex: /#[0-9a-fA-F]{3,8}\b/g,
  rgb: /rgb\(|rgba\(/g,
  hsl: /hsl\(|hsla\(/g,
  oklch: /oklch\(/g,
};

const messageMap = {
  hex: 'Hard-coded hex color found. Use a --color-* token instead.',
  rgb: 'Hard-coded rgb() color found. Use a --color-* token instead.',
  hsl: 'Hard-coded hsl() color found. Use a --color-* token instead.',
  oklch: 'Hard-coded oklch() color found. Use a --color-* token instead.',
};

function isExempt(filePath) {
  return filePath.includes('tokens.css') || filePath.includes('kitchen-sink');
}

function checkCSSFile(filePath) {
  if (isExempt(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const errors = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNum = index + 1;

    // Skip comments
    if (line.trim().startsWith('/*') || line.trim().startsWith('*')) {
      return;
    }

    // Check each pattern
    Object.entries(patterns).forEach(([type, pattern]) => {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        errors.push({
          file: filePath,
          line: lineNum,
          column: match.index + 1,
          message: messageMap[type],
          value: match[0],
        });
      }
    });

    // Check for raw font-family
    if (line.includes('font-family:')) {
      const match = /font-family\s*:\s*([^;]+)/i.exec(line);
      if (match) {
        const value = match[1].trim();
        // Allow var() references, generic-only families, and CSS keywords
        const hasVar = /var\(/.test(value);
        const isGenericOnly =
          /^(serif|sans-serif|monospace|fantasy|cursive|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong)/.test(
            value
          );
        const isKeyword = /^(inherit|initial|revert|unset)$/.test(value);

        if (!hasVar && !isGenericOnly && !isKeyword) {
          errors.push({
            file: filePath,
            line: lineNum,
            column: line.indexOf('font-family') + 1,
            message:
              'Hard-coded font-family found. Use --font-sans, --font-serif, or --font-mono token instead.',
            value,
          });
        }
      }
    }
  });

  return errors;
}

function main() {
  const cssFiles = globSync('web/**/*.css', {
    ignore: 'node_modules/**',
  });

  let totalErrors = 0;
  const allErrors = [];

  cssFiles.forEach((file) => {
    const errors = checkCSSFile(file);
    if (errors.length > 0) {
      allErrors.push(...errors);
      totalErrors += errors.length;
    }
  });

  if (allErrors.length > 0) {
    console.error(`\n${RULE_NAME}: ${totalErrors} violation(s) found\n`);

    // Group by file
    const byFile = {};
    allErrors.forEach((err) => {
      if (!byFile[err.file]) {
        byFile[err.file] = [];
      }
      byFile[err.file].push(err);
    });

    Object.entries(byFile).forEach(([file, errors]) => {
      console.error(`${file}`);
      errors.forEach((err) => {
        console.error(
          `  ${err.line}:${err.column}  ✖  ${err.message}`
        );
        console.error(`     Value: ${err.value}`);
      });
    });

    process.exit(1);
  }

  console.log(`✓ ${RULE_NAME}: no violations found`);
  process.exit(0);
}

main();
