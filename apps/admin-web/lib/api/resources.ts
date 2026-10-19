'use client';

import type {
  ApprovalRequestDto,
  BusinessDayDto,
  ConfigEntryDto,
  ConfigResolved,
  CredentialDto,
  DepartmentDto,
  DeviceDto,
  LegalEntityDto,
  LocationDto,
  OrgUnitDto,
  RegisterDto,
  RoleAssignmentDto,
  RoleDto,
  ScopeKind,
  UserDto,
} from '@pos/contracts';
import { type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/components/ui/Toast';

import { api, describeError } from './client';

export interface AuditEntry {
  id: string;
  seq: number;
  actorKind: 'user' | 'device' | 'system' | 'api_client' | 'operator';
  actorId: string | null;
  onBehalfOf: string | null;
  deviceId: string | null;
  locationId: string | null;
  action: string;
  resourceKind: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  approvalId: string | null;
  correlationId: string | null;
  prevHash: string | null;
  hash: string;
  occurredAt: string;
}
export interface AuditPage {
  items: AuditEntry[];
  nextCursor: number | null;
}
export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBrokenSeq?: number;
  headMatches: boolean;
  headSeq: number | null;
}

export const keys = {
  orgUnits: ['org-units'] as const,
  legalEntities: ['legal-entities'] as const,
  locations: ['locations'] as const,
  departments: (locationId: string) => ['departments', locationId] as const,
  registers: ['registers'] as const,
  users: ['users'] as const,
  roles: ['roles'] as const,
  assignments: (userId: string) => ['assignments', userId] as const,
  credentials: (userId: string) => ['credentials', userId] as const,
  approvals: (status: string, locationId?: string) =>
    ['approvals', status, locationId ?? ''] as const,
  devices: ['devices'] as const,
  audit: ['audit'] as const,
  config: ['config'] as const,
  businessDays: (locationId: string) => ['business-days', locationId] as const,
};

export const useOrgUnits = () =>
  useQuery({ queryKey: keys.orgUnits, queryFn: () => api<OrgUnitDto[]>('/org-units') });
export const useLegalEntities = () =>
  useQuery({
    queryKey: keys.legalEntities,
    queryFn: () => api<LegalEntityDto[]>('/legal-entities'),
  });
export const useLocations = () =>
  useQuery({ queryKey: keys.locations, queryFn: () => api<LocationDto[]>('/locations') });
export const useRegisters = () =>
  useQuery({ queryKey: keys.registers, queryFn: () => api<RegisterDto[]>('/registers') });
export const useDepartments = (locationId: string | undefined) =>
  useQuery({
    queryKey: keys.departments(locationId ?? ''),
    queryFn: () => api<DepartmentDto[]>(`/locations/${locationId}/departments`),
    enabled: Boolean(locationId),
  });
export const useBusinessDays = (locationId: string | undefined) =>
  useQuery({
    queryKey: keys.businessDays(locationId ?? ''),
    queryFn: () => api<BusinessDayDto[]>(`/locations/${locationId}/business-days`),
    enabled: Boolean(locationId),
  });
export const useUsers = (enabled = true) =>
  useQuery({ queryKey: keys.users, queryFn: () => api<UserDto[]>('/users'), enabled });
export const useRoles = (enabled = true) =>
  useQuery({ queryKey: keys.roles, queryFn: () => api<RoleDto[]>('/roles'), enabled });
export const useAssignments = (userId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: keys.assignments(userId ?? ''),
    queryFn: () => api<RoleAssignmentDto[]>('/role-assignments', { query: { userId } }),
    enabled: Boolean(userId) && enabled,
  });
export const useCredentials = (userId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: keys.credentials(userId ?? ''),
    queryFn: () => api<CredentialDto[]>(`/users/${userId}/credentials`),
    enabled: Boolean(userId) && enabled,
  });
export const useApprovals = (
  status: ApprovalRequestDto['status'],
  enabled = true,
  locationId?: string,
) =>
  useQuery({
    queryKey: keys.approvals(status, locationId),
    queryFn: () => api<ApprovalRequestDto[]>('/approvals', { query: { status, locationId } }),
    enabled,
    refetchInterval: status === 'pending' ? 30_000 : false,
  });
export const useDevices = (enabled = true) =>
  useQuery({
    queryKey: keys.devices,
    queryFn: () => api<DeviceDto[]>('/devices'),
    enabled,
    refetchInterval: 30_000,
  });

export function useConfigEffective(key: string, scopeKind: ScopeKind, scopeId: string | undefined) {
  return useQuery({
    queryKey: [...keys.config, 'effective', key, scopeKind, scopeId ?? ''],
    queryFn: () => api<ConfigResolved>('/config', { query: { key, scopeKind, scopeId } }),
    enabled: Boolean(scopeId),
  });
}
export function useConfigHistory(key: string, scopeKind: ScopeKind, scopeId: string | undefined) {
  return useQuery({
    queryKey: [...keys.config, 'history', key, scopeKind, scopeId ?? ''],
    queryFn: () => api<ConfigEntryDto[]>('/config/history', { query: { key, scopeKind, scopeId } }),
    enabled: Boolean(scopeId),
  });
}

/** Mutation with toast feedback and cache invalidation. Errors are rethrown so forms can map 422s. */
export function useApiMutation<TInput, TOutput>(options: {
  mutationFn(input: TInput): Promise<TOutput>;
  invalidate?: readonly QueryKey[];
  success?: string | ((out: TOutput) => string);
  /** Forms show their own inline errors; skip the toast for them. */
  silentError?: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (out) => {
      await Promise.all(
        (options.invalidate ?? []).map((k) => client.invalidateQueries({ queryKey: k })),
      );
      if (options.success)
        toast.success(
          typeof options.success === 'function' ? options.success(out) : options.success,
        );
    },
    onError: (error) => {
      if (!options.silentError) toast.error(describeError(error));
    },
  });
}
