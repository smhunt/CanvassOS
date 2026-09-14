// Response shapes from API.md (Phase 1). Keep in step with the contract; the API is the source of truth.
import type { FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';

export type Role = 'admin' | 'organizer' | 'volunteer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface UserRow extends User {
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  invite_pending: boolean;
}

export interface Meta {
  wards: { ward: string; n_households: number; n_voters: number }[];
  communities: { community: string; n_households: number; n_voters: number }[];
  import: { id: number; source_label: string; finished_at: string; n_voters: number; n_households: number } | null;
  boundary: Polygon | MultiPolygon | null;
}

export type Quality = 'good' | 'approx' | 'legal' | 'check';

/** Feature.properties of /api/households/points. Organizer-only keys are optional. */
export interface PointProps {
  id: string;
  ward: string;
  community: string | null;
  n: number;
  inst: boolean;
  nonres?: number;
  q?: Quality;
  status?: string | null;
}

export type PointsCollection = FeatureCollection<Point, PointProps>;

export interface Voter {
  id: string;
  display_name: string;
  full_name: string;
  first_name: string;
  middle_names: string | null;
  last_name: string;
  suffix: string | null;
  mail_kind: string;
  mail_differs_real: boolean;
  last_support: number | null;
  last_result: string | null;
  last_contact_at: string | null;
  // organizer/admin only
  resident_class?: string;
  mailing_address?: string | null;
  mail_city?: string | null;
  mail_postal?: string | null;
}

export interface HouseholdBase {
  id: string;
  ward: string;
  community: string | null;
  postal: string | null;
  locality: string | null;
  address: string;
  property_address_raw: string;
  civic_num: string | null;
  street: string | null;
  street_type: string | null;
  street_dir: string | null;
  unit: string | null;
  lat: number | null;
  lon: number | null;
  addr_match: string;
  record_quality: Quality;
  is_legal: boolean;
  is_institution: boolean;
  n_voters: number;
  n_nonresident?: number;
  n_po_box?: number;
  /**
   * The active turfs this door is in, so the card can offer a way into the door screen. Scoped: a
   * volunteer is only told about turfs assigned to them, an organiser sees all of them. Empty means
   * the door is in no turf — a real and common state, not an error.
   */
  turfs: { id: string; name: string }[];
}

export interface Household extends HouseholdBase {
  voters: Voter[];
  status: { last_result: string | null; last_contact_at: string | null; last_user_name: string | null };
}

export interface LegalHousehold extends HouseholdBase {
  voter_names: string | null;
}

export interface SearchResult {
  voters: { id: string; display_name: string; household_id: string; address: string; community: string | null; ward: string }[];
  households: { id: string; address: string; community: string | null; ward: string; n_voters: number }[];
}

export interface StatsOverview {
  totals: {
    households: number;
    voters: number;
    residents: number;
    nonresidents: number;
    institutions: number;
    legal: number;
    po_box_only: number;
  };
  by_ward: { ward: string; households: number; voters: number; nonresidents: number; avg_voters_per_door: number }[];
  by_community: { community: string; households: number; voters: number; nonresidents: number }[];
  quality: { good: number; approx: number; legal: number; check: number };
  household_size: { size: string; households: number }[];
  canvass: { contacted_households: number; contacts_today: number; contacts_7d: number; support_hist: number[] };
}

