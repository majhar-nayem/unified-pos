'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import { Alert, Spinner } from '@/components/ui/Misc';
import { useRequireSession, usePermissions } from '@/lib/auth/session';
import { NAV, NAV_GROUPS, pageAllowed } from '@/lib/nav';

export default function ShellLayout({ children }: { children: ReactNode }) {
  const session = useRequireSession();
  const perms = usePermissions();
  const pathname = usePathname() ?? '/';

  if (session.status !== 'authenticated') {
    return (
      <div className="login-wrap">
        <Spinner label="Checking your session" />
      </div>
    );
  }

  const visible = NAV.filter((item) => item.anyOf.length === 0 || item.anyOf.some(perms.has));
  const allowed = pageAllowed(pathname, perms.has);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">POS Admin</div>
        {NAV_GROUPS.map((group) => {
          const items = visible.filter((i) => i.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group}>
              <div className="nav-group" aria-hidden="true">
                {group}
              </div>
              {items.map((item) => {
                const active =
                  item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="nav-link"
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="main">
        <div className="topbar">
          <div className="topbar-meta">
            <strong data-testid="tenant-name">{session.tenant?.name ?? 'Tenant'}</strong>
            {session.tenant ? <span className="mono">{session.tenant.slug}</span> : null}
            {session.tenant ? <span>{session.tenant.defaultTimezone}</span> : null}
          </div>
          <div className="inline">
            <span data-testid="current-user">
              {session.user?.displayName ?? session.user?.email ?? 'Signed in'}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void session.logout()}>
              Sign out
            </Button>
          </div>
        </div>
        <main id="main" className="content" tabIndex={-1}>
          {session.error ? <Alert tone="warning">{session.error}</Alert> : null}
          {allowed ? (
            children
          ) : (
            <Alert tone="warning">
              Your roles do not include access to this page. Ask a tenant administrator to grant the
              required permission.
            </Alert>
          )}
        </main>
      </div>
    </div>
  );
}
