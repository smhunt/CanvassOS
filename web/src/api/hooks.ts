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
  AudienceCount,
  Campaign,
  CampaignInput,
  CampaignPurpose,
  SegmentInfo,
  SenderNumber,
  StatsOverview,
  Street,
  VoterContact,
  VoterContactInput,
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

/** Doors that asked for a sign at the door and have not got one yet. */
export function useSignRequests() {
  return useQuery({
    queryKey: ['signs', 'requests'],
    queryFn: () => api.get<{ requests: SignRequest[] }>('/signs/requests').then((r) => r.requests),
    staleTime: 30_000,
  });
}

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
