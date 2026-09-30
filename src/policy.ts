/**
 * Memory policy: what gets stored, who decides to store it, and how hard to
 * look before answering.
 *
 * Three independent axes rather than one flat preset list. "Preferences only,
 * saved only when I ask, but searched hard" is a combination people actually
 * want, and a single list can't offer it without enumerating the cross product.
 *
 * Reading and writing are deliberately separate. Writing is the side with the
 * privacy cost, so it gets its own switch; searching what the user already
 * chose to store costs them nothing but latency, which is why the axes have
 * different defaults and why /memory-save can override one without the other.
 *
 * The policy's entire job is to reach the model, so it travels three paths: the
 * MCP `instructions` field (injected once per session into the system prompt),
 * the tool descriptions (which travel with the tools), and the lifecycle hook
 * (re-stated at every turn boundary). The first two, because a client that
 * ignores `instructions` still renders tool descriptions, and a client that
 * defers tool schemas until first use still shows `instructions`. The third
 * because neither of the first two fires at the moment the decision is made:
 * both are read once and then compete with whatever the user actually asked
 * for, and the turn spent on a real task is precisely the turn that produces a
 * fact worth keeping. Arriving is not the same as being acted on.
 */

export const MEMORY_SCOPES = ['preferences', 'important', 'everything', 'custom'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const RECALL_LEVELS = ['minimal', 'balanced', 'aggressive'] as const;
export type RecallLevel = (typeof RECALL_LEVELS)[number];

/**
 * Why no scope is in force. Each reads back to the user as a different problem
 * with a different fix, so they are not collapsed into one "broken" state.
 */
export const UNCONFIGURED_REASONS = ['unset', 'invalid', 'custom-missing'] as const;
export type UnconfiguredReason = (typeof UNCONFIGURED_REASONS)[number];

export interface MemoryPolicy {
  /**
   * null means the user has never successfully chosen a scope. It is a real
   * state, not a placeholder a default gets substituted into: a scope decides
   * what may be written about someone, and nobody but them can decide it.
   * Writing is refused outright while it holds.
   */
  scope: MemoryScope | null;
  /** False means never write unprompted; recall is unaffected either way. */
  autosave: boolean;
  recall: RecallLevel;
  /** Verbatim user-authored rule. Guaranteed non-empty when scope is 'custom'. */
  customText?: string;
  /** Set if and only if scope is null. */
  reason?: UnconfiguredReason;
}

// No DEFAULT_SCOPE, deliberately. Every other setting here has a defensible
// default because getting it wrong costs the user latency or tidiness; a scope
// that is wrong costs them data they never agreed to hand over. There is no
// value this file could pick that would be their answer, so it doesn't pick one
// — an unset scope stays unset, visibly, until they say.
export const DEFAULT_AUTOSAVE = true;
export const DEFAULT_RECALL = 'balanced' satisfies RecallLevel;

const RECALL_RULES: Record<RecallLevel, string> = {
  minimal:
    'Call `recallMemory` only when the user points at the past themselves — "remember when", ' +
    '"like I told you", "my usual setup" — or when they run `/memory-recall`. Otherwise do not go ' +
    'looking; answer from what is in front of you.',
  balanced:
    'Call `recallMemory` when the question plausibly depends on this user\'s preferences, past ' +
    'decisions, or personal context — especially before advising, recommending, or making a choice ' +
    'on their behalf. Skip it for self-contained or mechanical requests where nothing about them ' +
    'would change the answer.',
  aggressive:
    'Call `recallMemory` before every substantive answer, not just the ones that obviously depend ' +
    'on personal context — assume something relevant is stored until a search says otherwise. ' +
    'Prefer several narrow queries over one broad one. Never conclude you don\'t know something ' +
    'about this user without checking first: an empty result costs one call, a wrong assumption ' +
    'costs their trust.',
};

export function recallRule(policy: MemoryPolicy): string {
  return RECALL_RULES[policy.recall];
}

const SCOPE_RULES: Record<Exclude<MemoryScope, 'custom'>, string> = {
  preferences:
    'Store ONLY the user\'s preferences: how they like to communicate, their workflow habits, ' +
    'and the tools, languages, and coding styles they favour or avoid. Do not store biographical ' +
    'facts, project details, or one-off decisions — however interesting they seem.',
  important:
    'Store the user\'s preferences, plus the durable facts that change how you should work with ' +
    'them: decisions they have committed to, constraints they operate under, and background that ' +
    'stays true across sessions. Skip trivia and anything that expires within days.',
  everything:
    'Store any durable personal fact about the user: preferences, experiences, opinions, ' +
    'background, and working context.',
};

/**
 * Each names the real problem rather than "something went wrong", because the
 * model relays this to the user and the fix differs per case.
 */
const UNCONFIGURED_RULES: Record<UnconfiguredReason, string> = {
  unset:
    'Nothing may be stored. This user has never chosen what you are allowed to remember about ' +
    'them, so there is no scope in force — and an unanswered question is not permission. Do not ' +
    'guess a scope on their behalf.',
  invalid:
    'Nothing may be stored. This user\'s configured scope is not a value this server recognises — ' +
    'likely a typo — so no scope is in force. Do not guess at what they meant.',
  'custom-missing':
    'Nothing may be stored. This user wrote their own scope rule, but the file holding it is ' +
    'missing or empty, so no scope is in force. Writing a custom rule is how someone narrows what ' +
    'you may keep — treating the lost rule as permission to keep more would invert their intent.',
};

export function scopeRule(policy: MemoryPolicy): string {
  if (policy.scope === null) return UNCONFIGURED_RULES[policy.reason ?? 'unset'];
  // customText is guaranteed non-empty for 'custom' — a custom scope that lost
  // its rule is resolved to scope: null upstream, never silently broadened.
  if (policy.scope === 'custom') return policy.customText!;
  return SCOPE_RULES[policy.scope];
}

const UNCONFIGURED_WRITE_RULE =
  'Do NOT call `createMemory` — not on your own initiative, and not on request. The server will ' +
  'refuse it anyway. Storing something under no policy at all means storing it outside anything ' +
  'this user has agreed to, which is the one case an explicit request cannot wave through: they ' +
  'cannot consent to a scope they have not seen.\n\n' +
  'So raise it instead. If they ask you to remember something, or if you learn something you would ' +
  'otherwise have saved, tell them plainly that their memory policy is not set, say what was about ' +
  'to be stored, and point them to the memory configuration workflow. Then honour whatever they pick — ' +
  'their answer takes effect once they restart their AI client.\n\n' +
  'This blocks writing only. Memories already stored are read and searched as normal.';

export function autosaveRule(policy: MemoryPolicy): string {
  if (policy.scope === null) return UNCONFIGURED_WRITE_RULE;
  return policy.autosave
    ? 'When you learn something that fits the scope above, call `createMemory` on your own ' +
        'initiative — do not wait to be asked. Call `recallMemory` first to check for an existing ' +
        'or conflicting version, and call `updateMemory` on that one instead of storing a duplicate.'
    : 'Do NOT call `createMemory` on your own initiative, no matter how clearly a fact fits the ' +
        'scope above. Write only when the user explicitly asks you to — `/memory-save`, "remember ' +
        'this", or similar. This restricts writing only: recall stays proactive, and reading ' +
        'memory never needs permission.';
}

/** One line for humans — setup output and policy summaries. */
export function summarizePolicy(policy: MemoryPolicy): string {
  if (policy.scope === null) return `not set (${policy.reason}) · stores nothing · ${policy.recall} recall`;
  const when = policy.autosave ? 'saves proactively' : 'saves only when asked';
  return `${policy.scope} · ${when} · ${policy.recall} recall`;
}

/**
 * The closing line has to differ by state. Telling the model the user chose a
 * policy is what makes it treat the policy as authoritative — so it may only be
 * said when they actually did. Asserted over a fallback, it would launder a
 * default this file invented into a decision the user appears to have made,
 * and the model would then defend it on their behalf.
 */
function provenance(policy: MemoryPolicy): string {
  if (policy.scope === null) {
    return `No part of the above is this user's decision — they have not made one yet. Nothing here is
a default standing in for their answer, because on this question there is no sane default to
stand in. Get their answer.`;
  }
  return `This policy was chosen by the user themselves. Follow it as written; if they ask you to store
something outside it, do as they ask — an explicit request always outranks the policy.`;
}

/**
 * What the hook injects alongside each prompt, or null when the policy leaves
 * it nothing to say.
 *
 * Restates the rules rather than pointing at the copy already in the system
 * prompt, because that copy going unread is the entire reason this path exists
 * — a reminder that says "recall the rule you were given" is one indirection
 * away from being skipped exactly like the rule was.
 *
 * Covers both axes, because both decay the same way and for the same reason.
 * Autosave is what visibly failed, but a session that never searches has the
 * worse failure: it answers from an assumption while the correction sits in the
 * database, and unlike a missed write it leaves no gap anyone will notice.
 *
 * Silent axes are omitted rather than described. Telling the model "do not go
 * looking, do not save unprompted" spends tokens every turn to ask for the
 * behaviour that happens anyway when nothing is said at all.
 */
export function buildTurnReminder(policy: MemoryPolicy): string | null {
  const duties: string[] = [];

  // Minimal recall is excluded deliberately: its rule is "wait to be asked",
  // and nagging a model each turn to keep not doing something is noise. The
  // decay this repairs runs one way — toward answering without looking.
  if (policy.recall !== 'minimal') {
    duties.push(`### Search before you answer\n\n${recallRule(policy)}`);
  }

  if (policy.scope !== null && policy.autosave) {
    duties.push(
      `### Keep what this turn reveals\n\n${scopeRule(policy)}\n\n` +
        `Never store general knowledge, summaries of your own answers, or facts about anyone but this user.\n\n` +
        `If something fits, call \`recallMemory\` first to catch an existing or conflicting version, then ` +
        `\`createMemory\` — or \`updateMemory\` on what you found, rather than storing a near-duplicate.`,
    );
  }

  if (duties.length === 0) return null;

  return `<oak-memory-reminder>
Automatic reminder, injected on every prompt. The user did not write this, did not ask for it, and is
not waiting on an answer to it. You have persistent memory of this user; these are the standing duties
their policy attaches to it.

${duties.join('\n\n')}

Fold this into the turn you were actually asked to do: no permission requests, no announcing the check,
no reporting that you found nothing. If none of it applies — the common case — ignore it entirely.
</oak-memory-reminder>`;
}

export function buildServerInstructions(policy: MemoryPolicy): string {
  return `oak-memory gives you persistent long-term memory about this user, held in a local database
that outlives every session and every project.

## When to recall

${recallRule(policy)}

## What to remember

${scopeRule(policy)}

Never store general knowledge, summaries of your own answers, or facts about anyone but this user.

## When to write

${autosaveRule(policy)}

${provenance(policy)}`;
}
