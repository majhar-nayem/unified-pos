/**
 * Alert definitions as code (docs/01-system-architecture.md §12.1 SLOs and §13 alerts).
 * `pnpm --filter @pos/observability alerts:emit` writes them to infra/alerts/alerts.json, which the Terraform
 * `alarms` module turns into CloudWatch alarms. Application metrics reach CloudWatch through the collector's EMF
 * exporter (namespace POS/App, dimension service.name); burn-rate alerts read the ALB metrics.
 *
 * Field names are the Terraform variable's (snake_case). Dimension values starting with `$` are resolved by the module
 * ($alb = load balancer ARN suffix, $cluster = ECS cluster name).
 */

export type Severity = 'page' | 'ticket';

export interface MetricRef {
  readonly namespace: string;
  readonly name: string;
  readonly stat: string;
  readonly period: number;
  readonly dimensions?: Record<string, string>;
}

export interface MetricQuery {
  readonly id: string;
  readonly expression?: string;
  readonly label?: string;
  readonly return_data?: boolean;
  readonly metric?: MetricRef;
}

export interface AlertDefinition {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  readonly runbook?: string;
  readonly comparison:
    'GreaterThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanThreshold';
  readonly threshold: number;
  readonly period: number;
  readonly evaluation_periods: number;
  readonly datapoints_to_alarm?: number;
  readonly treat_missing_data?: 'notBreaching' | 'breaching' | 'ignore' | 'missing';
  /** false = building block of a composite alarm; it does not notify on its own. */
  readonly notify?: boolean;
  readonly metrics: readonly MetricQuery[];
}

export interface CompositeDefinition {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  readonly runbook?: string;
  /** All member alarms must be in ALARM (long window AND short window). */
  readonly alarms: readonly string[];
}

export interface AlertDocument {
  readonly alerts: readonly AlertDefinition[];
  readonly composites: readonly CompositeDefinition[];
}

/** 99.95 % monthly core API availability (§12.1) leaves an error budget of 0.05 %. */
export const AVAILABILITY_SLO = 0.9995;
export const ERROR_BUDGET = Number((1 - AVAILABILITY_SLO).toFixed(6));

const RUNBOOK = 'docs/runbooks/on-call.md';
const APP_NAMESPACE = 'POS/App';

function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds / 60}m`;
}

/** One window of a multi-window burn-rate alert: 5xx ratio over the window against burn × error budget. */
export function burnRateAlert(burn: number, windowSeconds: number): AlertDefinition {
  const alb = { LoadBalancer: '$alb' };
  const label = windowLabel(windowSeconds);
  return {
    id: `slo-availability-burn-${burn}x-${label}`,
    description: `API 5xx ratio over ${label} is burning the 99.95 % availability budget at ${burn}x`,
    severity: 'page',
    runbook: `${RUNBOOK}#slo-burn`,
    comparison: 'GreaterThanThreshold',
    threshold: Number((burn * ERROR_BUDGET).toFixed(6)),
    period: windowSeconds,
    evaluation_periods: 1,
    treat_missing_data: 'notBreaching',
    notify: false,
    metrics: [
      {
        id: 'err',
        metric: {
          namespace: 'AWS/ApplicationELB',
          name: 'HTTPCode_Target_5XX_Count',
          stat: 'Sum',
          period: windowSeconds,
          dimensions: alb,
        },
      },
      {
        id: 'req',
        metric: {
          namespace: 'AWS/ApplicationELB',
          name: 'RequestCount',
          stat: 'Sum',
          period: windowSeconds,
          dimensions: alb,
        },
      },
      {
        id: 'ratio',
        expression: 'IF(req > 0, err / req, 0)',
        label: `5xx ratio ${label}`,
        return_data: true,
      },
    ],
  };
}

/** Google SRE workbook multi-window, multi-burn-rate table for a 99.95 % objective. */
const BURN_WINDOWS = [
  { name: 'fast', severity: 'page', burn: 14.4, long: 3600, short: 300 },
  { name: 'slow', severity: 'page', burn: 6, long: 21600, short: 1800 },
  { name: 'ticket', severity: 'ticket', burn: 3, long: 86400, short: 7200 },
] as const;

