// ---------------------------------------------------------------------------
// Chart CSV sidecars (design §6.3, Task C): "chart data is inline by
// default ... with `data: ./enrollment.csv` available as an escape hatch for
// genuinely large datasets."
//
// This module owns only the FORMAT (turning CSV text into the same
// {label, value} row shape inline `data:` already produces). Filesystem
// resolution — which is where path traversal and symlink defenses live — is
// manifest.ts's `resolveChartSidecars`, built on the same `resolveLessonPath`
// chokepoint every other manifest-referenced path goes through. Keeping this
// module pure (no `fs`, no knowledge of course directories) is what keeps it
// trivially unit-testable and keeps the traversal-defense surface at one
// function instead of two.
// ---------------------------------------------------------------------------

export interface ChartCsvRow {
  label: string;
  value: number;
}

/**
 * Parses a chart data sidecar CSV into rows.
 *
 * Deliberately a small, honest parser for a deliberately small format —
 * two columns, a required header row naming them ("label,value", any
 * order), comma-separated, with RFC4180 double-quote escaping for a label
 * that itself contains a comma. A content repo needing a richer CSV dialect
 * is exactly the "genuinely large dataset" case the design says belongs
 * somewhere else, not a hand-rolled reader here.
 *
 * Throws a message naming the specific problem (empty file, missing
 * header column, a non-numeric value, on which row) — the caller
 * (manifest.ts) prefixes the sidecar's own filename onto it, matching the
 * error-quality convention the rest of the importer uses (design §8).
 */
export function parseChartCsv(text: string): ChartCsvRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new Error('CSV is empty — expected a header row ("label,value") and at least one data row.');
  }

  const header = splitCsvLine(lines[0]!).map((cell) => cell.trim().toLowerCase());
  const labelIndex = header.indexOf('label');
  const valueIndex = header.indexOf('value');
  if (labelIndex === -1 || valueIndex === -1) {
    throw new Error(`CSV header must contain "label" and "value" columns, got: "${lines[0]}"`);
  }

  const rows: ChartCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const cells = splitCsvLine(lines[i]!);
    const label = (cells[labelIndex] ?? '').trim();
    const rawValue = (cells[valueIndex] ?? '').trim();

    if (label === '') {
      throw new Error(`CSV row ${lineNumber}: empty "label" — every row needs one.`);
    }
    const value = Number(rawValue);
    if (rawValue === '' || Number.isNaN(value)) {
      throw new Error(`CSV row ${lineNumber}: "value" is not a number, got ${JSON.stringify(rawValue)}.`);
    }
    rows.push({ label, value });
  }

  if (rows.length === 0) {
    throw new Error('CSV has a header row but no data rows.');
  }

  return rows;
}

/**
 * Splits one CSV line on commas, honoring RFC4180 double-quote escaping: a
 * quoted field may itself contain commas, and `""` inside a quoted field is
 * a literal double quote.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
