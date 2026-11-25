# Project Constitution

Version: 1.0.0
Status: Approved
Last updated: 2026-11-24

## Architecture and compatibility
- Preserve the MIT upstream license and retain attribution to GooDAnDReaDY; disclose the fork and its changes.
- Build an independently identified DSH bundle, compatible with the installed DSH 0.2.3-alpha.2 API, with a separate package name, loader row, client identity, HTTP routes, storage, and updater target.
- Keep working original capabilities unless they conflict with explicitly approved safety constraints. Explicitly document any removed, disabled, or changed behavior.
- Keep plugin files, documentation, and tests inside this project. Never edit a user's profile file, secrets, or other installed plugins directly.

## Stack
- Host: Node.js ESM; preserve the existing plain JavaScript implementation and explicitly declare the supported runtime range.
- Client: existing DSH browser module and public Cordis slot APIs.
- Tests: Node.js built-in test runner and local mock providers; an isolated DSH integration profile where feasible.

## Security and reliability
1. Resolve existing credentials through DSH services per operation; never expose credential values in the client, logs, diagnostics, reference requests, or committed files.
2. Use the provider identity and endpoint explicitly configured or approved by the user; never silently redirect a credential to a different origin. Disallow forwarding credentials across origins; bound time, response bytes, pagination, and retries.
3. Treat upstream and reference response bodies as untrusted data; validate IDs, integer ranges, supported modalities, and exact effort-to-wire mappings; reject malformed, oversized, conflicting, or unsupported values.
4. Persist changes using supported DSH settings APIs and revision checks. On concurrent conflict, re-read and recompute; fail closed rather than replacing a newer user edit.
5. Preserve explicitly configured user values and unrelated model fields. Default to preview and do not silently delete models, replace unknown state, or use stale/incomplete discovery results as evidence of absence.
6. Show source, source class, freshness, and uncertainty separately for official endpoint facts and nonofficial reference data. Never claim a guessed or inferred fact is official or complete.
7. Default to no paid model probes. Any real inference, including capability checks, must be an explicit user action and clearly disclose potential cost.
8. Authorize local HTTP controls through the current DSH host's supported access boundary and prevent cross-origin actions; never assume loopback alone authenticates a caller.

## Naming and file rules
- Package/row identifiers and API/storage namespaces must be stable and unique to this fork.
- Existing source uses camelCase identifiers and kebab-case file names; tests use descriptive names.
- Do not rewrite inherited scripts without reading them; preserve upstream license and provenance.

## Known constraints
- Official upstream model listings may not expose complete context, output, or reasoning-level information; unknown must remain unknown.
- An explicit DSH model `maxTokens` changes its default request output cap and must be disclosed as behavioral configuration, not merely informational metadata.
- Publication requires a suitable public repository, repository age of at least one day for the chosen catalog, and npm authentication for the user's configured Discover index. External maintainers control catalog acceptance.
