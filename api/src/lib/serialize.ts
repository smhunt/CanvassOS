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

// ------------------------------------------------------------------ contacts

/**
 * One `contact` row as it leaves the API (POST /api/contacts, and the plural `contacts` array).
 *
 * A contact carries no field off the voters list except the joined `voter_id` the canvasser chose
 * and the name of the user who knocked, so this projection gives a volunteer nothing new. It is an
 * explicit allow-list all the same: the insert uses `RETURNING *` and a column added to `contact`
 * later must not become part of the response by accident.
 */
export interface ContactRow {
  id: string;
  household_id: string;
  voter_id: string | null;
  turf_id: string | null;
  at: Date | string;
  client_id: string | null;
  result: string;
  support: number | null;
  issues: string[];
  wants_sign: boolean;
  wants_volunteer: boolean;
  needs_ride: boolean;
  follow_up: boolean;
  note: string | null;
  user_id: string;
  user_name: string;
}

export function serializeContact(row: ContactRow): ContactRow {
  return {
    id: row.id,
    household_id: row.household_id,
    voter_id: row.voter_id,
    turf_id: row.turf_id,
    at: row.at,
    client_id: row.client_id,
    result: row.result,
    support: row.support,
    issues: row.issues,
    wants_sign: row.wants_sign,
    wants_volunteer: row.wants_volunteer,
    needs_ride: row.needs_ride,
    follow_up: row.follow_up,
    note: row.note,
    user_id: row.user_id,
    user_name: row.user_name,
  };
}

// ------------------------------------------------------------------ voter contacts (phone / email)

/**
 * A phone number or email address given AT THE DOOR (`voter_contact`, db/migrations/002).
 *
 * This is NOT list data — the clerk's list carries no phone numbers — so the role rules that shape
 * `serializeVoter` do not apply to it, and a different rule does: it may only be used for the
 * purpose that was consented to. The projection therefore always carries the consent state next to
 * the value, so no caller can hold the number without also holding what it may be used for, and
 * `withdrawn_at` travels with it because a withdrawn number is still a row (see the migration).
 *
 * Volunteers see the details of doors in their own turfs (they collected them, and they have to be
 * able to correct a mistyped number); the send list that leaves the system is organizer/admin only.
 */
export interface VoterContactRow {
  id: string;
  household_id: string;
  voter_id: string | null;
  voter_name: string | null;
  channel: string;
  value: string;
  consent_gotv: boolean;
  consent_updates: boolean;
  consent_note: string | null;
  consented_at: Date | string;
  collected_by: string | null;
  collected_by_name: string | null;
  contact_id: string | null;
  withdrawn_at: Date | string | null;
  withdrawn_note: string | null;
  created_at: Date | string;
}

export function serializeVoterContact(row: VoterContactRow): VoterContactRow {
  return {
    id: row.id,
    household_id: row.household_id,
    voter_id: row.voter_id,
    voter_name: row.voter_name,
    channel: row.channel,
    value: row.value,
    consent_gotv: row.consent_gotv,
    consent_updates: row.consent_updates,
    consent_note: row.consent_note,
    consented_at: row.consented_at,
    collected_by: row.collected_by,
    collected_by_name: row.collected_by_name,
    contact_id: row.contact_id,
    withdrawn_at: row.withdrawn_at,
    withdrawn_note: row.withdrawn_note,
    created_at: row.created_at,
  };
}

/**
 * One line of the GOTV send list (GET /api/voter-contacts/gotv) — organizer/admin only.
 *
 * The narrowest thing that can still address a message and be checked afterwards: who, how to
 * reach them, and the consent that authorises it. `consent_gotv` and `consented_at` are on the row
 * deliberately — whoever exports this list is the person who has to answer "what did they agree
 * to?" if it is ever questioned.
 */
export interface GotvContactRow {
  id: string;
  channel: string;
  value: string;
  voter_id: string | null;
  voter_name: string | null;
  household_id: string;
  address: string;
  ward: string;
  community: string | null;
  consent_note: string | null;
  consented_at: Date | string;
}

export function serializeGotvContact(row: GotvContactRow): GotvContactRow {
  return {
    id: row.id,
    channel: row.channel,
    value: row.value,
    voter_id: row.voter_id,
    voter_name: row.voter_name,
    household_id: row.household_id,
    address: row.address,
    ward: row.ward,
    community: row.community,
    consent_note: row.consent_note,
    consented_at: row.consented_at,
  };
}

// ------------------------------------------------------------------ lawn signs

/**
 * A sign is campaign logistics, not voter data: every signed-in role may place one and see the
 * whole list, because a sign nobody can find in November is a by-law fine. The only field here
 * that comes off the voters list is the joined household `address` (and `ward`), and those are
 * already in `HouseholdPublic` — so this projection gives a volunteer nothing that
 * `serializeHousehold` would not. It stays an explicit allow-list all the same: the sign queries
 * join `household`, and a widened join must not become a widened response by accident.
 */
