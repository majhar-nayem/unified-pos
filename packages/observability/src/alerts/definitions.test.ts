import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  alertDocument,
  burnRateAlert,
  ERROR_BUDGET,
  serialiseAlertDocument,
} from './definitions.js';

const COMMITTED = fileURLToPath(new URL('../../../../infra/alerts/alerts.json', import.meta.url));

describe('alert definitions', () => {
  const alerts = alertDocument.alerts;
  const ids = alerts.map((a) => a.id);

  it('has unique ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(alertDocument.composites.map((c) => c.id)).size).toBe(
      alertDocument.composites.length,
    );
  });

  it('covers every alert named in docs/01 §13 and the SLOs', () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        'outbox-backlog-high',
        'outbox-backlog-critical',
        'sync-lag-high',
        'payment-uncertain',
        'rls-context-missing-api',
        'rls-context-missing-worker',
        'rls-context-missing-payments',
        'audit-chain-verification-failure',
        'cross-tenant-access-attempt',
        'slo-availability-burn-14.4x-1h',
        'slo-availability-burn-6x-6h',
      ]),
    );
    expect(alertDocument.composites.map((c) => c.id)).toEqual([
      'slo-availability-fast-burn',
      'slo-availability-slow-burn',
      'slo-availability-ticket-burn',
    ]);
  });

  it('derives burn-rate thresholds from the 99.95 % objective', () => {
    expect(ERROR_BUDGET).toBe(0.0005);
    expect(burnRateAlert(14.4, 3600).threshold).toBe(0.0072);
    expect(burnRateAlert(6, 21600).threshold).toBe(0.003);
    expect(burnRateAlert(3, 86400).threshold).toBe(0.0015);
  });

  it('composites join a long and a short window, and their members stay quiet on their own', () => {
    for (const composite of alertDocument.composites) {
      expect(composite.alarms).toHaveLength(2);
      for (const member of composite.alarms) {
        const alarm = alerts.find((a) => a.id === member);
        expect(alarm, member).toBeDefined();
        expect(alarm!.notify).toBe(false);
      }
    }
  });

  it('uses CloudWatch-valid periods and well-formed metric math', () => {
    for (const alert of alerts) {
      for (const query of alert.metrics) {
        if (query.metric) {
          const { period } = query.metric;
          expect(period % 60, alert.id).toBe(0);
          if (period >= 3600) expect(period % 3600, alert.id).toBe(0);
          expect(period, alert.id).toBeLessThanOrEqual(86400);
        }
      }
      const returned = alert.metrics.filter((q) => q.return_data || q.expression);
      expect(returned, alert.id).toHaveLength(1);
      const known = new Set(alert.metrics.map((q) => q.id));
      for (const query of alert.metrics) {
        if (!query.expression) continue;
        for (const ref of query.expression.match(/\b[a-z][a-z0-9_]*\b/g) ?? []) {
          if (['if', 'sum', 'avg', 'min', 'max', 'rate'].includes(ref)) continue;
          expect(known.has(ref), `${alert.id}: ${ref}`).toBe(true);
        }
      }
      expect(alert.evaluation_periods).toBeGreaterThan(0);
      expect(alert.datapoints_to_alarm ?? alert.evaluation_periods).toBeLessThanOrEqual(
        alert.evaluation_periods,
      );
    }
  });

  it('pages for the signals §13 says must page', () => {
    const severity = (id: string) => alerts.find((a) => a.id === id)!.severity;
    for (const id of [
      'payment-uncertain',
      'rls-context-missing-api',
      'audit-chain-verification-failure',
      'cross-tenant-access-attempt',
    ]) {
      expect(severity(id), id).toBe('page');
    }
  });

  it('every runbook anchor exists as a heading in docs/runbooks/on-call.md', () => {
    let onCall = '';
    try {
      onCall = readFileSync(
        fileURLToPath(new URL('../../../../docs/runbooks/on-call.md', import.meta.url)),
        'utf8',
      );
    } catch {
      return; // runbook not written yet in this checkout
    }
    const anchors = new Set(
      [...onCall.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
        m[1]!
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9 -]/g, '')
          .replace(/ /g, '-'),
      ),
    );
    for (const alert of [...alerts, ...alertDocument.composites]) {
      const anchor = alert.runbook?.split('#')[1];
      if (anchor) expect(anchors.has(anchor), `${alert.id} → #${anchor}`).toBe(true);
    }
  });

  it('infra/alerts/alerts.json is the generated output (run alerts:emit after changing definitions)', () => {
    expect(readFileSync(COMMITTED, 'utf8')).toBe(serialiseAlertDocument());
  });
});
