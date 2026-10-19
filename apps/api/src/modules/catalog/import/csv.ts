/** Minimal RFC 4180 CSV reader/writer (no dependency). Records remember the physical line they start on. */

export interface CsvRecord {
  /** 1-based physical line the record starts on. */
  readonly line: number;
  readonly cells: readonly string[];
}

export class CsvSyntaxError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
    this.name = 'CsvSyntaxError';
  }
}

export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let atRecordStart = true;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    // A completely blank line is not a record.
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: recordLine, cells });
    cells = [];
    atRecordStart = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (atRecordStart) {
      recordLine = line;
      atRecordStart = false;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell.length > 0)
        throw new CsvSyntaxError('Unexpected quote inside an unquoted field', line);
      inQuotes = true;
    } else if (ch === ',') endCell();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      line += 1;
      endRecord();
    } else if (ch === '\n') {
      line += 1;
      endRecord();
    } else cell += ch;
  }
  if (inQuotes) throw new CsvSyntaxError('Unterminated quoted field', recordLine);
  if (!atRecordStart) endRecord();
  return records;
}

/** Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at the start of a cell). */
function safe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | null | undefined): string {
  const text = safe(value === null || value === undefined ? '' : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
