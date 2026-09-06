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
  turf: { id: string; name: string; ward: string | null };
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
  voter_id?: string | null;
  turf_id?: string | null;
  result: ContactResult;
  support?: number | null;
  issues?: string[];
  wants_sign?: boolean;
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
