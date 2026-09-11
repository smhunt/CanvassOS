/**
 * The words a notification actually says, for every event in docs/phase-7-notifications-plan.md §1.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE IS PLAIN STRINGS
 * ---------------------------------------------------------------------------------------------
 * 1. **A campaign manager edits these, not a programmer.** The tone of "a turf was taken off you"
 *    is a volunteer-relations decision, not an engineering one, and the person who should make it
 *    does not write TypeScript. So: one obvious object per event, `{placeholder}` substitution, no
 *    template engine, no dependency, no conditional logic hiding inside a string. If it cannot be
 *    changed by typing over the words between the quotes, it is in the wrong file.
 *
 * 2. **Nothing here may name an elector.** The placeholders are ids, counts, and labels the
 *    campaign itself typed (a turf's name, a campaign's name). A delivered push sits in iOS
 *    Notification Centre, is mirrored to a desktop, and `make purge` cannot reach any of it — so
 *    the body is a pointer ("a door on your turf needs a follow-up"), never the content. The
 *    voters list is personal information under the *Municipal Elections Act, 1996* s. 23(7)-(8)
 *    and a lock screen is not a place it may appear. A `{voter_name}` placeholder here is the
 *    single easiest way to breach that.
 *
 * 3. **Two audiences per event.** `receiver` is what the person being told reads; `sender` is the
 *    confirmation shown to whoever caused it. Different sentences — reusing one is how a
 *    notification ends up addressed to the wrong person.
 *
 * Nothing imports this yet. It is the vocabulary for a delivery path that has not been built.
 */

export type NotificationKind =
  | 'turf_assigned'
  | 'turf_unassigned'
  | 'door_follow_up'
  | 'sign_requested'
  | 'campaign_finished'
  | 'campaign_failed';

/** Placeholder values. Ids, counts and campaign-authored labels only — never a row off the list. */
export type TemplateValues = Record<string, string | number | null | undefined>;

export interface NotificationTemplate {
  kind: NotificationKind;
  /** One line. Phones truncate hard — say the thing in the first six words. */
  title: string;
  /** One or two short sentences. Assume it is read one-handed, outdoors, in a hurry. */
  body: string;
}

export interface TemplatePair {
  /** Shown to the person the notification is about. */
  receiver: NotificationTemplate;
  /** Shown to the person who caused the event, as a confirmation. */
  sender: NotificationTemplate;
}

export const TEMPLATES: Record<NotificationKind, TemplatePair> = {
  // The volunteer needs the turf's name and the date — enough to decide "tonight or Saturday?"
  // without opening anything. The organiser needs to know it landed on the right person.
  turf_assigned: {
    receiver: {
      kind: 'turf_assigned',
      title: 'New turf: {turf_name}',
      body: '{actor_name} assigned you {turf_name} ({door_count} doors). Due {due_date}.',
    },
    sender: {
      kind: 'turf_assigned',
      title: 'Assigned {turf_name}',
      body: '{turf_name} is now with {user_name}.',
    },
  },

  // The only thing that matters here is "stop walking it" — a volunteer who misses this knocks
  // doors somebody else is also knocking, which is worse than not knocking them.
  turf_unassigned: {
    receiver: {
      kind: 'turf_unassigned',
      title: 'Turf removed: {turf_name}',
      body: '{turf_name} is no longer assigned to you. Nothing more to do there.',
    },
    sender: {
      kind: 'turf_unassigned',
      title: 'Removed {turf_name}',
      body: '{turf_name} is no longer assigned to {user_name}.',
    },
  },

  // Deliberately vague about WHICH door. The organiser taps through and reads the note under the
  // usual role rules; the notification only says a door exists and roughly where. Coalesced, so
  // the count is doing real work — six separate buzzes is how people turn notifications off.
  door_follow_up: {
    receiver: {
      kind: 'door_follow_up',
      title: 'Follow-up needed',
      body: '{count} door(s) on {turf_name} were flagged for follow-up. Open the app to see them.',
    },
    sender: {
      kind: 'door_follow_up',
      title: 'Follow-up flagged',
      body: 'Flagged for follow-up. An organiser has been told.',
    },
  },

  // A sign request is a delivery job with a by-law deadline behind it, so whoever runs the sign
  // run needs the street to plan a route — and nothing more than the street.
  sign_requested: {
    receiver: {
      kind: 'sign_requested',
      title: 'Lawn sign requested',
      body: 'A sign was requested on {street_name}. It is on the delivery list.',
    },
    sender: {
      kind: 'sign_requested',
      title: 'Sign request recorded',
      body: 'The sign request is on the delivery list.',
    },
  },

  // A send is a multi-hour drip. "It finished" is the notification, and the failed count is the
  // number worth waking up for — Canadian long codes drop filtered messages silently.
  campaign_finished: {
    receiver: {
      kind: 'campaign_finished',
      title: 'Send finished: {campaign_name}',
      body: '{sent} sent, {failed} failed, {skipped} skipped.',
    },
    sender: {
      kind: 'campaign_finished',
      title: 'Send finished: {campaign_name}',
      body: '{sent} sent, {failed} failed, {skipped} skipped.',
    },
  },

  // The one notification somebody genuinely needs at 11pm: a stalled send looks identical to a
  // slow one, and the difference only shows up after the polls close.
  campaign_failed: {
    receiver: {
      kind: 'campaign_failed',
      title: 'Send stopped: {campaign_name}',
      body: 'Stopped after {sent} sent, {remaining} still waiting. Reason: {reason}.',
    },
    sender: {
      kind: 'campaign_failed',
      title: 'Send stopped: {campaign_name}',
      body: 'Stopped after {sent} sent, {remaining} still waiting. Reason: {reason}.',
    },
  },
};

/**
 * Substitute `{placeholder}` from `values`.
 *
 * A missing or null value becomes an empty string rather than a literal `{due_date}`, because a
 * half-rendered placeholder on a lock screen reads as a broken app. The cost is that a template
 * with a typo'd name renders a sentence with a hole in it — which is the right trade for strings a
 * non-programmer is expected to edit, and is why every template above reads acceptably if any one
 * value goes missing. Leading/trailing whitespace is collapsed for the same reason.
 */
export function render(t: NotificationTemplate, values: TemplateValues): { title: string; body: string } {
  return { title: fill(t.title, values), body: fill(t.body, values) };
}

function fill(s: string, values: TemplateValues): string {
  return s
    .replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v = values[key];
      return v === null || v === undefined ? '' : String(v);
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}
