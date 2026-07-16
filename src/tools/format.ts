// Imported from the /types subpath, not the package root: the package root's
// index.ts re-exports a class also named `Memory` (from ./memory), which
// shadows this interface in the type namespace when imported by name from
// '@openaikits/memory' directly.
import type { Memory } from '@openaikits/memory/types';

export function formatMemory(memory: Memory): string {
  const similarity = memory.similarity !== undefined ? memory.similarity.toFixed(2) : 'n/a';
  const strength = memory.strength !== undefined ? memory.strength.toFixed(2) : 'n/a';
  const links = memory.outgoingEdges.length > 0 ? memory.outgoingEdges.join(', ') : 'none';
  return `- [${memory.id}] ${memory.content} (similarity: ${similarity}, strength: ${strength}, links: [${links}])`;
}

export function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}
