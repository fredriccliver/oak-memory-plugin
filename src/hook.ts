/**
 * UserPromptSubmit hook: the policy, restated where the decision is made.
 *
 * `instructions` reaches the model once, at session start, and then spends the
 * session competing for attention with whatever the user actually asked for.
 * That competition has a predictable loser: the turn spent on a real task is
 * both the turn that surfaces a fact worth keeping and the turn least likely to
 * spare a thought for keeping it. So autosave failed in the quietest way open
 * to it — not by refusing, but by never coming up. A rule that arrives and
 * loses is indistinguishable from one that never arrived.
 *
 * The fix is not more authority, it is better timing: this fires on every
 * prompt and rides into context beside it, so the rule is adjacent to the work
 * instead of an hour behind it. The harness decides that it runs, which is the
 * point — the model's judgement about when to think of memory is the thing that
 * failed, so nothing here is left to it.
 *
 * Stop was the other candidate and was built, tested, and rejected on evidence.
 * It fires at the turn boundary, which is strictly better timing for the write
 * side — it sees facts that surfaced mid-turn, which this hook only catches on
 * the next prompt. But blocking a stop forces the model to emit another
 * message, and there is no such thing as an empty one: every turn ends up
 * carrying a visible "nothing to save here", and under `claude -p`, where only
 * the last message is printed, that line *replaces the answer*. Silence cannot
 * be prompted for; it has to be structural. This hook injects context and adds
 * no message at all, which is why it is the one that shipped.
 *
 * Emits the active store reminder on every prompt. Cloud profiles receive no local
 * scope rules; unavailable policies keep mutation suspension explicit.
 *
 * Always exits 0, including on its own bugs. Exit 2 here would erase the
 * user's prompt, and no memory reminder is worth eating what they typed.
 */

import { loadPolicy } from './env.js';
import { attributionInstructions, resolveBackend } from './profiles.js';
import { buildTurnReminder } from './policy.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  // Read and discard: the payload carries the prompt, but nothing here depends
  // on it — the reminder is the same every turn, and deciding per-prompt whether
  // a fact "might" appear is the model's judgement call, which is exactly the
  // one this hook exists to stop relying on. Draining stdin still matters, so
  // the writer never blocks on a full pipe.
  await readStdin();

  // Silent: the server already reported any misconfiguration at startup, to
  // someone who was looking. Repeating it here would republish it every prompt.
  const policy = loadPolicy(() => {});

  const selection=resolveBackend();
  const reminder = selection?.profile.backend==='cloud'
    ? 'Before any mutation, initialize this CLOUD store policy with getMemoryPolicy(initialize=true) if it has not been loaded in this session. Follow only that store policy. Proactively recall and manage memory throughout the task as that policy permits; never apply local policy settings to cloud stores. After switching, load the target store policy. If policy is unavailable, suspend mutations without substituting a default. Allowed work needs no repeated confirmation.'
    : buildTurnReminder(selection?.profile.backend==='local'?(selection.profile.policy??(selection.profile.entityId?{scope:'everything',autosave:true,recall:'aggressive'}:policy)):policy);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [reminder, attributionInstructions].filter(Boolean).join('\n\n'),
      },
    }),
  );
}

main().catch(() => {
  // Deliberately silent. There is no failure here worth spending the user's
  // prompt on, and stderr from a hook that exits 0 never reaches the model.
});
