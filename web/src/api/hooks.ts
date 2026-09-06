import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from './client';
import type {
  Activity,
  Assignment,
  AuditEntry,
  Contact,
  ContactInput,
  DoorsResponse,
  FollowUp,
  Household,
  LegalHousehold,
  Meta,
  PointsCollection,
  Quality,
  Role,
  SearchResult,
  Sign,
  SignDetail,
  SignInput,
  PickupSign,
  SignRequest,
  SignStatus,
  StatsOverview,
  Street,
  TurfSummary,
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

// ------------------------------------------------------------------ Phase 2: canvassing

/** Streets for the turf builder's picker. Filters are optional; the whole list is ~1k rows. */
export function useStreets(filters: { ward?: string; community?: string } = {}) {
  return useQuery({
    queryKey: ['streets', filters.ward ?? '', filters.community ?? ''],
    queryFn: () =>
      api
        .get<{ streets: Street[] }>('/streets', {
          ward: filters.ward || undefined,
          community: filters.community || undefined,
        })
        .then((r) => r.streets),
    staleTime: 5 * 60_000,
  });
}

export const TURFS_KEY = ['turfs'] as const;
export const MINE_KEY = ['assignments', 'mine'] as const;

export function useTurfs(includeArchived = false) {
  return useQuery({
    queryKey: [...TURFS_KEY, includeArchived],
    queryFn: () =>
      api.get<{ turfs: TurfSummary[] }>('/turfs', { archived: includeArchived || undefined }).then((r) => r.turfs),
    staleTime: 30_000,
  });
}

export function useCreateTurf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; ward?: string | null; streets?: string[]; polygon?: unknown }) =>
      api.post<{ turf: TurfSummary }>('/turfs', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TURFS_KEY }),
  });
}

export function useUpdateTurf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; archived?: boolean }) =>
      api.patch<{ turf: TurfSummary }>(`/turfs/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: TURFS_KEY }),
  });
}

export function useAssignTurf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ turfId, userId }: { turfId: string; userId: string }) =>
      api.post(`/turfs/${turfId}/assign`, { user_id: userId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TURFS_KEY });
      void qc.invalidateQueries({ queryKey: MINE_KEY });
    },
  });
}

/** The volunteer's own turfs — the entry point to the door screen. */
export function useMyAssignments() {
  return useQuery({
    queryKey: MINE_KEY,
    queryFn: () => api.get<{ assignments: Assignment[] }>('/assignments/mine').then((r) => r.assignments),
    staleTime: 30_000,
  });
}

export function useDoors(turfId: string | undefined) {
  return useQuery({
    queryKey: ['turf-doors', turfId ?? ''],
    queryFn: () => api.get<DoorsResponse>(`/turfs/${turfId}/doors`),
    enabled: !!turfId,
    staleTime: 15_000,
  });
}

export function useContacts(householdId: string | undefined) {
  return useQuery({
    queryKey: ['contacts', householdId ?? ''],
    queryFn: () => api.get<{ contacts: Contact[] }>('/contacts', { household_id: householdId }).then((r) => r.contacts),
    enabled: !!householdId,
    staleTime: 5_000,
  });
}

/**
 * Record a door result. A `client_id` is generated per submission so a retry after a dropped
 * connection cannot double-count the door — the API treats it as an idempotency key.
 */
export function useRecordContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactInput) =>
      api.post<{ contact: Contact }>('/contacts', {
        client_id: body.client_id ?? crypto.randomUUID(),
        ...body,
      }),
    onSuccess: (_r, body) => {
      void qc.invalidateQueries({ queryKey: ['turf-doors'] });
      void qc.invalidateQueries({ queryKey: ['contacts', body.household_id] });
      void qc.invalidateQueries({ queryKey: MINE_KEY });
      void qc.invalidateQueries({ queryKey: ['points'] });
    },
  });
}

export function useFollowUps() {
  return useQuery({
    queryKey: ['follow-ups'],
    queryFn: () => api.get<{ follow_ups: FollowUp[] }>('/follow-ups').then((r) => r.follow_ups),
    staleTime: 30_000,
  });
}

export function useActivity(days = 14) {
  return useQuery({
    queryKey: ['activity', days],
    queryFn: () => api.get<Activity>('/activity', { days }),
    staleTime: 60_000,
  });
}

// ------------------------------------------------------------------ lawn signs

export const SIGNS_KEY = ['signs'] as const;

export function useSigns(filters: { status?: SignStatus[]; ward?: string[] } = {}) {
  return useQuery({
    queryKey: [...SIGNS_KEY, filters.status?.join(',') ?? '', filters.ward?.join(',') ?? ''],
    queryFn: () =>
      api.get<{ signs: Sign[] }>('/signs', { status: filters.status, ward: filters.ward }).then((r) => r.signs),
    staleTime: 30_000,
  });
}

export function useSign(id: string | undefined) {
  return useQuery({
    queryKey: ['sign', id ?? ''],
    queryFn: () => api.get<{ sign: SignDetail }>(`/signs/${id}`).then((r) => r.sign),
    enabled: !!id,
  });
}

/** The post-election retrieval worklist: everything still standing. */
export function usePickupList() {
  return useQuery({
    queryKey: ['signs', 'pickup'],
    queryFn: () => api.get<{ signs: PickupSign[] }>('/signs/pickup').then((r) => r.signs),
    staleTime: 30_000,
  });
}

/** Doors that asked for a sign at the door and have not got one yet. */
export function useSignRequests() {
  return useQuery({
    queryKey: ['signs', 'requests'],
    queryFn: () => api.get<{ requests: SignRequest[] }>('/signs/requests').then((r) => r.requests),
    staleTime: 30_000,
  });
}

export function usePlaceSign() {
  const qc = useQueryClient();
  return useMutation({
    // Same idempotency contract as a door contact: retrying on a bad rural signal must not plant a
    // second sign in the database.
    mutationFn: (body: SignInput) =>
      api.post<{ sign: Sign }>('/signs', { client_id: body.client_id ?? crypto.randomUUID(), ...body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SIGNS_KEY }),
  });
}

export function useUpdateSign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: SignStatus; label?: string; size?: string; note?: string }) =>
      api.patch<{ sign: SignDetail }>(`/signs/${id}`, body),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: SIGNS_KEY });
      void qc.invalidateQueries({ queryKey: ['sign', v.id] });
    },
  });
}

/** Photo upload is multipart, so it bypasses the JSON `api` helper. */
export function useUploadSignPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ signId, file }: { signId: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/signs/${signId}/photo`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(e?.error?.message ?? `Upload failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: SIGNS_KEY });
      void qc.invalidateQueries({ queryKey: ['sign', v.signId] });
    },
  });
}
