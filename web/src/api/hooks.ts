import { track } from '../analytics';
import { useEffect } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { onSynced, submitOrQueue } from '../offline/outbox';
import { cacheTurf, readCachedTurf } from '../offline/turfCache';
import { api, isApiError } from './client';
import { RESULT_LABELS } from './types';
import type {
  Activity,
  Assignment,
  AuditEntry,
  CancelReason,
  Contact,
  ContactInput,
  DoorsResponse,
  Coverage,
  Reachability,
  TurfShape,
  FollowUp,
  Household,
  LegalHousehold,
  Meta,
  ManualRequestInput,
  ManualRequestPatch,
  PointsCollection,
  PublicRequest,
  Quality,
  Role,
  SearchResult,
  Sign,
  SignDetail,
  SignInput,
  PickupSign,
  SignRequest,
  SignStatus,
  AudienceCount,
  Campaign,
  CampaignInput,
  CampaignPurpose,
  SegmentInfo,
  SenderNumber,
  StatsOverview,
  Street,
  TurfPreview,
  VoterContact,
  VoterContactInput,
  TurfSummary,
  Turnout,
  User,
  UserRow,
  VotedImport,
  VotedImportInput,
  VotedImportResult,
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

/** Doors by how many of their electors have voted. Organizer-only on the API, so only an organizer's drawer offers it. */
export type VotedFilter = 'none' | 'some' | 'all';

export interface PointFilters {
  ward: string[];
  community: string[];
  quality: Quality[];
  voted: VotedFilter[];
}

export const EMPTY_FILTERS: PointFilters = { ward: [], community: [], quality: [], voted: [] };

export function usePoints(filters: PointFilters) {
  return useQuery({
    queryKey: ['points', filters.ward, filters.community, filters.quality, filters.voted],
    queryFn: () =>
      api.get<PointsCollection>('/households/points', {
        ward: filters.ward,
        community: filters.community,
        quality: filters.quality,
        voted: filters.voted,
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

// ------------------------------------------------------------------ who has voted (1.9.0)

export const TURNOUT_KEY = ['turnout'] as const;

/** Turnout so far — counts only. Organizer and above. */
export function useTurnout(enabled = true) {
  return useQuery({
    queryKey: TURNOUT_KEY,
    queryFn: () => api.get<Turnout>('/voted/summary'),
    staleTime: 60_000,
    enabled,
  });
}

/** The files applied so far. Admin only. */
export function useVotedImports(enabled = true) {
  return useQuery({
    queryKey: ['voted-imports'],
    queryFn: () => api.get<{ imports: VotedImport[] }>('/voted/imports').then((r) => r.imports),
    staleTime: 30_000,
    enabled,
  });
}

/**
 * Import a voted list. A dry run changes nothing and invalidates nothing; an apply changes who has
 * voted on every door, so the points, every open card and door list, and the turnout all refetch.
 */
export function useVotedImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VotedImportInput) => api.post<VotedImportResult>('/voted/import', body),
    onSuccess: (r) => {
      if (r.dry_run) return;
      void qc.invalidateQueries({ queryKey: ['voted-imports'] });
      void qc.invalidateQueries({ queryKey: TURNOUT_KEY });
      void qc.invalidateQueries({ queryKey: ['points'] });
      void qc.invalidateQueries({ queryKey: ['household'] });
      void qc.invalidateQueries({ queryKey: ['doors'] });
    },
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

/** Remove a volunteer from a turf. Idempotent server-side, so a double tap is harmless. */
export function useUnassignTurf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ turfId, userId }: { turfId: string; userId: string }) =>
      api.del(`/turfs/${turfId}/assign/${userId}`),
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

/** A doors response that may have come off the phone rather than the wire. */
export type CachedDoorsResponse = DoorsResponse & { from_cache?: boolean; cached_at?: number };

/**
 * The turf's doors, and the one place the offline copy is written.
 *
 * Opening a turf is the only thing that puts voter data on the phone (see offline/turfCache.ts),
 * and a failure that is not a *definite answer about this turf* falls back to that copy: 401/403/404
 * mean the server has told us something real and the screen should say so, but a dead radio or a
 * 502 from a restarting API must not leave a volunteer standing on a road with no door list.
 */
export function useDoors(turfId: string | undefined) {
  return useQuery({
    queryKey: ['turf-doors', turfId ?? ''],
    queryFn: async (): Promise<CachedDoorsResponse> => {
      const id = turfId as string;
      try {
        const res = await api.get<DoorsResponse>(`/turfs/${id}/doors`);
        // Fire-and-forget: a cache write must never be the reason the door list fails to render.
        void cacheTurf(id, res);
        return res;
      } catch (err) {
        const definite = isApiError(err, 401) || isApiError(err, 403) || isApiError(err, 404);
        if (definite) throw err;
        const hit = await readCachedTurf(id);
        if (!hit) throw err;
        track('turf_cache_fallback_used', { age_s: Math.max(0, Math.round((Date.now() - hit.cached_at) / 1000)) });
        return { ...hit.response, from_cache: true, cached_at: hit.cached_at };
      }
    },
    enabled: !!turfId,
    staleTime: 15_000,
    // TanStack pauses queries when the browser reports itself offline; here that would hide the
    // cached turf behind a spinner, which is the exact situation the cache exists for.
    networkMode: 'always',
    // The fallback above is the retry that matters, and a volunteer waiting through three doomed
    // attempts before seeing their doors is the failure mode this screen cannot afford.
    retry: false,
  });
}

/**
 * Refresh what the queue changed once it drains. Mounted by the canvass screens; without it a
 * volunteer who comes back into signal keeps looking at the pre-sync numbers until they navigate.
 */
export function useOfflineSync(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      onSynced(() => {
        void qc.invalidateQueries({ queryKey: ['turf-doors'] });
        void qc.invalidateQueries({ queryKey: ['contacts'] });
        void qc.invalidateQueries({ queryKey: MINE_KEY });
        void qc.invalidateQueries({ queryKey: SIGNS_KEY });
      }),
    [qc],
  );
}

export function useContacts(householdId: string | undefined) {
  return useQuery({
    queryKey: ['contacts', householdId ?? ''],
    queryFn: () => api.get<{ contacts: Contact[] }>('/contacts', { household_id: householdId }).then((r) => r.contacts),
    enabled: !!householdId,
    staleTime: 5_000,
  });
}

/** Mutation variables for `useRecordContact`: a contact body plus what to call it in the queue. */
export interface RecordContactVars extends ContactInput {
  /** Shown in the sync panel if this write ends up parked. Never sent to the API. */
  door_label?: string;
}

export interface RecordContactOutcome {
  /** True when the door went into the outbox instead of the database. */
  queued: boolean;
  contact: Contact | null;
}

/**
 * Record a door result.
 *
 * A `client_id` is generated once per submission and travels with the body, so a retry — from the
 * sheet's own retry button or from the outbox hours later — is the same door to the API rather than
 * a second knock. On a network failure the write is queued and this resolves anyway: the volunteer
 * gets their auto-advance and walks on, which is the whole point of canvassing on a rural road.
 */
export function useRecordContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ door_label, ...input }: RecordContactVars): Promise<RecordContactOutcome> => {
      const body: ContactInput = { ...input, client_id: input.client_id ?? crypto.randomUUID() };
      const label = `${door_label ?? body.household_id} — ${RESULT_LABELS[body.result]}`;
      const out = await submitOrQueue<{ contact: Contact }>('/contacts', body as unknown as Record<string, unknown>, {
        label,
        household_id: body.household_id,
        result: body.result,
      });
      return out.queued ? { queued: true, contact: null } : { queued: false, contact: out.data.contact };
    },
    // Without this the mutation would be *paused* — not run — the moment the browser reports
    // itself offline, and the queue would never see the write it exists to hold.
    networkMode: 'always',
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

