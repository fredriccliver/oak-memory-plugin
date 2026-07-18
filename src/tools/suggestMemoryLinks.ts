import { z } from 'zod';
import type { Env } from '../env.js';
import { listAll } from '../memoryClient.js';
import { textResult } from './format.js';

export const suggestMemoryLinksInputSchema = {
  minSimilarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Floor for reporting an unlinked pair as a link candidate (cosine, default 0.55).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max link candidates to list, strongest first (default 25).'),
};

export const suggestMemoryLinksDescription = `Read-only structural analysis of the memory graph — the evidence layer for a curation/organise pass.

**This computes nothing to the database; it only reports.** It reads every stored memory's embedding and
compares all pairs by cosine similarity, then surfaces where the graph is under- or mis-connected. Pair it
with listMemories (which gives full content) and then act with updateMemoryLink / adjustMemoryLinkStrength /
createMemory / updateMemory / deleteMemory. The judgment — which pairs to link, which near-duplicates to
merge, which overloaded nodes to split — is yours; this tool only hands you the signals to reason over.

**What it reports**:
- ORPHANS — memories with no links, each with its single nearest neighbour (where it likely belongs).
- LINK CANDIDATES — unlinked pairs above the similarity floor, strongest first; very high ones are flagged as
  possible near-duplicates (merge, or split-and-dedupe).
- EXISTING LINKS — each current edge's stored strength alongside the pair's actual similarity, so you can
  spot links that are weaker or stronger than the content warrants, or spurious (linked but dissimilar).
- LARGE NODES — long, multi-topic memories that may be worth splitting into focused nodes.

**When to use**: at the start of a /memory-organise pass, or whenever the user wants the graph tidied,
de-duplicated, or better connected.`;

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Flag thresholds — tuned for bge-m3, whose related-pair cosines cluster high.
const NEAR_DUPLICATE = 0.88; // link candidate this close ≈ same fact twice
const SPURIOUS_LINK = 0.35; // linked yet this dissimilar ≈ probably wrong
const LARGE_NODE_CHARS = 600; // long enough to likely span multiple facts

