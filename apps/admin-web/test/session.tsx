import type { PrincipalDto } from '@pos/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { ToastProvider } from '@/components/ui/Toast';

export const PRINCIPAL: PrincipalDto = {
  tenantId: '0190a000-0000-7000-8000-000000000001',
  subjectId: '0190a000-0000-7000-8000-000000000002',
  kind: 'user',
  mfaVerified: true,
  mfaRequired: false,
  assignmentsVersion: 1,
  assignments: [],
  permissions: [],
};

/** Replaces the session context so components can render without the network. */
export function mockSession(principal: Partial<PrincipalDto> = {}) {
  const value = {
    status: 'authenticated' as const,
    principal: { ...PRINCIPAL, ...principal },
    tenant: null,
    user: null,
    error: null,
    reload: vi.fn(),
    logout: vi.fn(),
  };
  return value;
}

export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}
