import { describe, expect, it } from 'vitest';
import { parseChartCsv } from './csv.ts';

describe('parseChartCsv', () => {
  it('parses a simple label,value CSV', () => {
    const rows = parseChartCsv(['label,value', 'MCP servers,5', 'Agents,6'].join('\n'));
    expect(rows).toEqual([
      { label: 'MCP servers', value: 5 },
      { label: 'Agents', value: 6 },
    ]);
  });

  it('accepts the header columns in either order', () => {
    const rows = parseChartCsv(['value,label', '5,MCP servers'].join('\n'));
    expect(rows).toEqual([{ label: 'MCP servers', value: 5 }]);
  });

  it('honors RFC4180 quoting for a label containing a comma', () => {
    const rows = parseChartCsv(['label,value', '"Complexity, Craft",3'].join('\n'));
    expect(rows).toEqual([{ label: 'Complexity, Craft', value: 3 }]);
  });

  it('unescapes a doubled quote inside a quoted label', () => {
    const rows = parseChartCsv(['label,value', '"Say ""hi""",1'].join('\n'));
    expect(rows).toEqual([{ label: 'Say "hi"', value: 1 }]);
  });

  it('tolerates blank lines between rows', () => {
    const rows = parseChartCsv(['label,value', '', 'a,1', '', 'b,2', ''].join('\n'));
    expect(rows).toEqual([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ]);
  });

  it('parses negative and decimal values', () => {
    const rows = parseChartCsv(['label,value', 'a,-2.5'].join('\n'));
    expect(rows).toEqual([{ label: 'a', value: -2.5 }]);
  });

  it('throws naming an empty file', () => {
    expect(() => parseChartCsv('')).toThrow(/empty/i);
  });

  it('throws naming a missing header column', () => {
    expect(() => parseChartCsv(['name,count', 'a,1'].join('\n'))).toThrow(/header/i);
  });

  it('throws naming the row for a non-numeric value', () => {
    expect(() => parseChartCsv(['label,value', 'a,five'].join('\n'))).toThrow(/row 2.*not a number/is);
  });

  it('throws naming the row for an empty label', () => {
    expect(() => parseChartCsv(['label,value', ',5'].join('\n'))).toThrow(/row 2.*label/is);
  });

  it('throws when the file has a header but no data rows', () => {
    expect(() => parseChartCsv('label,value\n')).toThrow(/no data rows/i);
  });
});