export function registerSuggestMemoryLinks(server: any, env: Env) {
  server.registerTool(
    'suggestMemoryLinks',
    {
      title: 'Suggest memory links',
      description: suggestMemoryLinksDescription,
      inputSchema: suggestMemoryLinksInputSchema,
    },
    async ({ minSimilarity, limit }: { minSimilarity?: number; limit?: number }) => {
      const floor = minSimilarity ?? 0.55;
      const cap = limit ?? 25;
      const { memories, edges } = await listAll(env);

      if (memories.length === 0) {
        return textResult('No memories stored yet — nothing to analyse.');
      }

      const short = (id: string) => id.slice(0, 8);
      const snippet = (text: string, n = 44) =>
        text.length > n ? `${text.slice(0, n)}…` : text;
      const byId = new Map(memories.map(m => [m.id, m]));

      // Collapse reciprocal edges into one undirected pair, keeping the max strength seen.
      const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
      const linkedPairs = new Map<string, { a: string; b: string; strength: number }>();
      for (const e of edges) {
        const key = pairKey(e.fromId, e.toId);
        const existing = linkedPairs.get(key);
        const strength = typeof e.strength === 'number' ? e.strength : 0.5;
        if (existing) existing.strength = Math.max(existing.strength, strength);
        else linkedPairs.set(key, { a: e.fromId, b: e.toId, strength });
      }

      const withEmbedding = memories.filter(
        m => Array.isArray(m.embedding) && m.embedding.length > 0,
      );
      const missingEmbedding = memories.length - withEmbedding.length;

      // All-pairs similarity over embedded memories.
      const sim = new Map<string, number>();
      for (let i = 0; i < withEmbedding.length; i++) {
        for (let j = i + 1; j < withEmbedding.length; j++) {
          const a = withEmbedding[i];
          const b = withEmbedding[j];
          sim.set(pairKey(a.id, b.id), cosine(a.embedding!, b.embedding!));
        }
      }

      const degree = new Map<string, number>();
      for (const m of memories) degree.set(m.id, 0);
      for (const { a, b } of linkedPairs.values()) {
        degree.set(a, (degree.get(a) ?? 0) + 1);
        degree.set(b, (degree.get(b) ?? 0) + 1);
      }

      // ORPHANS with their nearest neighbour.
      const orphanLines = memories
        .filter(m => (degree.get(m.id) ?? 0) === 0)
        .map(m => {
          let bestId: string | undefined;
          let bestSim = -1;
          for (const other of withEmbedding) {
            if (other.id === m.id) continue;
            const s = sim.get(pairKey(m.id, other.id)) ?? -1;
            if (s > bestSim) {
              bestSim = s;
              bestId = other.id;
            }
          }
          const near =
            bestId !== undefined
              ? `nearest [${short(bestId)}] ${bestSim.toFixed(2)} "${snippet(byId.get(bestId)!.content, 32)}"`
              : 'no embedded neighbour';
          return `- [${m.id}] "${snippet(m.content)}"\n    ${near}`;
        });

      // LINK CANDIDATES — unlinked, above floor, strongest first.
      const candidates: { key: string; a: string; b: string; s: number }[] = [];
      for (const [key, s] of sim) {
        if (s < floor) continue;
        if (linkedPairs.has(key)) continue;
        const [a, b] = key.split('|');
        candidates.push({ key, a, b, s });
      }
      candidates.sort((x, y) => y.s - x.s);
      const candidateLines = candidates.slice(0, cap).map(c => {
        const flag = c.s >= NEAR_DUPLICATE ? '  ← near-duplicate: MERGE or split-dedupe' : '';
        return (
          `- ${c.s.toFixed(2)}  [${short(c.a)}] "${snippet(byId.get(c.a)!.content, 30)}"` +
          `  ~  [${short(c.b)}] "${snippet(byId.get(c.b)!.content, 30)}"${flag}`
        );
      });

      // EXISTING LINKS — strength vs actual similarity.
      const existingLines = [...linkedPairs.values()]
        .map(p => ({ ...p, s: sim.get(pairKey(p.a, p.b)) ?? NaN }))
        .sort((x, y) => (Number.isNaN(x.s) ? 1 : x.s) - (Number.isNaN(y.s) ? 1 : y.s))
        .map(p => {
          const simText = Number.isNaN(p.s) ? ' n/a' : p.s.toFixed(2);
          const flag = !Number.isNaN(p.s) && p.s < SPURIOUS_LINK ? '  ← low similarity, review' : '';
          return (
            `- str ${p.strength.toFixed(2)}  sim ${simText}  ` +
            `[${short(p.a)}] "${snippet(byId.get(p.a)!.content, 26)}" <-> ` +
            `[${short(p.b)}] "${snippet(byId.get(p.b)!.content, 26)}"${flag}`
          );
        });

      // LARGE NODES — split candidates.
      const largeLines = memories
        .filter(m => m.content.length > LARGE_NODE_CHARS)
        .sort((a, b) => b.content.length - a.content.length)
        .map(
          m =>
            `- ${m.content.length} chars, ${degree.get(m.id) ?? 0} link(s)  ` +
            `[${short(m.id)}] "${snippet(m.content, 50)}"`,
        );

      const section = (title: string, lines: string[], empty: string) =>
        lines.length > 0 ? `${title} (${lines.length}):\n${lines.join('\n')}` : `${title}: ${empty}`;

      const header =
        `${memories.length} memories, ${linkedPairs.size} link${linkedPairs.size === 1 ? '' : 's'}. ` +
        `Similarity floor ${floor.toFixed(2)}.` +
        (missingEmbedding > 0 ? ` (${missingEmbedding} without embeddings, excluded from similarity.)` : '');

      const sections = [
        header,
        '',
        section('ORPHANS', orphanLines, 'none — every memory is linked.'),
        '',
        section('LINK CANDIDATES', candidateLines, `none above ${floor.toFixed(2)}.`),
        '',
        section('EXISTING LINKS', existingLines, 'none.'),
        '',
        section('LARGE NODES', largeLines, 'none.'),
        '',
        'Nothing was modified. Decide the edits and apply them with updateMemoryLink / ' +
          'adjustMemoryLinkStrength / createMemory / updateMemory / deleteMemory.',
      ];

      return textResult(sections.join('\n'));
    },
  );
}
