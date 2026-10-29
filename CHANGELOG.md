# Desktop Cloud 0.2.0 preparation (2026-10-29)

- Accept a sensitive Stores JSON list alongside the existing single-store pair, with duplicate and malformed configuration rejected before startup.
- Search configured stores together or route to an explicit store ID, preserving per-store MCP content and source attribution; disclose partial failures.
- Require an explicit target for mutations in multi-store mode, use each store’s own key, and recheck identity and writable roles before forwarding changes.
- Preserve the existing single-store bridge, read-only default, disabled autosave, and no-local-fallback behavior.
- Verify the packaged extension with four-store tests plus existing regression tests and official MCPB manifest validation. Actual Claude installation and authenticated production calls remain separate verification steps; this entry describes a prepared package.

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

## 0.1.5 cloud preparation

- Search explicitly consented, enabled stores together with source attribution and partial-failure disclosure.
- Require an explicit target per call for non-search workflows, even with only one enabled store. Save deduplication and UUID links stay in that target.
- Align OpenAI skill metadata, onboarding and Claude descriptions; guide connection/store activation in OAK web settings.
- Existing single-store calls remain compatible. New consent, tool refresh, fresh demo, host acceptance and portal publication are separate checks; this entry describes a prepared package.

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
