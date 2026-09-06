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
