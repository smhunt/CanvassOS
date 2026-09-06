/**
 * THE single enforcement point for role-based field stripping (API.md "Rule for volunteers").
 *
 * Every voter / household row that leaves the API passes through one of the functions below.
 * Volunteers never receive: mailing_address, mail_city, mail_postal, resident_class,
 * n_nonresident, n_po_box. Organizers and admins receive everything.
 *
 * Keep the SQL column lists in routes/ aligned with the Row types here; the projections are
 * explicit allow-lists (we pick keys, we do not delete them), so an extra column accidentally
 * selected in SQL can never leak.
 */

export type Role = 'admin' | 'organizer' | 'volunteer';

const RANK: Record<Role, number> = { volunteer: 1, organizer: 2, admin: 3 };

/** true when `role` is at least `min` (admin > organizer > volunteer). */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function isOrganizer(role: Role): boolean {
  return roleAtLeast(role, 'organizer');
}

// ------------------------------------------------------------------ voters

export interface VoterRow {
  id: string;
  display_name: string;
  full_name: string;
  first_name: string;
  middle_names: string | null;
  last_name: string;
  suffix: string | null;
  resident_class: string;
  mail_kind: string;
  mail_differs_real: boolean;
  mailing_address: string | null;
  mail_city: string | null;
  mail_postal: string | null;
  // from voter_status (null when never contacted)
  last_support: number | null;
  last_result: string | null;
  last_contact_at: Date | string | null;
}

export interface VoterPublic {
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
  last_contact_at: Date | string | null;
}

export interface VoterOrganizer extends VoterPublic {
  resident_class: string;
  mailing_address: string | null;
  mail_city: string | null;
  mail_postal: string | null;
}

export function serializeVoter(row: VoterRow, role: Role): VoterPublic | VoterOrganizer {
  const base: VoterPublic = {
    id: row.id,
    display_name: row.display_name,
    full_name: row.full_name,
    first_name: row.first_name,
    middle_names: row.middle_names,
    last_name: row.last_name,
    suffix: row.suffix,
    mail_kind: row.mail_kind,
    mail_differs_real: row.mail_differs_real,
    last_support: row.last_support,
    last_result: row.last_result,
    last_contact_at: row.last_contact_at,
  };
  if (!isOrganizer(role)) return base;
  return {
    ...base,
    resident_class: row.resident_class,
    mailing_address: row.mailing_address,
    mail_city: row.mail_city,
    mail_postal: row.mail_postal,
  };
}

// ------------------------------------------------------------------ households

export interface HouseholdRow {
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
  record_quality: string;
  is_legal: boolean;
  is_institution: boolean;
  n_voters: number;
  n_nonresident: number;
  n_po_box: number;
}

export interface HouseholdPublic {
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
  record_quality: string;
  is_legal: boolean;
  is_institution: boolean;
  n_voters: number;
}

export interface HouseholdOrganizer extends HouseholdPublic {
  n_nonresident: number;
  n_po_box: number;
}

export function serializeHousehold(row: HouseholdRow, role: Role): HouseholdPublic | HouseholdOrganizer {
  const base: HouseholdPublic = {
    id: row.id,
    ward: row.ward,
    community: row.community,
    postal: row.postal,
    locality: row.locality,
    address: row.address,
    property_address_raw: row.property_address_raw,
    civic_num: row.civic_num,
    street: row.street,
    street_type: row.street_type,
    street_dir: row.street_dir,
    unit: row.unit,
    lat: row.lat,
    lon: row.lon,
    addr_match: row.addr_match,
    record_quality: row.record_quality,
    is_legal: row.is_legal,
    is_institution: row.is_institution,
    n_voters: row.n_voters,
  };
  if (!isOrganizer(role)) return base;
  return { ...base, n_nonresident: row.n_nonresident, n_po_box: row.n_po_box };
}

// ------------------------------------------------------------------ map points

export interface PointRow {
  id: string;
  ward: string;
  community: string | null;
  n_voters: number;
  is_institution: boolean;
  n_nonresident: number;
  record_quality: string;
  last_result: string | null;
  lat: number;
  lon: number;
  /** Volunteers only: true when the door is inside one of the caller's assigned turfs. */
  in_turf?: boolean;
}

export interface PointPropsPublic {
  id: string;
  ward: string;
  community: string | null;
  n: number;
  inst: boolean;
}

export interface PointPropsOrganizer extends PointPropsPublic {
  nonres: number;
  q: string;
  status: string | null;
}

/** Phase 2: a volunteer's own turf is colourable, so those doors (and only those) carry `status`. */
export interface PointPropsScoped extends PointPropsPublic {
  status: string | null;
}

/** Feature.properties for GET /api/households/points — compact keys, per API.md. */
export function serializePointProps(
  row: PointRow,
  role: Role,
): PointPropsPublic | PointPropsScoped | PointPropsOrganizer {
  const base: PointPropsPublic = {
    id: row.id,
    ward: row.ward,
    community: row.community,
    n: row.n_voters,
    inst: row.is_institution,
  };
  if (!isOrganizer(role)) {
    // Out-of-turf doors stay exactly as anonymous as they were in Phase 1.
    return row.in_turf ? { ...base, status: row.last_result } : base;
  }
  return { ...base, nonres: row.n_nonresident, q: row.record_quality, status: row.last_result };
}

// ------------------------------------------------------------------ turf doors

/**
 * One door on the walk list (GET /api/turfs/:id/doors). Deliberately a narrow projection of
 * `household`: no mailing/non-resident columns exist on it at all, so a volunteer's door list
 * carries nothing that Phase 1 kept from them. `voters` is filled in by the route from
 * `serializeVoter`, which is what actually strips the organizer-only voter fields.
 */
export interface DoorRow {
  household_id: string;
  address: string;
  community: string | null;
  ward: string;
  lat: number | null;
  lon: number | null;
  n_voters: number;
  walk_order: number | null;
  last_result: string | null;
  last_contact_at: Date | string | null;
}

export interface Door extends DoorRow {
  voters: Array<VoterPublic | VoterOrganizer>;
}

export function serializeDoor(row: DoorRow, voters: VoterRow[], role: Role): Door {
  return {
    household_id: row.household_id,
    address: row.address,
    community: row.community,
    ward: row.ward,
    lat: row.lat,
    lon: row.lon,
    n_voters: row.n_voters,
    walk_order: row.walk_order,
    last_result: row.last_result,
    last_contact_at: row.last_contact_at,
    voters: voters.map((v) => serializeVoter(v, role)),
  };
}

// ------------------------------------------------------------------ users

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** `user` object used by /auth/* responses. */
export function serializeUser(row: UserRow): UserPublic {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export interface UserListRow extends UserRow {
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
  invite_pending: boolean;
}

/** What an organizer may see of another user: enough to assign a turf, nothing more. */
export interface UserListPublic {
  id: string;
  name: string;
  role: Role;
  active: boolean;
}

export interface UserListAdmin extends UserListPublic {
  email: string;
  created_at: Date;
  last_login_at: Date | null;
  invite_pending: boolean;
}

/**
 * Row projection for GET /api/users. Organizers need the list to fill the "assign a turf" picker,
 * so they get names and nothing else — no email, no login times, no invite state. Only admins,
 * who own user management, see the full row.
 */
export function serializeUserListRow(row: UserListRow, viewer: Role): UserListPublic | UserListAdmin {
  const base: UserListPublic = { id: row.id, name: row.name, role: row.role, active: row.active };
  if (viewer !== 'admin') return base;
  return {
    ...base,
    email: row.email,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    invite_pending: row.invite_pending,
  };
}