// ------------------------------------------------------------------ phase 8 — subscriber link

/** The public-request queue, matcher candidates riding along. Organizer-only server-side. */
export function usePublicRequests(open: boolean, enabled = true) {
  return useQuery({
    queryKey: ['public-requests', open],
    queryFn: () =>
      api.get<{ requests: PublicRequest[] }>('/public/requests', { open }).then((r) => r.requests),
    // `enabled` is how a screen that BOTH roles can open avoids firing a request the API will
    // refuse: these rows carry names, phones and emails under CASL consent and the route is
    // organizer/admin. Not a security boundary — the route is — just an honest client.
    enabled,
    staleTime: 30_000,
  });
}

/** Accept or reject one candidate; the queue refetches so the verdict shows immediately. */
export function useDecideMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; candidateId: string; decision: 'accept' | 'reject' }) =>
      api.post<{ ok: boolean }>(`/public/requests/${input.requestId}/decide`, {
        candidate_id: input.candidateId,
        decision: input.decision,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['public-requests'] }),
  });
}

/**
 * Mark a request handled (or reopen it).
 *
 * `sign_id` and `household_id` ride along when a sign was actually placed against the request: that
 * pointer is the only thing that drains a phoned-in request from the list, since — unlike a door
 * off the voters list — there is no `wants_sign` contact for a placement to satisfy.
 */