export interface SignRow {
  id: string;
  household_id: string | null;
  address: string | null;
  ward: string | null;
  status: string;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  label: string | null;
  size: string | null;
  note: string | null;
  permission_by: string | null;
  requested_at: Date | string | null;
  requested_from: string | null;
  placed_by: string | null;
  placed_by_name: string | null;
  placed_at: Date | string | null;
  removed_by: string | null;
  removed_by_name: string | null;
  removed_at: Date | string | null;
  created_at: Date | string;
  client_id: string | null;
  photo_count: number;
}

export interface SignPublic {
  id: string;
  household_id: string | null;
  address: string | null;
  ward: string | null;
  status: string;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  label: string | null;
  size: string | null;
  note: string | null;
  permission_by: string | null;
  requested_at: Date | string | null;
  requested_from: string | null;
  placed_by: string | null;
  placed_by_name: string | null;
  placed_at: Date | string | null;
  removed_by: string | null;
  removed_by_name: string | null;
  removed_at: Date | string | null;
  created_at: Date | string;
  client_id: string | null;
  photo_count: number;
}

export function serializeSign(row: SignRow): SignPublic {
  return {
    id: row.id,
    household_id: row.household_id,
    address: row.address,
    ward: row.ward,
    status: row.status,
    lat: row.lat,
    lon: row.lon,
    accuracy_m: row.accuracy_m,
    label: row.label,
    size: row.size,
    note: row.note,
    permission_by: row.permission_by,
    requested_at: row.requested_at,
    requested_from: row.requested_from,
    placed_by: row.placed_by,
    placed_by_name: row.placed_by_name,
    placed_at: row.placed_at,
    removed_by: row.removed_by,
    removed_by_name: row.removed_by_name,
    removed_at: row.removed_at,
    created_at: row.created_at,
    client_id: row.client_id,
    photo_count: row.photo_count,
  };
}

/** Photo metadata only — `path` is never serialized; the bytes come from GET /api/signs/photo/:id. */
export interface SignPhotoRow {
  id: string;
  sign_id: string;
  path: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  taken_by: string | null;
  taken_by_name: string | null;
  taken_at: Date | string;
}

export interface SignPhotoPublic {
  id: string;
  sign_id: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  taken_by: string | null;
  taken_by_name: string | null;
  taken_at: Date | string;
}

export function serializeSignPhoto(row: SignPhotoRow): SignPhotoPublic {
  return {
    id: row.id,
    sign_id: row.sign_id,
    content_type: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    taken_by: row.taken_by,
    taken_by_name: row.taken_by_name,
    taken_at: row.taken_at,
  };
}

/** One line on the retrieval worklist (GET /api/signs/pickup) — everything needed to find it. */
export interface PickupRow {
  id: string;
  status: string;
  ward: string | null;
  address: string | null;
  label: string | null;
  size: string | null;
  note: string | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  placed_at: Date | string | null;
  placed_by_name: string | null;
  photo_ids: string[];
}

export function serializePickup(row: PickupRow): PickupRow {
  return {
    id: row.id,
    status: row.status,
    ward: row.ward,
    address: row.address,
    label: row.label,
    size: row.size,
    note: row.note,
    lat: row.lat,
    lon: row.lon,
    accuracy_m: row.accuracy_m,
    placed_at: row.placed_at,
    placed_by_name: row.placed_by_name,
    photo_ids: row.photo_ids,
  };
}

/**
 * One outstanding sign request (GET /api/signs/requests) — a door whose latest contact ticked
 * `wants_sign` and which has no sign yet. Unlike the rest of /api/signs this IS voter data, so the
 * projection is narrow on purpose: household fields limited to what `HouseholdPublic` allows, and
 * the only voter field is `display_name`, which volunteers already get on their own turf's doors.
 */
export interface SignRequestRow {
  household_id: string;
  address: string;
  ward: string;
  community: string | null;
  lat: number | null;
  lon: number | null;
  contact_id: string;
  last_contact_at: Date | string;
  last_result: string;
  note: string | null;
  user_id: string;
  user_name: string;
  voter_id: string | null;
  voter_name: string | null;
}

export function serializeSignRequest(row: SignRequestRow): SignRequestRow {
  return {
    household_id: row.household_id,
    address: row.address,
    ward: row.ward,
    community: row.community,
    lat: row.lat,
    lon: row.lon,
    contact_id: row.contact_id,
    last_contact_at: row.last_contact_at,
    last_result: row.last_result,
    note: row.note,
    user_id: row.user_id,
    user_name: row.user_name,
    voter_id: row.voter_id,
    voter_name: row.voter_name,
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
