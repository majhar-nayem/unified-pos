import type { Context } from '@opentelemetry/api';
import type { LogBody } from '@opentelemetry/api-logs';
import type { LogRecordProcessor, ReadWriteLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { redactAttributesInPlace, redactValue, scrubString, type RedactOptions } from './redact.js';

type Bag = Record<string, unknown>;

/** Scrubs span, event and link attributes and the status message before the wrapped processor exports the span. */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly next: SpanProcessor,
    private readonly options?: RedactOptions,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    redactAttributesInPlace(span.attributes as Bag, this.options);
    for (const event of span.events)
      redactAttributesInPlace(event.attributes as Bag | undefined, this.options);
    for (const link of span.links)
      redactAttributesInPlace(link.attributes as Bag | undefined, this.options);
    const status = span.status as { message?: string };
    if (status.message) status.message = scrubString(status.message);
    this.next.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/** Scrubs log record attributes and body before the wrapped processor exports the record. */
export class RedactingLogRecordProcessor implements LogRecordProcessor {
  constructor(
    private readonly next: LogRecordProcessor,
    private readonly options?: RedactOptions,
  ) {}

  onEmit(record: ReadWriteLogRecord, context?: Context): void {
    redactAttributesInPlace(record.attributes as Bag, this.options);
    if (typeof record.body === 'string') {
      record.setBody(scrubString(record.body));
    } else if (record.body !== undefined && record.body !== null) {
      record.setBody(redactValue(record.body, this.options) as LogBody);
    }
    this.next.onEmit(record, context);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}
