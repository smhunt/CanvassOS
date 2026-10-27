import type { HelpTopic } from '../components/HelpButton';
import {
  ACCOUNT_HELP,
  AUDIT_HELP,
  CANVASS_HELP,
  DOOR_HELP,
  MAP_HELP,
  MESSAGING_HELP,
  REPORTS_HELP,
  REQUESTS_HELP,
  SIGNS_HELP,
  STATS_HELP,
  TURFS_HELP,
  TURNOUT_HELP,
  USERS_HELP,
} from './topics';

/**
 * Which help the top bar's question mark opens, by route. Pure so it can be tested without a
 * router; keep it in step with the <Route> table in App.tsx.
 *
 * Two routes deliberately have none. Drive mode carries its own button on the drive bar, which
 * speaks on open and resets the door announcement on close — a second, silent one above it would
 * be the same words behaving differently. The turf sheet is a page for the printer.
 */
export function helpFor(pathname: string): HelpTopic | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/map' || p.startsWith('/map/')) return MAP_HELP;
  if (p === '/canvass') return CANVASS_HELP;
  if (/^\/canvass\/[^/]+\/drive$/.test(p)) return null;
  if (/^\/canvass\/[^/]+$/.test(p)) return DOOR_HELP;
  if (p === '/turfs') return TURFS_HELP;
  if (/^\/turfs\/[^/]+\/sheet$/.test(p)) return null;
  switch (p) {
    case '/signs':
      return SIGNS_HELP;
    case '/requests':
      return REQUESTS_HELP;
    case '/messaging':
      return MESSAGING_HELP;
    case '/reports':
      return REPORTS_HELP;
    case '/stats':
      return STATS_HELP;
    case '/turnout':
      return TURNOUT_HELP;
    case '/admin/users':
      return USERS_HELP;
    case '/admin/audit':
      return AUDIT_HELP;
    case '/account':
      return ACCOUNT_HELP;
    default:
      return null;
  }
}
