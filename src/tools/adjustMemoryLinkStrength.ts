import { z } from 'zod';
import type { Env } from '../env.js';
import { getMemoryClient } from '../memoryClient.js';
import { textResult } from './format.js';

export const adjustMemoryLinkStrengthInputSchema = {
  fromMemoryId: z.string().describe('One end of the link (UUID).'),
  toMemoryId: z.string().describe('The other end of the link (UUID).'),
  strength: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Target connection strength 0–1. Higher = more tightly coupled (recall pulls them together harder). ' +
        'Rough guide: ~0.85 near-synonymous/tightly-coupled, ~0.7 clearly related (the default for new ' +
        'links), ~0.4 loosely associative.',
    ),
  type: z
    .string()
    .optional()
    .describe("Edge type to adjust (default 'related')."),
};

export const adjustMemoryLinkStrengthDescription = `Set the strength of an existing link between two memories.

**Purpose**: edge strength is how hard recall pulls two memories together — a tuning knob updateMemoryLink
doesn't expose (it only adds/removes at a fixed default). Use this in a curation pass to make tightly-coupled
memories co-surface reliably and loosen links that are merely tangential, so graph traversal reflects how
related things actually are.

**When to use**:
- A link exists but its strength doesn't match how related the two memories are (see suggestMemoryLinks,
  which prints each edge's stored strength next to the pair's actual similarity).
- You just added a link with updateMemoryLink and want it stronger or weaker than the 0.7 default.

**Notes**:
- The link must already exist — add it first with updateMemoryLink. This only re-weights.
- Adjusts every stored edge between the two memories (both directions) to the target.
- Sets an absolute target, not a delta.`;

export function registerAdjustMemoryLinkStrength(server: any, env: Env) {
  server.registerTool(
    'adjustMemoryLinkStrength',
    {
      title: 'Adjust memory link strength',
      description: adjustMemoryLinkStrengthDescription,
      inputSchema: adjustMemoryLinkStrengthInputSchema,
    },
    async ({
      fromMemoryId,
      toMemoryId,
      strength,
      type,
    }: {
      fromMemoryId: string;
      toMemoryId: string;
      strength: number;
      type?: string;
    }) => {
      if (fromMemoryId === toMemoryId) {
        return textResult('Cannot adjust a link from a memory to itself.', true);
      }
      const edgeType = type ?? 'related';
      const { storage } = await getMemoryClient(env);

      const edges = await storage.getEdgesByEntity(env.memoryEntityId);
      const matches = edges.filter(
        e =>
          e.type === edgeType &&
          ((e.fromId === fromMemoryId && e.toId === toMemoryId) ||
            (e.fromId === toMemoryId && e.toId === fromMemoryId)),
      );

      if (matches.length === 0) {
        return textResult(
          `No '${edgeType}' link exists between ${fromMemoryId.slice(0, 8)} and ${toMemoryId.slice(0, 8)}. ` +
            `Add it first with updateMemoryLink (action: "add"), then re-weight.`,
          true,
        );
      }

      // bumpEdgeStrengths applies a delta; to reach an absolute target we bump by
      // (target − current) per edge. LEAST(1.0, …) clamps the top; target is
      // already validated into 0–1 so the floor can't be crossed either.
      const before: number[] = [];
      for (const edge of matches) {
        const current = typeof edge.strength === 'number' ? edge.strength : 0.5;
        before.push(current);
        const delta = strength - current;
        if (delta !== 0) {
          await storage.bumpEdgeStrengths([edge.id], delta);
        }
      }

      const changed = before.map(b => b.toFixed(2)).join(', ');
      return textResult(
        `Set link strength to ${strength.toFixed(2)} for ${matches.length} edge(s) between ` +
          `${fromMemoryId.slice(0, 8)} and ${toMemoryId.slice(0, 8)} (was: ${changed}).`,
      );
    },
  );
}