export function useHandleRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; handled: boolean; sign_id?: string; household_id?: string }) =>
      api.patch<{ ok: boolean }>(`/public/requests/${input.requestId}`, {
        handled: input.handled,
        ...(input.sign_id ? { sign_id: input.sign_id } : {}),
        ...(input.household_id ? { household_id: input.household_id } : {}),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['public-requests'] }),
  });
}

/**
 * Type in a request that arrived by phone, text or in person.
 *
 * It lands in the same queue as a website sign-up, so the matcher gets a look at it and the
 * sign-ups screen shows it beside the rest, rather than a second private list nobody else can see.
 */
export function useCreateManualRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ManualRequestInput) =>
      api.post<{ request: PublicRequest }>('/public/requests/manual', input).then((r) => r.request),
    onSettled: () => qc.invalidateQueries({ queryKey: ['public-requests'] }),
  });
}

/** Correct a manual request. The API refuses this outright for a website sign-up. */
export function useUpdateManualRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, ...patch }: ManualRequestPatch & { requestId: string }) =>
      api.patch<{ request: PublicRequest }>(`/public/requests/${requestId}/fields`, patch).then((r) => r.request),
    onSettled: () => qc.invalidateQueries({ queryKey: ['public-requests'] }),
  });
}

/**
 * Delete a manual request outright — a wrong number, a duplicate, somebody who changed their mind.
 *
 * Manual rows only, enforced server-side: a website sign-up is the record of a consent somebody
 * actually gave, and the five-minute website sync would re-insert a deleted one by morning anyway.
 */
