# Desktop Cloud 0.1.0 (2026-10-11)

- Add an installable MCPB for local stdio access to OAK cloud stores, with secure personal-key settings and explicit write opt-in.
- Hide mutation tools for reader stores and keep unexpected optional settings read-only.
- Verify admin store roles, package roundtrips, revocation and graph mismatch. Include Desktop tests in npm test.
- The fixed read allowlist intentionally denies unknown tools. Compare it with hosted tool contracts before publishing a Desktop update; new reads require a new reviewed bundle. Host hints alone do not grant permission.

# Changelog

## 0.3.0 local plugin

- Add atomic `mergeMemories` with the cloud input contract, exact original checks, typed link remapping and local pre-merge history.
- Keep survivor retrieval/creation metadata; archive absorbed records and incident relationships.
- Include merge in client policy guards and local curation guidance; preserve the shared OAuth cloud workflow and SDK 1.32.1 security update.
- Verify actual stdio/PostgreSQL success, rollback, concurrent content/link writes, input limits, store isolation and synchronized Claude/Codex bundles.

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
