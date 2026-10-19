import { metrics, type Attributes, type Meter } from '@opentelemetry/api';

/**
 * Operational gauges and counters behind the alerts in infra/alerts (docs/01 §13): outbox backlog, sync lag,
 * payment `uncertain` count, RLS context missing, audit chain failures, cross-tenant attempts.
 *
 * Event-like signals are exposed twice: a `.total` counter for dashboards and a gauge holding the occurrences in
 * the last five minutes, which is what the CloudWatch alarms watch (a cumulative counter would stay above zero
 * until the next deploy).
 */

type Probe = () => number | Promise<number>;

export interface OperationalProbes {
  /** Unpublished rows in audit.outbox_events. */
  readonly outboxBacklog?: Probe;
  /** Age in seconds of the oldest unpublished outbox row (0 when empty). */
  readonly outboxOldestAgeSeconds?: Probe;
  /** p95 sync feed lag across online devices, in seconds. */
  readonly syncLagSeconds?: Probe;
  /** Payment attempts currently in the `uncertain` state. */
  readonly paymentUncertainCount?: Probe;
  /** Pending entries (or lag) per Redis stream/consumer group. */
  readonly streamLag?: () => Record<string, number> | Promise<Record<string, number>>;
}

export class WindowedCounter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(count = 1): void {
    const at = this.now();
    for (let i = 0; i < count; i += 1) this.stamps.push(at);
  }

  count(): number {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
    return this.stamps.length;
  }
}

export interface OperationalMetrics {
  /** A request ran without `app.tenant_id` set. Must stay at zero; any occurrence pages. */
  recordRlsContextMissing(attributes?: Attributes): void;
  recordAuditChainVerificationFailure(attributes?: Attributes): void;
  recordCrossTenantAttempt(attributes?: Attributes): void;
}

export interface OperationalOptions {
  readonly meter?: Meter;
  readonly windowMs?: number;
  readonly now?: () => number;
}

export function registerOperationalMetrics(
  probes: OperationalProbes = {},
  options: OperationalOptions = {},
): OperationalMetrics {
  const meter = options.meter ?? metrics.getMeter('pos.operational');
  const windowMs = options.windowMs ?? 5 * 60 * 1000;
  const probeErrors = meter.createCounter('pos.probe.errors', {
    description: 'Operational probes that threw',
  });

  const observeProbe = (
    name: string,
    unit: string,
    description: string,
    probe: Probe | undefined,
  ): void => {
    if (!probe) return;
    meter.createObservableGauge(name, { unit, description }).addCallback(async (result) => {
      try {
        result.observe(await probe());
      } catch {
        probeErrors.add(1, { probe: name });
      }
    });
  };
  observeProbe('pos.outbox.backlog', '{event}', 'Unpublished outbox events', probes.outboxBacklog);
  observeProbe(
    'pos.outbox.oldest_age.seconds',
    's',
    'Age of the oldest unpublished outbox event',
    probes.outboxOldestAgeSeconds,
  );
  observeProbe('pos.sync.lag.seconds', 's', 'p95 sync feed lag', probes.syncLagSeconds);
  observeProbe(
    'pos.payment.uncertain.count',
    '{attempt}',
    'Payment attempts in the uncertain state',
    probes.paymentUncertainCount,
  );

  if (probes.streamLag) {
    const streamLag = probes.streamLag;
    meter
      .createObservableGauge('pos.stream.lag', {
        unit: '{entry}',
        description: 'Pending entries per stream and group',
      })
      .addCallback(async (result) => {
        try {
          for (const [stream, lag] of Object.entries(await streamLag()))
            result.observe(lag, { stream });
        } catch {
          probeErrors.add(1, { probe: 'pos.stream.lag' });
        }
      });
  }

  const event = (name: string, description: string) => {
    const total = meter.createCounter(`${name}.total`, { description });
    const window = new WindowedCounter(windowMs, options.now);
    meter
      .createObservableGauge(name, {
        unit: '{event}',
        description: `${description} (last ${windowMs / 60000} min)`,
      })
      .addCallback((result) => result.observe(window.count()));
    return (attributes?: Attributes) => {
      total.add(1, attributes);
      window.record();
    };
  };

  return {
    recordRlsContextMissing: event(
      'pos.rls.context_missing',
      'Requests that ran without a tenant context',
    ),
    recordAuditChainVerificationFailure: event(
      'pos.audit.chain.verification_failures',
      'Audit chain verification failures',
    ),
    recordCrossTenantAttempt: event(
      'pos.cross_tenant.attempts',
      'Cross-tenant access attempts refused',
    ),
  };
}
