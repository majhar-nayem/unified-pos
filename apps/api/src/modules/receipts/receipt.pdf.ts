import { orders } from '@pos/domain-core';

/**
 * A single-page PDF of the receipt, written without a PDF library: the fixed-width layout lines
 * (the same ones the ESC/POS printer gets) set in Courier on a 80 mm-wide page. This is NOT an
 * HTML-to-PDF conversion (that needs a headless browser, which the platform does not ship yet); it
 * is the plain-text layout, which keeps the PDF byte-for-byte deterministic and dependency-free.
 */
const POINT = 8; // font size
const CHAR_WIDTH = POINT * 0.6; // Courier advance
const LINE_HEIGHT = 10;
const MARGIN = 10;

const pdfString = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function renderReceiptPdf(
  lines: readonly orders.LayoutLine[],
  columns = orders.DEFAULT_COLUMNS,
): Uint8Array {
  const width = Math.ceil(columns * CHAR_WIDTH + MARGIN * 2);
  const height = Math.max(60, lines.length * LINE_HEIGHT + MARGIN * 2);
  const ops: string[] = [];
  lines.forEach((line, i) => {
    const text = orders.toPrinterText(line.text);
    if (!text.trim()) return;
    const printed = line.align === 'center' || line.align === 'right' ? text.trim() : text;
    const textWidth = printed.length * CHAR_WIDTH;
    const x =
      line.align === 'center'
        ? Math.max(MARGIN, (width - textWidth) / 2)
        : line.align === 'right'
          ? Math.max(MARGIN, width - MARGIN - textWidth)
          : MARGIN;
    const y = height - MARGIN - (i + 1) * LINE_HEIGHT + 2;
    ops.push(
      `BT /${line.bold ? 'F2' : 'F1'} ${POINT} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(printed)}) Tj ET`,
    );
  });
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
