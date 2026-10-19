const dateTime = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeWithSeconds = new Intl.DateTimeFormat('en-AU', { timeStyle: 'medium' });
const relative = new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' });

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
}

export function formatTime(iso: string | Date): string {
  return timeWithSeconds.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return relative.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return relative.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return relative.format(Math.round(diff / 3_600_000), 'hour');
  return relative.format(Math.round(diff / 86_400_000), 'day');
}

export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

export function pluralise(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
