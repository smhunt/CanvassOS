/**
 * Plain-language advice on the reachability report, written by Claude from the aggregate counts.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED LIKE THIS — the privacy design, which is the hard part
 * ---------------------------------------------------------------------------------------------
 * This is the second thing in the whole stack that talks to a third party (the first is
 * `streetview.ts`, and the argument there applies here). The voters list is personal information
 * supplied under the *Municipal Elections Act, 1996*, and s. 23(8) says a recipient "shall not
 * provide it to any other person". Posting the list — or any row of it — to a model provider would
 * be exactly that. So:
 *
 * 1. **Only counts leave the building.** `buildFacts()` takes the already-aggregated response and
 *    reduces it to category codes and integers. It cannot see a voter or household row: its
 *    parameter type has no field that could carry one. There is no address, no name, no household
 *    id, not even a ward-level list small enough to re-identify a person — a ward is thousands of
 *    doors. `assertNoPersonalData()` re-checks the serialised payload before it is sent, because
 *    "the type says it is safe" is an argument that stops being true the day someone widens the
 *    type.
 *
 * 2. **The key never reaches the browser.** Everything here is server-side, behind the same
 *    organizer-or-above gate as the report itself.
 *
 * 3. **Off unless configured.** No `ADVICE_API_KEY`, no call, and the report renders its own
 *    written guidance instead. A campaign is entitled to decide it would rather send nothing.
 *
 * 4. **Cached on the shape of the numbers, not on time.** The counts move a few doors a day, and
 *    the report gets opened repeatedly during planning; re-billing an identical question on every
 *    page load would be waste, not diligence. The cache key is a hash of the exact facts sent, so
 *    the advice changes when — and only when — the numbers do.
 *
 * 5. **A failure here is never a failure of the report.** The numbers are the product; the prose is
 *    a garnish. Every error path returns null and the route carries on.
 */
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { FetchLike } from './streetview.js';

/** The only thing that is ever sent: a category code and two integers. */
export interface AdviceFact {
  code: string;
  kind: string;
  blocks: string[];
  scope: string;
  count: number;
  share: number;
}
export interface AdviceInput {
  households: number;
  voters: number;
  blocked: number;
  mail_blocked: number;
  facts: AdviceFact[];
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 20_000;
const MAX_CACHE = 32;

/** hash(facts) -> advice. Bounded, because it is keyed on data that can keep changing. */
const cache = new Map<string, string>();

/**
 * The guard that survives someone widening `AdviceInput` later.
 *
 * Anything with a street number, a postal code, an `H-…` household id or an @ sign has no business
 * in a payload of counts, and its presence means a caller is passing rows. Throwing is correct:
 * silently sending it is the one outcome this file exists to prevent.
 */
export function assertNoPersonalData(payload: string): void {
  const patterns: [RegExp, string][] = [
    [/H-[A-Z]+-\d+/, 'household id'],
    [/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i, 'postal code'],
    [/@/, 'email address'],
    [/\b\d{1,5}\s+[A-Z][a-z]+\s+(St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Line|Cres|Crescent)\b/i, 'street address'],
  ];
  for (const [re, what] of patterns) {
    if (re.test(payload)) throw new Error(`refusing to send: payload contains a ${what}`);
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The prompt. Deliberately boring: the model is writing prose about arithmetic it is handed. */
function buildPrompt(input: AdviceInput): string {
  const lines = input.facts
    .map((f) => `- ${f.code} (${f.kind}, blocks ${f.blocks.join('+')}): ${f.count} ${f.scope === 'voter' ? 'electors' : 'doors'}, ${pct(f.share)}`)
    .join('\n');
  return [
    'You are advising a municipal election campaign in Middlesex Centre, Ontario (population ~17,000 electors,',
    'election day 26 October 2026) on the parts of the voters list it cannot reach.',
    '',
    `Doors: ${input.households}. Electors: ${input.voters}.`,
    `Doors that cannot be knocked at all: ${input.blocked}.`,
    `Doors that cannot receive addressed lettermail: ${input.mail_blocked}.`,
    '',
    'Categories:',
    lines,
    '',
    'Write 3-5 sentences of practical advice for the candidate on where to spend effort.',
    'Rules:',
    '- "Unreachable" is not one thing. A PO-box mailing address blocks lettermail only; that door is',
    '  perfectly knockable. A non-resident owner can be reached by post but never by knocking here.',
    '  Never add these together into a single unreachable figure.',
    '- The categories overlap, so never sum them. Use the two totals given above as given.',
    '- Doors and electors are different denominators. Do not compare them.',
    '- Be concrete about what to DO. No preamble, no headings, no bullet points, no restating the',
    '  numbers back as a list. Plain prose a busy candidate reads once.',
  ].join('\n');
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
}

/**
 * Returns the advice, or null when the feature is off or anything at all goes wrong.
 *
 * Never throws: the caller is a report that must render with or without this.
 */
export async function adviseOnReachability(
  input: AdviceInput,
  config: Config,
  log: FastifyBaseLogger,
  httpFetch: FetchLike,
): Promise<string | null> {
  if (!config.ADVICE_API_KEY) return null;

  const prompt = buildPrompt(input);
  try {
    assertNoPersonalData(prompt);
  } catch (err) {
    // A programming error upstream, not a transient failure. Loud, and no request goes out.
    log.error({ err }, 'advice: refusing to send a payload that failed the personal-data check');
    return null;
  }

  const key = createHash('sha256').update(prompt).digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await httpFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ADVICE_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: config.ADVICE_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status }, 'advice: provider returned an error');
      return null;
    }
    const body = (await res.json()) as AnthropicResponse;
    const text = (body.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('')
      .trim();
    if (!text) return null;

    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, text);
    return text;
  } catch (err) {
    log.warn({ err }, 'advice: provider call failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam only. */
export function _clearAdviceCache(): void {
  cache.clear();
}
