/**
 * Turf scoping for volunteers (API.md "Rule for volunteers").
 *
 * Phase 1 gave volunteers nothing but the anonymous map points. Phase 2 widens that by exactly
 * one rule: a volunteer may read and write the doors of the turfs they are assigned to, and
 * nothing else. Every route that a volunteer can reach with a household or turf id in it calls
 * one of these helpers; organizers and admins bypass them (`isOrganizer`).
 */
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { forbidden } from './errors.js';
import { isOrganizer, type Role } from './serialize.js';

/** Is this user assigned to this turf? */
export async function userHasTurf(db: Queryable, turfId: string, userId: string): Promise<boolean> {
  const row = await one<{ ok: number }>(db, `SELECT 1 AS ok FROM assignment WHERE turf_id = $1 AND user_id = $2`, [
    turfId,
    userId,
  ]);
  return row !== undefined;
}

/** Is this household inside any turf assigned to this user? */
export async function householdInUserTurfs(db: Queryable, householdId: string, userId: string): Promise<boolean> {
  const row = await one<{ ok: number }>(
    db,
    `SELECT 1 AS ok
     FROM turf_household x JOIN assignment a ON a.turf_id = x.turf_id
     WHERE x.household_id = $1 AND a.user_id = $2
     LIMIT 1`,
    [householdId, userId],
  );
  return row !== undefined;
}

/** Organizer/admin: any turf. Volunteer: only an assigned one, else 403. */
export async function assertTurfAccess(db: Queryable, role: Role, turfId: string, userId: string): Promise<void> {
  if (isOrganizer(role)) return;
  if (!(await userHasTurf(db, turfId, userId))) {
    throw forbidden('this turf is not assigned to you', 'not_your_turf');
  }
}

/** Organizer/admin: any household. Volunteer: only one inside an assigned turf, else 403. */
export async function assertHouseholdAccess(
  db: Queryable,
  role: Role,
  householdId: string,
  userId: string,
): Promise<void> {
  if (isOrganizer(role)) return;
  if (!(await householdInUserTurfs(db, householdId, userId))) {
    throw forbidden('this household is not in one of your turfs', 'not_your_turf');
  }
}