export function useDeleteManualRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => api.del<void>(`/public/requests/${requestId}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['public-requests'] }),
  });
}

/** Doors waiting for a sign — asked at the door, or requested from a door card. */
export function useSignRequests() {
  return useQuery({
    queryKey: ['signs', 'requests'],
    queryFn: () => api.get<{ requests: SignRequest[] }>('/signs/requests').then((r) => r.requests),
    staleTime: 30_000,
  });
}

/** The bin: requests taken off the list without a sign. Organizer/admin — the API 403s anyone else. */
export function useCancelledSignRequests(enabled: boolean) {
  return useQuery({
    queryKey: ['signs', 'requests', 'cancelled'],
    queryFn: () =>
      api.get<{ requests: SignRequest[] }>('/signs/requests', { cancelled: true }).then((r) => r.requests),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Take a request off the delivery list, or put it back.
 *
 * Nothing is deleted — the sign row is stamped and a restore clears the stamp — so "I was testing"
 * is genuinely reversible. Both invalidate the sign list as well as the two request lists, because
 * a cancelled request also leaves the signs map.
 */
function useSignRequestVerdict(path: 'cancel' | 'restore') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ householdId, ...body }: { householdId: string; reason?: CancelReason; note?: string }) =>
      api.post<{ ok: boolean }>(`/signs/requests/${encodeURIComponent(householdId)}/${path}`, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['signs'] });
    },
  });
}

export const useCancelSignRequest = () => useSignRequestVerdict('cancel');
export const useRestoreSignRequest = () => useSignRequestVerdict('restore');

/**
 * A sign the volunteer placed but the network has not accepted yet.
 *
 * The placement panel wants a `Sign` back so it can confirm the record, and offline there is no
 * server row to hand it — so one is built from the body that was queued. The `queued:` id prefix is
 * deliberately not a server id: nothing may treat it as one. Photos are the one part that cannot
 * follow, because raw image bytes in the outbox is a different problem with a different size
 * budget; a queued sign gets its photo from the sign list once it has synced.
 */
function localSign(body: SignInput, clientId: string): Sign {
  const now = new Date().toISOString();
  return {
    id: `queued:${clientId}`,
    household_id: body.household_id ?? null,
    address: null,
    ward: null,
    status: body.status ?? 'placed',
    lat: body.lat,
    lon: body.lon,
    accuracy_m: body.accuracy_m ?? null,
    label: body.label ?? null,
    size: body.size ?? null,
    note: body.note ?? null,
    permission_by: body.permission_by ?? null,
    requested_at: null,
    requested_from: body.requested_from ?? null,
    placed_by: null,
    placed_by_name: null,
    placed_at: now,
    removed_by: null,
    removed_by_name: null,
    removed_at: null,
    created_at: now,
    client_id: clientId,
    photo_count: 0,
  };
}

export function usePlaceSign() {
  const qc = useQueryClient();
  return useMutation({
    // Same idempotency contract as a door contact: retrying on a bad rural signal must not plant a
    // second sign in the database, and the queue replays the same body with the same client_id.
    mutationFn: async (input: SignInput): Promise<{ sign: Sign; queued: boolean }> => {
      const client_id = input.client_id ?? crypto.randomUUID();
      const body: SignInput = { ...input, client_id };
      const label = body.label ?? body.household_id ?? `Sign at ${body.lat.toFixed(5)}, ${body.lon.toFixed(5)}`;
      const out = await submitOrQueue<{ sign: Sign }>('/signs', body as unknown as Record<string, unknown>, {
        label,
        household_id: body.household_id ?? null,
      });
      return out.queued ? { sign: localSign(body, client_id), queued: true } : { sign: out.data.sign, queued: false };
    },
    networkMode: 'always',
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

// ------------------------------------------------------------------ contact details at the door

export function useVoterContacts(householdId: string | undefined) {
  return useQuery({
    queryKey: ['voter-contacts', householdId ?? ''],
    queryFn: () =>
      api.get<{ voter_contacts: VoterContact[] }>('/voter-contacts', { household_id: householdId })
        .then((r) => r.voter_contacts),
    enabled: !!householdId,
    staleTime: 10_000,
  });
}

export function useAddVoterContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VoterContactInput) => api.post<{ voter_contact: VoterContact }>('/voter-contacts', body),
    onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: ['voter-contacts', v.household_id] }),
  });
}

/** Withdrawal stamps the row rather than deleting it — a deleted number is just re-collected. */
export function useUpdateVoterContact(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; consent_gotv?: boolean; consent_updates?: boolean; withdrawn?: boolean; withdrawn_note?: string }) =>
      api.patch<{ voter_contact: VoterContact }>(`/voter-contacts/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['voter-contacts', householdId] }),
  });
}

// ------------------------------------------------------------------ Phase 5: messaging

export const CAMPAIGNS_KEY = ['campaigns'] as const;

export function useAudience(purpose: CampaignPurpose, audience: { ward?: string[]; community?: string[] } = {}) {
  return useQuery({
    queryKey: ['audience', purpose, audience.ward?.join(',') ?? '', audience.community?.join(',') ?? ''],
    queryFn: () =>
      api.get<AudienceCount>('/messaging/audience', {
        purpose,
        ward: audience.ward,
        community: audience.community,
      }),
    staleTime: 30_000,
  });
}

export function useCampaigns() {
  return useQuery({
    queryKey: CAMPAIGNS_KEY,
    queryFn: () => api.get<{ campaigns: Campaign[] }>('/messaging/campaigns').then((r) => r.campaigns),
    staleTime: 15_000,
  });
}

