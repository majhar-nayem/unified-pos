import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const ICON: Record<Tone, string> = {
  neutral: '○',
  success: '●',
  warning: '▲',
  danger: '■',
  info: '◆',
};

/** Status pill: icon + text so state never relies on colour alone (design plan §6). */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden="true" className="badge-icon">
        {ICON[tone]}
      </span>
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'active':
    case 'enrolled':
    case 'approved':
    case 'open':
    case 'healthy':
      return 'success';
    case 'onboarding':
    case 'pending':
    case 'invited':
    case 'closing':
    case 'provisioning':
    case 'offline':
      return 'warning';
    case 'suspended':
    case 'revoked':
    case 'rejected':
    case 'wiped':
    case 'deactivated':
    case 'expired':
    case 'disabled':
      return 'danger';
    case 'consumed':
    case 'closed':
      return 'info';
    default:
      return 'neutral';
  }
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replace(/_/g, ' ')}</Badge>;
}