function gauge(
  id: string,
  description: string,
  severity: Severity,
  runbookAnchor: string,
  metric: { name: string; service: string; stat?: string; period: number },
  threshold: number,
  evaluationPeriods: number,
  datapointsToAlarm: number = evaluationPeriods,
): AlertDefinition {
  return {
    id,
    description,
    severity,
    runbook: `${RUNBOOK}#${runbookAnchor}`,
    comparison: 'GreaterThanThreshold',
    threshold,
    period: metric.period,
    evaluation_periods: evaluationPeriods,
    datapoints_to_alarm: datapointsToAlarm,
    treat_missing_data: 'notBreaching',
    metrics: [
      {
        id: 'm',
        return_data: true,
        metric: {
          namespace: APP_NAMESPACE,
          name: metric.name,
          stat: metric.stat ?? 'Maximum',
          period: metric.period,
          dimensions: { 'service.name': metric.service },
        },
      },
    ],
  };
}

export function buildAlertDocument(): AlertDocument {
  const alerts: AlertDefinition[] = [];
  const composites: CompositeDefinition[] = [];

  for (const w of BURN_WINDOWS) {
    const long = burnRateAlert(w.burn, w.long);
    const short = burnRateAlert(w.burn, w.short);
    alerts.push(long, short);
    composites.push({
      id: `slo-availability-${w.name}-burn`,
      description: `Availability budget burning at ${w.burn}x over both ${windowLabel(w.long)} and ${windowLabel(w.short)}`,
      severity: w.severity,
      runbook: `${RUNBOOK}#slo-burn`,
      alarms: [long.id, short.id],
    });
  }

  alerts.push(
    gauge(
      'outbox-backlog-high',
      'Outbox backlog above 500 events for 5 minutes',
      'ticket',
      'outbox-backlog',
      { name: 'pos.outbox.backlog', service: 'worker', period: 60 },
      500,
      5,
    ),
    gauge(
      'outbox-backlog-critical',
      'Outbox backlog above 5000 events: relay is not keeping up',
      'page',
      'outbox-backlog',
      { name: 'pos.outbox.backlog', service: 'worker', period: 60 },
      5000,
      3,
    ),
    gauge(
      'outbox-relay-stalled',
      'Oldest unpublished outbox event is older than 5 minutes',
      'page',
      'outbox-backlog',
      { name: 'pos.outbox.oldest_age.seconds', service: 'worker', period: 60 },
      300,
      3,
    ),
    gauge(
      'sync-lag-high',
      'Sync feed lag above the 5 s objective for 5 minutes',
      'ticket',
      'sync-lag',
      { name: 'pos.sync.lag.seconds', service: 'api', period: 60 },
      5,
      5,
    ),
    gauge(
      'sync-lag-critical',
      'Sync feed lag above 60 s: devices are not receiving changes',
      'page',
      'sync-lag',
      { name: 'pos.sync.lag.seconds', service: 'api', period: 60 },
      60,
      3,
    ),
    gauge(
      'payment-uncertain',
      'Payment attempts stuck in uncertain for 10 minutes (reconciliation has not resolved them)',
      'page',
      'payment-uncertain',
      { name: 'pos.payment.uncertain.count', service: 'payments', period: 300 },
      0,
      2,
    ),
    gauge(
      'audit-chain-verification-failure',
      'Audit chain verification failed',
      'page',
      'audit-chain',
      { name: 'pos.audit.chain.verification_failures', service: 'worker', period: 300 },
      0,
      1,
    ),
    gauge(
      'cross-tenant-access-attempt',
      "A request tried to reach another tenant's data",
      'page',
      'cross-tenant',
      { name: 'pos.cross_tenant.attempts', service: 'api', period: 300 },
      0,
      1,
    ),
  );
  for (const service of ['api', 'worker', 'payments']) {
    alerts.push(
      gauge(
        `rls-context-missing-${service}`,
        `${service} ran a query without a tenant context (must be zero)`,
        'page',
        'rls-context-missing',
        { name: 'pos.rls.context_missing', service, period: 60 },
        0,
        1,
      ),
    );
  }
  return { alerts, composites };
}

export const alertDocument: AlertDocument = buildAlertDocument();

export function serialiseAlertDocument(document: AlertDocument = alertDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
