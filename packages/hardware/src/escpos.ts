/**
 * ESC/POS encoder. Pure functions, no I/O, so receipts can be snapshot-tested byte for byte.
 * Reference: Epson ESC/POS command set (the subset every network/USB receipt printer implements).
 */
import type { PrintDocument, PrintLine } from './types.js';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const ESCPOS = {
  init: [ESC, 0x40],
  cutFull: [GS, 0x56, 0x00],
  cutPartialFeed: [GS, 0x56, 0x42, 0x03],
  /** ESC p m t1 t2: pulse drawer pin 2 (m=0) for t1*2 ms on, t2*2 ms off. */
  drawerKick: [ESC, 0x70, 0x00, 0x32, 0x32],
  /** DLE EOT n: real-time status (1 = printer, 2 = offline cause, 3 = error cause, 4 = paper sensor). */
  statusPrinter: [0x10, 0x04, 0x01],
  statusOffline: [0x10, 0x04, 0x02],
  statusPaper: [0x10, 0x04, 0x04],
} as const;

export interface EscPosOptions {
  /** Characters per line at normal width (80 mm paper = 48, 58 mm = 32). */
  readonly columns?: number;
  /** Code page byte for ESC t. 0 = CP437, 16 = WPC1252. */
  readonly codePage?: number;
}

const ALIGN = { left: 0, center: 1, right: 2 } as const;

/** Encode a string to single-byte WPC1252, replacing anything unmappable with "?". */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20ac) out.push(0x80);
    else if (code < 0x100) out.push(code);
    else out.push(0x3f);
  }
  return out;
}

function lineBytes(line: PrintLine, columns: number): number[] {
  if (typeof line === 'string') return [...encodeText(line), LF];
  if ('rule' in line) return [...encodeText('-'.repeat(columns)), LF];
  if ('barcode' in line) {
    const kind = line.kind ?? 'code128';
    const system = { upca: 65, ean13: 67, code128: 73 }[kind];
    // Code 128 needs a code set prefix ("{B") so that mixed text is encoded as set B.
    const data = encodeText(kind === 'code128' ? `{B${line.barcode}` : line.barcode);
    return [
      ESC,
      0x61,
      ALIGN.center,
      GS,
      0x68,
      80, // height
      GS,
      0x48,
      2, // HRI below
      GS,
      0x6b,
      system,
      data.length,
      ...data,
      LF,
      ESC,
      0x61,
      ALIGN.left,
    ];
  }
  if ('qr' in line) {
    const data = encodeText(line.qr);
    const len = data.length + 3;
    return [
      ESC,
      0x61,
      ALIGN.center,
      GS,
      0x28,
      0x6b,
      4,
      0,
      49,
      65,
      50,
      0, // model 2
      GS,
      0x28,
      0x6b,
      3,
      0,
      49,
      67,
      6, // module size 6
      GS,
      0x28,
      0x6b,
      3,
      0,
      49,
      69,
      49, // error correction M
      GS,
      0x28,
      0x6b,
      len & 0xff,
      len >> 8,
      49,
      80,
      48,
      ...data, // store
      GS,
      0x28,
      0x6b,
      3,
      0,
      49,
      81,
      48, // print
      LF,
      ESC,
      0x61,
      ALIGN.left,
    ];
  }
  const mode =
    (line.bold ? 0x08 : 0) |
    (line.doubleHeight ? 0x10 : 0) |
    (line.doubleWidth ? 0x20 : 0) |
    (line.underline ? 0x80 : 0);
  return [
    ESC,
    0x61,
    ALIGN[line.align ?? 'left'],
    ESC,
    0x21,
    mode,
    ...encodeText(line.text),
    LF,
    ESC,
    0x21,
    0,
    ESC,
    0x61,
    ALIGN.left,
  ];
}

/** Two-column row (label left, amount right) padded to the paper width. */
export function twoColumns(left: string, right: string, columns: number): string {
  const space = Math.max(1, columns - left.length - right.length);
  if (left.length + right.length + 1 > columns) {
    const keep = Math.max(0, columns - right.length - 1);
    return `${left.slice(0, keep)} ${right}`;
  }
  return `${left}${' '.repeat(space)}${right}`;
}

export function encodeDocument(document: PrintDocument, options: EscPosOptions = {}): Uint8Array {
  const columns = options.columns ?? 48;
  const bytes: number[] = [...ESCPOS.init, ESC, 0x74, options.codePage ?? 16];
  for (const line of document.lines) bytes.push(...lineBytes(line, columns));
  if (document.cut ?? true) bytes.push(LF, LF, LF, ...ESCPOS.cutPartialFeed);
  if (document.openDrawer) bytes.push(...ESCPOS.drawerKick);
  return Uint8Array.from(bytes);
}

/** Decode the single byte answered to DLE EOT 1 / 2 / 4. Bit meanings per the Epson reference. */
export function decodeStatus(printer?: number, offline?: number, paper?: number) {
  return {
    drawerOpen: printer !== undefined ? (printer & 0x04) === 0 : undefined,
    offline: printer !== undefined ? (printer & 0x08) !== 0 : false,
    coverOpen: offline !== undefined ? (offline & 0x04) !== 0 : false,
    paperOut: paper !== undefined ? (paper & 0x60) !== 0 : false,
    paperLow: paper !== undefined ? (paper & 0x0c) !== 0 : false,
  };
}
