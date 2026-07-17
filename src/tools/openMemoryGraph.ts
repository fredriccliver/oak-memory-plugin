import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Env } from '../env.js';
import { listAll } from '../memoryClient.js';
import { ageLabel, textResult } from './format.js';
import { buildGraphHtml, type GraphEdge, type GraphNode } from './graphHtml.js';

export const openMemoryGraphDescription = `Open an interactive visual graph of every stored memory and its links in the browser.

Unlike \`listMemories\` (a text dump for the model to read) or a mermaid diagram published via the Artifact
tool, this renders every memory as a node in a real, draggable, zoomable force-directed graph and opens it as
a local HTML page in the user's default browser — a proper visual view, not one described in chat.

**When to use**: the user wants to *look at* their memory graph rather than have it described — "show me my
memories visually", "open the memory graph as a webpage", "I want to see this in the browser, not the
terminal", or when \`/memory-graph-web\` runs.

**Output**: confirmation that the page was launched, the memory/link counts, and the file path as a fallback
in case the browser did not open automatically (e.g. a headless environment).`;

/**
 * Fire-and-forget: `spawn` reports launch failures asynchronously via an
 * 'error' event, arriving well after this tool has already returned its
 * result. There is no way to await a real answer without stalling the
 * response on browser startup, so this only logs a failure for later
 * debugging — the tool response always carries the file path as a fallback
 * regardless of whether the launch actually worked.
 */
function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`;
  const platform = process.platform;
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];

  try {
    // stdio 'ignore' matters here, not just hygiene: stdout is the MCP
    // stdio JSON-RPC channel, and an inherited stdout would corrupt it if
    // the opener process ever wrote to it.
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', error => {
      console.error(`[oak-memory-plugin] Could not launch a browser for the memory graph: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    console.error(`[oak-memory-plugin] Could not launch a browser for the memory graph: ${(error as Error).message}`);
  }
}

export function registerOpenMemoryGraph(server: any, env: Env) {
  server.registerTool(
    'openMemoryGraph',
    {
      title: 'Open memory graph in browser',
      description: openMemoryGraphDescription,
      inputSchema: {},
    },
    async () => {
      const { memories, edges } = await listAll(env);

      if (memories.length === 0) {
        return textResult('No memories stored yet — nothing to show.');
      }

      // Same reciprocal-pair collapse as listMemories, so the on-page link count
      // and edge styling (mutual vs one-directional) match what the text view reports.
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

      const degreeById = new Map<string, number>();
      for (const pair of uniquePairs.values()) {
        degreeById.set(pair.from, (degreeById.get(pair.from) ?? 0) + 1);
        degreeById.set(pair.to, (degreeById.get(pair.to) ?? 0) + 1);
      }

      const nodes: GraphNode[] = memories.map(memory => ({
        id: memory.id,
        label: memory.content.length > 60 ? `${memory.content.slice(0, 60)}…` : memory.content,
        content: memory.content,
        strength: memory.strength,
        retrievalCount: memory.retrievalCount ?? 0,
        degree: degreeById.get(memory.id) ?? 0,
        isOrphan: !degreeById.has(memory.id),
        createdAgo: ageLabel(memory.createdAt),
      }));

      const graphEdges: GraphEdge[] = [...uniquePairs.values()].map(pair => ({
        source: pair.from,
        target: pair.to,
        mutual: pair.mutual,
        type: pair.type,
      }));

      const html = buildGraphHtml({
        nodes,
        edges: graphEdges,
        entityId: env.memoryEntityId,
        generatedAt: new Date().toLocaleString(),
      });

      // A fixed name rather than a timestamped one: this is a live view meant to
      // be reopened, not an archive, so each call just overwrites the last render
      // instead of littering the temp dir with one file per invocation.
      const filePath = path.join(os.tmpdir(), 'oak-memory-graph.html');
      fs.writeFileSync(filePath, html, 'utf8');
      openInBrowser(filePath);

      const summary = `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}, ${uniquePairs.size} link${uniquePairs.size === 1 ? '' : 's'}.`;

      return textResult(
        `Opened the memory graph in your browser. ${summary}\n` +
          `If nothing appeared (e.g. no display available), open this file manually: ${filePath}`,
      );
    },
  );
}
