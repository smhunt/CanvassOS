/**
 * Given-name equivalences for the subscriber matcher. "Bob Smith" on the website form and
 * "ROBERT SMITH" on the voters list are very likely the same person, and a trigram score alone
 * cannot see that — 'bob' and 'robert' share almost nothing.
 *
 * Deliberately a short, boring list of common English/French-Canadian pairs rather than a
 * library: every entry here widens the candidate net, and a too-clever table (e.g. initials,
 * surnames-as-first-names) would fill the organizer queue with noise. Matching is local-only
 * (see docs/phase-8-subscriber-link-plan.md), so this file is the whole "AI".
 *
 * Each cluster is a set of names that may refer to the same person. Lookup is symmetric and
 * transitive within a cluster; all names lowercase.
 */
const CLUSTERS: string[][] = [
  ['robert', 'rob', 'bob', 'bobby', 'bert'],
  ['william', 'will', 'bill', 'billy', 'liam'],
  ['richard', 'rick', 'dick', 'rich', 'ricky'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'jack', 'johnny', 'jon'],
  ['jonathan', 'jon', 'jonny'],
  ['michael', 'mike', 'mick', 'micky'],
  ['david', 'dave', 'davey'],
  ['christopher', 'chris', 'kit'],
  ['christine', 'chris', 'christy', 'christina', 'tina'],
  ['daniel', 'dan', 'danny'],
  ['matthew', 'matt'],
  ['anthony', 'tony'],
  ['andrew', 'andy', 'drew'],
  ['joseph', 'joe', 'joey'],
  ['thomas', 'tom', 'tommy'],
  ['charles', 'charlie', 'chuck', 'chas'],
  ['kenneth', 'ken', 'kenny'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie'],
  ['edward', 'ed', 'eddie', 'ted', 'ned'],
  ['gerald', 'gerry', 'jerry'],
  ['gregory', 'greg'],
  ['jeffrey', 'jeff'],
  ['stephen', 'steve', 'steven', 'stevie'],
  ['peter', 'pete'],
  ['patrick', 'pat', 'paddy'],
  ['patricia', 'pat', 'patty', 'tricia', 'trish'],
  ['nicholas', 'nick', 'nic'],
  ['nicole', 'nikki', 'nicki'],
  ['alexander', 'alex', 'sandy', 'al'],
  ['alexandra', 'alex', 'sandra', 'sandy'],
  ['benjamin', 'ben', 'benny'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam'],
  ['timothy', 'tim', 'timmy'],
  ['lawrence', 'larry'],
  ['leonard', 'len', 'lenny'],
  ['frederick', 'fred', 'freddie'],
  ['raymond', 'ray'],
  ['francis', 'frank', 'fran'],
  ['frances', 'fran', 'frannie'],
  ['francois', 'frank'],
  ['henry', 'hank', 'harry'],
  ['walter', 'walt', 'wally'],
  ['albert', 'al', 'bert'],
  ['arthur', 'art', 'artie'],
  ['eugene', 'gene'],
  ['vincent', 'vince', 'vinny'],
  ['douglas', 'doug'],
  ['dennis', 'denny'],
  ['russell', 'russ'],
  ['margaret', 'maggie', 'meg', 'peggy', 'peg', 'marge', 'margie'],
  ['elizabeth', 'liz', 'beth', 'betty', 'betsy', 'eliza', 'lizzie', 'libby'],
  ['katherine', 'kate', 'katie', 'kathy', 'kay', 'catherine', 'cathy', 'kat'],
  ['kathleen', 'kathy', 'kate', 'katie'],
  ['jennifer', 'jen', 'jenny'],
  ['jessica', 'jess', 'jessie'],
  ['rebecca', 'becky', 'becca'],
  ['deborah', 'deb', 'debbie', 'debra'],
  ['barbara', 'barb', 'barbie'],
  ['susan', 'sue', 'susie', 'suzanne'],
  ['sandra', 'sandy'],
  ['cynthia', 'cindy'],
  ['pamela', 'pam'],
  ['donna', 'don'],
  ['linda', 'lindy'],
  ['carolyn', 'carol', 'caroline', 'carrie'],
  ['victoria', 'vicky', 'vicki', 'tori'],
  ['veronica', 'ronnie'],
  ['stephanie', 'steph'],
  ['melissa', 'mel', 'missy'],
  ['melanie', 'mel'],
  ['amanda', 'mandy'],
  ['abigail', 'abby'],
  ['gabrielle', 'gabby', 'gabriella'],
  ['gabriel', 'gabe'],
  ['isabella', 'bella', 'izzy', 'isabelle'],
  ['danielle', 'dani'],
  ['michelle', 'shelly'],
  ['angela', 'angie'],
  ['virginia', 'ginny'],
  ['dorothy', 'dot', 'dottie'],
  ['florence', 'flo'],
  ['eleanor', 'ellie', 'nell'],
  ['emily', 'em', 'emmy'],
  ['emma', 'em'],
  ['natalie', 'nat'],
  ['natasha', 'tasha'],
  ['bradley', 'brad'],
  ['bradford', 'brad'],
  ['randall', 'randy'],
  ['harold', 'harry', 'hal'],
  ['norman', 'norm'],
  ['stanley', 'stan'],
  ['stewart', 'stu', 'stuart'],
  ['maxwell', 'max'],
  ['maximilian', 'max'],
  ['zachary', 'zach', 'zack'],
  ['jacob', 'jake'],
  ['joshua', 'josh'],
  ['nathaniel', 'nate', 'nathan'],
  ['theodore', 'ted', 'theo', 'teddy'],
  ['terrence', 'terry'],
  ['sean', 'shawn', 'shaun'],
  ['jean', 'john'],
  ['jacques', 'jack'],
  ['pierre', 'peter'],
  ['guillaume', 'william'],
  ['mathieu', 'matthew'],
  ['luc', 'luke', 'lucas'],
  ['marc', 'mark'],
];

/** name (lowercase) -> every name in its cluster(s), itself excluded. */
const EQUIV = new Map<string, Set<string>>();
for (const cluster of CLUSTERS) {
  for (const name of cluster) {
    let set = EQUIV.get(name);
    if (!set) {
      set = new Set<string>();
      EQUIV.set(name, set);
    }
    for (const other of cluster) if (other !== name) set.add(other);
  }
}

/**
 * All the first names this one might appear as on the voters list, the name itself first.
 * Input any case; output lowercase, deduplicated, insertion-ordered.
 */
export function firstNameVariants(first: string): string[] {
  const name = first.trim().toLowerCase();
  if (!name) return [];
  const out = [name];
  const equiv = EQUIV.get(name);
  if (equiv) for (const v of equiv) out.push(v);
  return out;
}