export function useCampaign(id: string | undefined, poll = false) {
  return useQuery({
    queryKey: ['campaign', id ?? ''],
    queryFn: () => api.get<{ campaign: Campaign }>(`/messaging/campaigns/${id}`).then((r) => r.campaign),
    enabled: !!id,
    // While a send is draining, progress is the only signal that the carrier throttle is not
    // silently dropping messages — so it is worth polling.
    refetchInterval: poll ? 5_000 : false,
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignInput) => api.post<{ campaign: Campaign }>('/messaging/campaigns', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CAMPAIGNS_KEY }),
  });
}

export function useUpdateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CampaignInput> & { id: string }) =>
      api.patch<{ campaign: Campaign }>(`/messaging/campaigns/${id}`, body),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      void qc.invalidateQueries({ queryKey: ['campaign', v.id] });
    },
  });
}

/** approve → send is deliberately two calls: approving is the human speed bump before a real send. */
export function useCampaignAction() {
  const qc = useQueryClient();
  return useMutation({
    // `override_max_audience` is the only way past the MESSAGING_MAX_AUDIENCE guard on /send. It is
    // a deliberate second key, not a default — an organiser has to choose to exceed the cap.
    mutationFn: ({ id, action, override_max_audience }: {
      id: string;
      action: 'approve' | 'send' | 'pause' | 'resume' | 'cancel';
      override_max_audience?: boolean;
    }) =>
      api.post<{ campaign: Campaign }>(
        `/messaging/campaigns/${id}/${action}`,
        override_max_audience ? { override_max_audience: true } : {},
      ),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      void qc.invalidateQueries({ queryKey: ['campaign', v.id] });
    },
  });
}

/** Send the draft to one number first. Nobody should discover a typo 2,000 messages in. */
export function useTestSend() {
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api.post(`/messaging/campaigns/${id}/test`, { to }),
  });
}

export function useSegments(text: string) {
  return useQuery({
    queryKey: ['segments', text],
    queryFn: () => api.post<SegmentInfo>('/messaging/segments', { text }),
    enabled: text.trim().length > 0,
    staleTime: 60_000,
  });
}

export function useSenderNumbers() {
  return useQuery({
    queryKey: ['sender-numbers'],
    queryFn: () => api.get<{ numbers: SenderNumber[] }>('/messaging/numbers').then((r) => r.numbers),
    staleTime: 30_000,
  });
}

/** Preview a turf before creating it — the same matching the create path uses. */
export function useTurfPreview() {
  return useMutation({
    mutationFn: (body: { streets?: string[]; polygon?: unknown; ward?: string | null }) =>
      api.post<TurfPreview>('/turfs/preview', body),
  });
}

/** The doors of an existing turf, for drawing it on the main map. */
export function useTurfDoorsForMap(turfId: string | null) {
  return useQuery({
    queryKey: ['turf-map', turfId ?? ''],
    queryFn: () => api.get<DoorsResponse>(`/turfs/${turfId}/doors`),
    enabled: !!turfId,
    staleTime: 60_000,
  });
}

/** Why part of the list cannot be reached. Aggregates only — no row of the list is in the response. */
export function useCoverage() {
  return useQuery({
    queryKey: ['coverage'],
    queryFn: () => api.get<Coverage>('/stats/coverage'),
    staleTime: 60_000,
  });
}

export function useReachability() {
  return useQuery({
    queryKey: ['reachability'],
    queryFn: () => api.get<Reachability>('/stats/reachability'),
    staleTime: 300_000,
  });
}

/**
 * Turf boundaries for the map overlay. Scoped server-side: a volunteer gets only the turfs assigned
 * to them, an organiser gets all of them with `mine` set on their own.
 */
export function useTurfShapes(enabled: boolean) {
  return useQuery({
    queryKey: ['turf-shapes'],
    queryFn: () => api.get<{ turfs: TurfShape[] }>('/turfs/shapes').then((r) => r.turfs),
    enabled,
    staleTime: 300_000,
  });
}
