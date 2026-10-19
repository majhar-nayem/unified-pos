'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Badge, type Tone } from '@/components/ui/Badge';
import { Alert, PageHeader, Spinner } from '@/components/ui/Misc';
import { useApprovals, useDevices, useLocations, useUsers } from '@/lib/api/resources';
import { usePermissions, useSession } from '@/lib/auth/session';
import { deviceHealth, HEALTH_LABEL, needsAttention } from '@/lib/device-health';
import { formatRelative, formatTime, pluralise, titleCase } from '@/lib/format';

interface AttentionItem {
  id: string;
  tone: Tone;
  text: string;
  detail?: string;
  href: string;
  action: string;
}

const PLACEHOLDER_TILES = [
  { label: 'Net sales today', note: 'Arrives with reporting (F9)' },
  { label: 'Orders', note: 'Arrives with reporting (F9)' },
  { label: 'Average order', note: 'Arrives with reporting (F9)' },
  { label: 'Refunds', note: 'Arrives with reporting (F9)' },
];

export default function HomePage() {
  const perms = usePermissions();
  const session = useSession();
  const canApprovals = perms.has('approvals.view');
  const canDevices = perms.has('devices.view');
  const canUsers = perms.has('identity.user.view');
  const approvals = useApprovals('pending', canApprovals);
  const devices = useDevices(canDevices);
  const users = useUsers(canUsers);
  const locations = useLocations();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const items = useMemo<AttentionItem[]>(() => {
    const out: AttentionItem[] = [];
    const pending = (approvals.data ?? []).filter((a) => Date.parse(a.expiresAt) > now);
    if (pending.length > 0) {
      const oldest = [...pending].sort(
        (a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt),
      )[0]!;
      out.push({
        id: 'approvals',
        tone: 'warning',
        text: `${pluralise(pending.length, 'approval request')} waiting`,
        detail: `Oldest: ${titleCase(oldest.kind)}, ${formatRelative(oldest.requestedAt, now)}`,
        href: '/approvals',
        action: 'Review',
      });
    }
    const flagged = (devices.data ?? []).filter((d) => needsAttention(deviceHealth(d, now)));
    for (const d of flagged.slice(0, 5)) {
      const h = deviceHealth(d, now);
      out.push({
        id: `device-${d.id}`,
        tone: h === 'offline' ? 'danger' : 'warning',
        text: `${d.name}: ${HEALTH_LABEL[h].toLowerCase()}`,
        detail: d.lastSeenAt
          ? `Last seen ${formatRelative(d.lastSeenAt, now)}`
          : 'Enrolled but has not contacted the API yet',
        href: '/devices',
        action: 'View',
      });
    }
    if (flagged.length > 5) {
      out.push({
        id: 'devices-more',
        tone: 'warning',
        text: `${flagged.length - 5} more devices need attention`,
        href: '/devices',
        action: 'View all',
      });
    }
    const invited = (users.data ?? []).filter((u) => u.status === 'invited').length;
    if (invited > 0) {
      out.push({
        id: 'invites',
        tone: 'info',
        text: `${pluralise(invited, 'invitation')} not yet accepted`,
        href: '/users',
        action: 'Open',
      });
    }
    const onboarding = (locations.data ?? []).filter((l) => l.status === 'onboarding').length;
    if (onboarding > 0) {
      out.push({
        id: 'onboarding',
        tone: 'info',
        text: `${pluralise(onboarding, 'location')} still onboarding`,
        href: '/locations',
        action: 'Open',
      });
    }
    return out;
  }, [approvals.data, devices.data, users.data, locations.data, now]);

  const loading = (canApprovals && approvals.isLoading) || (canDevices && devices.isLoading);
  const errors = [approvals.error, devices.error].filter(Boolean);
  const devs = devices.data ?? [];
  const healthy = devs.filter((d) => deviceHealth(d, now) === 'healthy').length;
  const enrolled = devs.filter((d) => d.enrollmentStatus === 'enrolled').length;

  return (
    <>
      <PageHeader
        title={`Welcome${session.user ? `, ${session.user.displayName.split(' ')[0]}` : ''}`}
        description={`${session.tenant?.name ?? ''} · data as of ${formatTime(new Date(now))}`}
      />
      <section className="card" aria-labelledby="attention-heading" style={{ marginBottom: 16 }}>
        <h2 id="attention-heading" className="card-title">
          Needs attention
        </h2>
        {loading ? <Spinner label="Checking approvals and devices" /> : null}
        {errors.length > 0 ? (
          <Alert tone="warning">Some checks could not load, so this list may be incomplete.</Alert>
        ) : null}
        {!loading && items.length === 0 ? (
          <p data-testid="attention-empty" className="muted">
            Nothing needs your attention. Approvals are clear and every enrolled device has checked
            in recently.
          </p>
        ) : null}
        <ul className="attention-list">
          {items.map((item) => (
            <li key={item.id} className="attention-item" data-testid="attention-item">
              <div>
                <Badge tone={item.tone}>
                  {item.tone === 'danger' ? 'Urgent' : item.tone === 'warning' ? 'Check' : 'Info'}
                </Badge>{' '}
                <strong>{item.text}</strong>
                {item.detail ? <div className="muted">{item.detail}</div> : null}
              </div>
              <Link href={item.href}>{item.action}</Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Today’s sales" className="grid grid-4" style={{ marginBottom: 16 }}>
        {PLACEHOLDER_TILES.map((tile) => (
          <div key={tile.label} className="card">
            <div className="tile-label">{tile.label}</div>
            <div className="tile-value" aria-label="No data yet">
              —
            </div>
            <div className="tile-note">{tile.note}</div>
          </div>
        ))}
      </section>

      {canDevices ? (
        <section className="card" aria-label="Device summary">
          <h2 className="card-title">Devices</h2>
          <p style={{ margin: 0 }}>
            <Link href="/devices">
              <span className="num">{healthy}</span> of <span className="num">{enrolled}</span>{' '}
              enrolled devices healthy
            </Link>
            <span className="muted"> · healthy means seen in the last 5 minutes</span>
          </p>
        </section>
      ) : null}
    </>
  );
}
