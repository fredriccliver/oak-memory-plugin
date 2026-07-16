import type { Env } from '../env.js';
import {
  MEMORY_SCOPES,
  RECALL_LEVELS,
  autosaveRule,
  recallRule,
  scopeRule,
  type UnconfiguredReason,
} from '../policy.js';
import { textResult } from './format.js';

/** Says which of the three ways there is no policy, since each has its own fix. */
const REASON_HEADLINES: Record<UnconfiguredReason, string> = {
  unset: 'The user has never chosen one — `MEMORY_POLICY_SCOPE` is not set anywhere.',
  invalid: '`MEMORY_POLICY_SCOPE` is set to a value this server does not recognise — likely a typo.',
  'custom-missing':
    '`MEMORY_POLICY_SCOPE=custom`, but the file holding the rule is missing or empty. Their rule ' +
    'needs rewriting — it has not been replaced with a broader one.',
};

export const getMemoryPolicyDescription = `Report the memory policy this server is actually running.

Reads nothing from the database — it reports the policy the server resolved at startup, which is not
always what the config files say: a scope that is unset, misspelled, or \`custom\` with its rule file
missing leaves the server with no policy at all, storing nothing. Use this rather than reading the
config files when the user asks what is being remembered, or before helping them change it.

**Output**: the effective scope and autosave setting, the exact rules currently given to the model, the
paths to edit, and whether a restart is pending.`;

export function registerGetMemoryPolicy(server: any, env: Env) {
  server.registerTool(
    'getMemoryPolicy',
    {
      title: 'Get memory policy',
      description: getMemoryPolicyDescription,
      inputSchema: {},
    },
    async () => {
      const { policy } = env;
      // Headline the unset case rather than printing `Scope: null` in the same
      // shape as a real one. The reader's next move differs completely — there
      // is nothing to summarize, only something to go and decide — and a policy
      // readout that buries "this isn't yours" in a field is how an unmade
      // decision gets mistaken for a made one.
      const unset = policy.scope === null;
      const lines = [
        unset ? '# No memory policy is set' : '# Effective memory policy',
        '',
        ...(unset
          ? [
              REASON_HEADLINES[policy.reason ?? 'unset'],
              '',
              '**Nothing is being stored, and `createMemory` is refused.** Memories already stored are',
              'still readable and searchable — this affects writing only. No default scope has been',
              'substituted: the user has to choose one.',
            ]
          : [
              `- **Scope**: ${policy.scope}`,
              `- **Autosave**: ${policy.autosave ? 'on — saves proactively' : 'off — saves only when asked'}`,
              `- **Recall**: ${policy.recall}`,
            ]),
        '',
        unset ? '## What the model is told' : '## What is being remembered',
        '',
        scopeRule(policy),
        '',
        '## When it writes',
        '',
        autosaveRule(policy),
        '',
        '## When it searches',
        '',
        recallRule(policy),
        '',
        '## To change it',
        '',
        `Edit these in \`${env.envFile}\`:`,
        `- \`MEMORY_POLICY_SCOPE\` — ${MEMORY_SCOPES.join(', ')}`,
        `- \`MEMORY_POLICY_AUTOSAVE\` — true, false`,
        `- \`MEMORY_POLICY_RECALL\` — ${RECALL_LEVELS.join(', ')}`,
        `- A \`custom\` scope's rule text lives in \`${env.policyFile}\``,
        '',
        // The server loads policy once at startup and hands `instructions` to the
        // client during the initialize handshake. Nothing re-reads either after
        // that, so an edit made now is invisible until the process restarts.
        'Changes take effect in the **next Claude Code session** — this server read its policy at',
        'startup and the client received the instructions during the initial handshake. Neither is',
        're-read mid-session, so tell the user to restart before expecting new behaviour.',
      ];
      return textResult(lines.join('\n'));
    },
  );
}
