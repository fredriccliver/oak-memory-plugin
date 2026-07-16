import type { Env } from '../env.js';
import { listAll } from '../memoryClient.js';
import { textResult } from './format.js';

export const listMemoriesDescription = `List every stored memory and every link between them — the whole graph.

**This is a full dump, not a search.** It takes no query and does no ranking; use recallMemory when you want
the memories *relevant to something*. Use this one when the user wants to see or audit everything they have
stored, or to inspect how memories are connected.

**When to use**:
- The user asks what you remember about them in general ("what do you know about me?", "show my memories")
- The user wants to see the memory graph, its links, or orphaned/unlinked memories
- Auditing before a cleanup pass

**Output**: every memory with its UUID, content, strength, retrieval count and age, followed by the edge list
and a summary of how connected the graph is. UUIDs are real and can be passed straight to updateMemory /
updateMemoryLink / deleteMemory.`;

/** Node strength decays lazily, so a stored value is only meaningful with its age alongside. */
function ageLabel(date: Date | undefined): string {
  if (!date) return 'unknown';
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export function registerListMemories(server: any, env: Env) {
  server.registerTool(
    'listMemories',
    {
      title: 'List all memories',
      description: listMemoriesDescription,
      inputSchema: {},
    },
    async () => {
      const { memories, edges } = await listAll(env);

      if (memories.length === 0) {
        return textResult('No memories stored yet.');
      }

      // Undirected view: A->B and B->A are one connection to a reader, so collapse
      // reciprocal pairs rather than reporting the same link twice.
      const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
      const uniquePairs = new Map<string, { from: string; to: string; type: string; mutual: boolean }>();
      for (const edge of edges) {
        const key = pairKey(edge.fromId, edge.toId);
        const existing = uniquePairs.get(key);
        if (existing) {
          existing.mutual = true;
        } else {
          uniquePairs.set(key, { from: edge.fromId, to: edge.toId, type: edge.type, mutual: false });
        }
      }

      const connected = new Set<string>();
      for (const edge of edges) {
        connected.add(edge.fromId);
        connected.add(edge.toId);
      }

      const shortId = (id: string) => id.slice(0, 8);
      const byId = new Map(memories.map(m => [m.id, m]));

      const nodeLines = memories.map(memory => {
        const strength = memory.strength !== undefined ? memory.strength.toFixed(2) : 'n/a';
        const degree = edges.filter(e => e.fromId === memory.id || e.toId === memory.id).length;
        return (
          `- [${memory.id}] ${memory.content}\n` +
          `    strength: ${strength} | retrieved: ${memory.retrievalCount ?? 0}x | ` +
          `created: ${ageLabel(memory.createdAt)} | links: ${degree}`
        );
      });

      const edgeLines = [...uniquePairs.values()].map(pair => {
        const fromText = byId.get(pair.from)?.content.slice(0, 40) ?? '(unknown)';
        const toText = byId.get(pair.to)?.content.slice(0, 40) ?? '(unknown)';
        const arrow = pair.mutual ? '<->' : '-->';
        return `- ${shortId(pair.from)} ${arrow} ${shortId(pair.to)} (${pair.type})  "${fromText}" ${arrow} "${toText}"`;
      });

      const orphans = memories.filter(m => !connected.has(m.id));

      const sections = [
        `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}, ${uniquePairs.size} link${uniquePairs.size === 1 ? '' : 's'}:`,
        '',
        nodeLines.join('\n'),
        '',
        uniquePairs.size > 0 ? `Links:\n${edgeLines.join('\n')}` : 'Links: none — every memory is currently isolated.',
        '',
        `Unlinked memories: ${orphans.length === 0 ? 'none' : `${orphans.length} (${orphans.map(o => shortId(o.id)).join(', ')})`}`,
      ];

      return textResult(sections.join('\n'));
    },
  );
}
