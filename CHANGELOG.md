# Changelog

## 0.1.4 cloud preparation

- Align shared organisation skill and OpenAI review cases with the hosted atomic mergeMemories contract.
- Require exact source snapshots and explicit deletion scope; document revision, edge collision and sequential fallback boundaries.
- Existing OpenAI portal review is unchanged; prepared package updates require separate installation/publication.

## 0.2.1 local plugin / 0.1.3 cloud preparation

- Add shared OAuth remote package for OpenAI and Claude; preserve the local plugin.
- Use a distinct `oak-memory-cloud` MCP server key in both remote manifests and validate disjointness with the local server.
- Patch MCP SDK to 1.32.1 and rebuild both local bundles to resolve dependency security findings.
- Regression checks: typecheck, local environment fallback, real SDK Streamable HTTP client/server fixtures covering profile selection, store isolation, denied writes, revocation and overlapping switches.
- Hosted OAuth and Desktop tool calls require separate live validation; packaging and fixture success do not establish host readiness.
