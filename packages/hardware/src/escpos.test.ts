import { describe, expect, it } from 'vitest';

import { ESCPOS, decodeStatus, encodeDocument, encodeText, twoColumns } from './escpos.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('ESC/POS encoder', () => {
  it('encodes a plain receipt: init, code page, text, feed, partial cut', () => {
    const bytes = encodeDocument({ lines: ['Hello'], cut: true });
    expect(hex(bytes)).toBe(['1b40', '1b7410', '48656c6c6f0a', '0a0a0a', '1d564203'].join(''));
  });

  it('applies alignment and style per line and resets after', () => {
    const bytes = encodeDocument({
      lines: [{ text: 'TOTAL', align: 'right', bold: true, doubleHeight: true }],
      cut: false,
    });
    // init + codepage, ESC a 2, ESC ! 0x18 (bold|double height), text, LF, ESC ! 0, ESC a 0
    expect(hex(bytes)).toBe(
      '1b40' + '1b7410' + '1b6102' + '1b2118' + '544f54414c' + '0a' + '1b2100' + '1b6100',
    );
  });

  it('appends the drawer kick pulse for cash sales', () => {
    const bytes = encodeDocument({ lines: ['x'], cut: false, openDrawer: true });
    expect(hex(bytes).endsWith(hex(Uint8Array.from(ESCPOS.drawerKick)))).toBe(true);
  });

  it('draws a rule across the configured width', () => {
    const bytes = encodeDocument({ lines: [{ rule: true }], cut: false }, { columns: 32 });
    expect(Buffer.from(bytes).toString('latin1')).toContain('-'.repeat(32) + '\n');
  });

  it('encodes a code128 barcode with the set-B prefix and a QR block', () => {
    const barcode = encodeDocument({ lines: [{ barcode: 'A12' }], cut: false });
    expect(hex(barcode)).toContain('1d6b49' + '05' + '7b42' + '413132'); // {B + "A12"
    const qr = hex(encodeDocument({ lines: [{ qr: 'https://r.example/1' }], cut: false }));
    expect(qr).toContain('1d286b03003143' + '06'); // module size
    expect(qr).toContain('1d286b0300315130'); // print stored symbol
  });

  it('maps euro to WPC1252 and unmappable characters to ?', () => {
    expect(encodeText('€5')).toEqual([0x80, 0x35]);
    expect(encodeText('日本')).toEqual([0x3f, 0x3f]);
    expect(encodeText('café')).toEqual([0x63, 0x61, 0x66, 0xe9]);
  });

  it('pads two-column rows to the paper width and truncates long labels', () => {
    expect(twoColumns('Oat Milk 1L', '9.00', 24)).toBe('Oat Milk 1L'.padEnd(20) + '9.00');
    const long = twoColumns('Extremely long product name here', '12.50', 24);
    expect(long).toHaveLength(24);
    expect(long.endsWith(' 12.50')).toBe(true);
  });

  it('decodes real-time status bytes', () => {
    expect(decodeStatus(0x12, 0x12, 0x12)).toMatchObject({
      offline: false,
      coverOpen: false,
      paperOut: false,
    });
    expect(decodeStatus(0x1a, 0x16, 0x72)).toMatchObject({
      offline: true,
      coverOpen: true,
      paperOut: true,
    });
    expect(decodeStatus(0x12, 0x12, 0x1e).paperLow).toBe(true);
  });
});
