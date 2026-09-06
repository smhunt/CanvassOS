import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from './client';
import type {
  AuditEntry,
  Household,
  LegalHousehold,
  Meta,
  PointsCollection,
  Quality,
  Role,
  SearchResult,
  StatsOverview,
  User,
  UserRow,
} from './types';

export const ME_KEY = ['me'] as const;

// ------------------------------------------------------------------ auth

/** Current user, or null when signed out. 401 resolves to null rather than throwing. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<User | null> => {
      try {
        const r = await api.get<{ user: User }>('/auth/me', undefined, { silent401: true });
        return r.user;
      } catch (err) {
        if (isApiError(err, 401)) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api.post<{ user: User }>('/auth/login', body, { silent401: true }),
    onSuccess: (r) => {
      qc.clear();
      qc.setQueryData(ME_KEY, r.user);
    },
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; name: string; password: string }) =>
      api.post<{ user: User }>('/auth/accept-invite', body),
    onSuccess: (r) => {
      qc.clear();
      qc.setQueryData(ME_KEY, r.user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(ME_KEY, null);
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { current: string; next: string }) => api.post<void>('/auth/change-password', body),
  });
}

// ------------------------------------------------------------------ reference data

export function useMeta(enabled = true) {
  return useQuery({
    queryKey: ['meta'],
    queryFn: () => api.get<Meta>('/meta'),
    staleTime: 10 * 60_000,
    enabled,
  });
}

// ------------------------------------------------------------------ households

export interface PointFilters {
  ward: string[];
  community: string[];
  quality: Quality[];
}

export const EMPTY_FILTERS: PointFilters = { ward: [], community: [], quality: [] };

export function usePoints(filters: PointFilters) {
  return useQuery({
    queryKey: ['points', filters.ward, filters.community, filters.quality],
    queryFn: () =>
      api.get<PointsCollection>('/households/points', {
        ward: filters.ward,
        community: filters.community,
        quality: filters.quality,
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useHousehold(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['household', id],
    queryFn: () => api.get<Household>(`/households/${encodeURIComponent(id ?? '')}`),
    enabled: enabled && !!id,
    staleTime: 60_000,
    retry: (count, err) => !isApiError(err) && count < 2,
  });
}

export function useLegalHouseholds(enabled: boolean, ward?: string) {
  return useQuery({
    queryKey: ['legal', ward ?? ''],
    queryFn: () => api.get<{ households: LegalHousehold[] }>('/households/legal', { ward: ward || undefined }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSearch(q: string, enabled: boolean) {
  const term = q.trim();
  return useQuery({
    queryKey: ['search', term],
    queryFn: () => api.get<SearchResult>('/search', { q: term, limit: 25 }),
    enabled: enabled && term.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// ------------------------------------------------------------------ stats

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api.get<StatsOverview>('/stats/overview'),
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ users (admin)

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: UserRow[] }>('/users').then((r) => r.users),
    staleTime: 30_000,
    enabled,
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; name: string; role: Role }) =>
      api.post<{ user: UserRow; invite_url: string }>('/users/invite', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useReinviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ invite_url: string }>(`/users/${id}/reinvite`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: Role; active?: boolean; name?: string }) =>
      api.patch<{ user: UserRow }>(`/users/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

// ------------------------------------------------------------------ audit (admin)

export interface AuditFilters {
  user_id?: string;
  action?: string;
}

const AUDIT_PAGE = 100;

/** Newest first; each further page passes `before` = smallest id seen so far. */
export function useAudit(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: ['audit', filters.user_id ?? '', filters.action ?? ''],
    queryFn: ({ pageParam }) =>
      api
        .get<{ entries: AuditEntry[] }>('/audit', {
          limit: AUDIT_PAGE,
          user_id: filters.user_id || undefined,
          action: filters.action || undefined,
          before: pageParam || undefined,
        })
        .then((r) => r.entries),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length < AUDIT_PAGE ? undefined : last[last.length - 1]?.id),
    staleTime: 15_000,
  });
}