export interface AuditEntry {
  id: number;
  at: string;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

// ------------------------------------------------------------------ Phase 2: canvassing

/** db/schema.sql `contact_result`. Order here is the order the door screen shows the buttons in. */
export const CONTACT_RESULTS = [
  'spoke',
  'not_home',
  'left_literature',
  'refused',
  'moved',
  'inaccessible',
  'do_not_knock',
  'deceased',
] as const;
export type ContactResult = (typeof CONTACT_RESULTS)[number];

export const RESULT_LABELS: Record<ContactResult, string> = {
  spoke: 'Spoke',
  not_home: 'Not home',
  left_literature: 'Left literature',
  refused: 'Refused',
  moved: 'Moved',
  inaccessible: 'Inaccessible',
  do_not_knock: 'Do not knock',
  deceased: 'Deceased',
};

export type AssignmentStatus = 'open' | 'in_progress' | 'done';

export interface TurfSummary {
  id: string;
  name: string;
  ward: string | null;
  archived: boolean;
  created_at: string;
  created_by_name: string | null;
  n_households: number;
  n_voters: number;
  contacted: number;
  /** Distinct `street_sort` of the turf's households — lets the builder flag overlapping turfs. */
  streets: string[];
  assignees: { id?: string; user_id: string; name: string; status: AssignmentStatus; due_date?: string | null }[];
}

export interface Assignment {
  id: string;
  status: AssignmentStatus;
  due_date: string | null;
  assigned_at: string;
  turf: { id: string; name: string; ward: string | null };
  n_households: number;
  contacted: number;
}

/** One door in a turf, in walking order. Volunteers get voter names but no mailing/resident fields. */
export interface Door {
  household_id: string;
  address: string;
  community: string | null;
  ward: string;
  lat: number | null;
  lon: number | null;
  n_voters: number;
  walk_order: number;
  last_result: ContactResult | null;
  last_contact_at: string | null;
  voters: Voter[];
}

export interface DoorsResponse {
  // `polygon` is the boundary the organizer drew, and is null for a turf built by picking streets.
  // The route has always sent it (loadTurf selects t.polygon); only this type omitted it.
  turf: { id: string; name: string; ward: string | null; polygon?: Polygon | null };
  doors: Door[];
}

export interface Contact {
  id: string;
  at: string;
  user_name: string | null;
  result: ContactResult;
  support: number | null;
  issues: string[];
  wants_sign: boolean;
  wants_volunteer: boolean;
  needs_ride: boolean;
  follow_up: boolean;
  note: string | null;
  voter_id: string | null;
  voter_name: string | null;
}

/** POST /api/contacts. `client_id` makes a retry idempotent — the offline queue in Phase 3 relies on it. */
export interface ContactInput {
  household_id: string;
  /** Several people can be tagged at one door; the API writes a row per person so two residents
   *  at the same address can hold different support levels. */
  voter_ids?: string[];
  /** Per-person support, keyed by voter id. Overrides the door-level `support` for that person. */
  supports?: Record<string, number>;
  voter_id?: string | null;
  turf_id?: string | null;
  result: ContactResult;
  support?: number | null;
  issues?: string[];
  wants_sign?: boolean;
  /** Where a requested sign should go. Only valid with `wants_sign` — the API rejects it alone. */
  sign_address?: string;
  wants_volunteer?: boolean;
  needs_ride?: boolean;
  follow_up?: boolean;
  note?: string | null;
  client_id?: string;
}

export interface FollowUp {
  household_id: string;
  address: string;
  ward: string;
  community: string | null;
  last_result: ContactResult;
  last_contact_at: string;
  user_name: string | null;
  note: string | null;
  /** Present on the wire — enough to fly the map to the door once /map takes a household param. */
  lat: number | null;
  lon: number | null;
  contact_id: string;
  last_support: number | null;
  issues: string[];
  wants_sign: boolean;
  wants_volunteer: boolean;
  needs_ride: boolean;
  voter_id: string | null;
  voter_name: string | null;
}

export interface Activity {
  by_user: { user_id: string; name: string; contacts: number; doors: number; last_at: string | null }[];
  by_day: { day: string; contacts: number }[];
}

/** GET /api/streets — the turf builder's street picker and the map's street search. */
export interface Street {
  street_sort: string;
  label: string;
  ward: string;
  community: string | null;
  n_households: number;
  n_voters: number;
  min_num: number | null;
  max_num: number | null;
}

// ------------------------------------------------------------------ lawn signs

export const SIGN_STATUSES = ['requested', 'placed', 'removed', 'missing', 'damaged'] as const;
export type SignStatus = (typeof SIGN_STATUSES)[number];

export const SIGN_STATUS_LABELS: Record<SignStatus, string> = {
  requested: 'Requested',
  placed: 'Standing',
  removed: 'Picked up',
  missing: 'Missing',
  damaged: 'Damaged',
};

export interface Sign {
  id: string;
  household_id: string | null;
  /** Joined from the household; null for a road-allowance or corner-lot sign. */
  address: string | null;
  ward: string | null;
  status: SignStatus;
  lat: number;
  lon: number;
  /** The device's reported GPS accuracy in metres — how big a circle to search in November. */
  accuracy_m: number | null;
  label: string | null;
  size: string | null;
  note: string | null;
  permission_by: string | null;
  requested_at: string | null;
  requested_from: string | null;
  placed_by: string | null;
  placed_by_name: string | null;
  placed_at: string | null;
  removed_by: string | null;
  removed_by_name: string | null;
  removed_at: string | null;
  created_at: string;
  client_id: string | null;
  photo_count: number;
}

export interface SignPhoto {
  id: string;
  sign_id: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  taken_by: string | null;
  taken_by_name: string | null;
  taken_at: string;
}

export type SignDetail = Sign & { photos: SignPhoto[] };

export interface SignInput {
  household_id?: string | null;
  lat: number;
  lon: number;
  accuracy_m?: number | null;
  label?: string | null;
  size?: string | null;
  note?: string | null;
  permission_by?: string | null;
  status?: SignStatus;
  requested_from?: string | null;
  client_id?: string;
}

/** A door that asked for a sign and has not got one yet — the delivery list.
 *  Shape mirrors the SELECT in api/src/routes/signs.ts, not the prose in API.md. */
export interface SignRequest {
  household_id: string;
  address: string;
  ward: string;
  community: string | null;
  lat: number | null;
  lon: number | null;
  /** Where they asked for the sign, when it is not the door. Null = never captured. */
  sign_address: string | null;
  contact_id: string;
  /** When the door asked — this is the contact's timestamp, there is no separate requested_at. */
  last_contact_at: string;
  last_result: ContactResult;
  note: string | null;
  user_id: string | null;
  user_name: string | null;
  voter_id: string | null;
  voter_name: string | null;
}

/** GET /api/signs/pickup returns a narrower row than `Sign` — see serializePickup in the API.
 *  It carries `photo_ids` (which `Sign` does not) and drops the fields a retrieval crew cannot use. */
export interface PickupSign {
  id: string;
  status: SignStatus;
  ward: string | null;
  address: string | null;
  label: string | null;
  size: string | null;
  note: string | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  placed_at: string | null;
  placed_by_name: string | null;
  photo_ids: string[];
}

// ------------------------------------------------------------------ contact details at the door

export type ContactChannel = 'phone' | 'email';

/** A phone number or email given directly by a resident. NOT list data — it carries its own
 *  per-purpose consent, and a withdrawal is recorded rather than deleted. */
export interface VoterContact {
  id: string;
  voter_id: string | null;
  household_id: string;
  /** Whose it is, joined by the API; null when the number belongs to the door generally. */
  voter_name: string | null;
  channel: ContactChannel;
  value: string;
  consent_gotv: boolean;
  consent_updates: boolean;
  consent_note: string | null;
  consented_at: string;
  collected_by: string | null;
  collected_by_name: string | null;
  contact_id: string | null;
  withdrawn_at: string | null;
  withdrawn_note: string | null;
  created_at: string;
}

export interface VoterContactInput {
  household_id: string;
  voter_id?: string | null;
  channel: ContactChannel;
  value: string;
  consent_gotv?: boolean;
  consent_updates?: boolean;
  consent_note?: string | null;
  contact_id?: string | null;
}

// ------------------------------------------------------------------ Phase 5: messaging

export type CampaignPurpose = 'gotv' | 'updates';
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';
export type SendStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';

/** What a campaign can actually reach, before it is sent. SMS wins when someone gives both. */
export interface AudienceCount {
  sms: number;
  email: number;
  /** Consented but withdrawn, or consented to the other purpose — counted so the gap is visible. */
  unreachable: number;
  total: number;
  /** Days the send will take at the current pool's combined daily cap. The throttle is the ceiling.
   *  null when there is no sending capacity at all — no active number, so it would never finish. */
  estimated_days: number | null;
  daily_capacity: number;
}

export interface Campaign {
  id: string;
  name: string;
  purpose: CampaignPurpose;
  body_sms: string | null;
  email_subject: string | null;
  body_email: string | null;
  status: CampaignStatus;
  scheduled_for: string | null;
  audience: { ward?: string[]; community?: string[] };
  created_by_name: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  /** Counts by send status — how a silent throttle is detected. */
  progress: { queued: number; sent: number; delivered: number; failed: number; skipped: number; total: number };
  /** Server-computed segment maths for the stored body — the biller's answer, not the composer's. */
  sms_segments?: number;
  sms_encoding?: 'GSM-7' | 'UCS-2';
}

export interface CampaignInput {
  name: string;
  purpose: CampaignPurpose;
  body_sms?: string | null;
  email_subject?: string | null;
  body_email?: string | null;
  scheduled_for?: string | null;
  audience?: { ward?: string[]; community?: string[] };
}

export interface SenderNumber {
  id: string;
  e164: string;
  provider: string;
  label: string | null;
  daily_cap: number;
  sent_today: number;
  active: boolean;
}

/** Segment maths, computed server-side so the composer and the biller agree.
 *  One accented character forces UCS-2: 160 chars per segment becomes 70. */
export interface SegmentInfo {
  chars: number;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
  /** The characters that forced UCS-2, so the composer can point at them. */
  offending: string[];
}

/** POST /api/turfs/preview — what a turf WOULD contain, before it is created.
 *  Uses the same street/polygon matching as the create path, so the preview cannot promise a
 *  different turf from the one that gets saved. */
export interface TurfPreview {
  n_households: number;
  n_voters: number;
  /** Door coordinates for drawing the shape. Legal-description rows have no point and are omitted. */
  doors: { household_id: string; lat: number; lon: number; ward: string }[];
  /** Households in the selection that have no coordinates, so the map cannot show them. */
  unmapped: number;
  /** True when `doors` was capped — the counts above are still the exact full-selection figures,
   *  so a builder can say "showing 4,000 of N" rather than under-reporting the turf. */
  truncated: boolean;
}

// ---------------------------------------------------------------- reachability (GET /api/stats/reachability)

/** Which way of reaching somebody a category rules out — "unreachable" is not one thing. */
export type ReachBlocks = ('door' | 'mail' | 'gatekeeper')[];

export interface ReachCategory {
  code: string;
  kind: 'structural' | 'behavioural' | string;
  blocks: ReachBlocks;
  /** Set when this category is a cause of another (geocode_failed sits under no_map_point). */
  parent: string | null;
  /** Whether `count` is a number of doors or a number of electors. They must not be compared. */
  scope: 'household' | 'voter';
  count: number;
  share: number;
  by_ward: { ward: string; count: number; share: number }[];
}

export interface Reachability {
  totals: { households: number; voters: number; wards: string[] };
  categories: ReachCategory[];
  combined: { households_blocked: number; share: number; mail_blocked: number; mail_share: number };
  /** Null unless an advice provider is configured; the shape is fixed so adding one is config. */
  advice: string | null;
}

/** One turf boundary for the map overlay (GET /api/turfs/shapes). Volunteers get only their own. */
export interface TurfShape {
  id: string;
  name: string;
  ward: string | null;
  /**
   * The shape to draw. Null only when the turf has no mapped doors at all (every one a legal
   * description) and nothing was drawn either.
   */
  polygon: Polygon | null;
  /**
   * The shape was derived from the turf's doors, not drawn by an organiser. A hull spans the gaps
   * between its streets, so it can cover doors that are NOT in the turf — it says roughly where the
   * turf is, never which doors are in it, and the map draws it dotted to say so.
   */
  approx: boolean;
  /** Assigned to the signed-in user. Organisers see everyone's, so this is what finds their own. */
  mine: boolean;
  n_households: number;
  contacted: number;
}

// ------------------------------------------------------------------ phase 8 — subscriber link

/** One of the matcher's ranked voter suggestions for a public request. */
export interface MatchCandidate {
  id: string;
  voter_id: string | null;
  natural_key: string;
  household_id: string | null;
  voter_name: string;
  household_address: string | null;
  score: number;
  method: 'email' | 'phone' | 'name' | 'name_address' | 'ledger';
  status: 'suggested' | 'accepted' | 'rejected';
  decided_at: string | null;
}

/** A website sign-up (or direct public-form post) in the organizer queue. */
export interface PublicRequest {
  id: string;
  created_at: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
  wants: string[];
  consent_text: string;
  handled_at: string | null;
  handled_by: string | null;
  household_id: string | null;
  sign_id: string | null;
  source: string;
  external_id: string | null;
  /** The website's double-opt-in state; null for rows that came straight to the public form. */
  website_status: 'pending' | 'confirmed' | 'unsubscribed' | null;
  candidates: MatchCandidate[];
}
