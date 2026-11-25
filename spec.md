# Model metadata synchronization fork

Status: In Progress
Version: 1.0.0
Last updated: 2026-11-24
Mode: Delta
Baseline: research.md

## Objective

Fork the upstream DSH model synchronization plugin as `dsh-model-metadata-sync`. Find available model identities for configured upstreams and supplement missing context limits, maximum output tokens, and explicitly supported reasoning levels with truthful, source-attributed data. Preserve user configuration and avoid implying that unavailable data is known.

## User decisions

- GitHub owner is `kts-kris`; the public fork, npm package, and catalog submission are part of the requested deliverable.
- Existing user-configured and explicitly inherited catalog values win. Fill truly absent information and surface disagreements rather than silently overwriting. User authorized replacing only the DSH system's demonstrable capacity fallback guesses when verified metadata exists; disclose maxTokens request-default effect.
- Nonofficial reference data may fill missing metadata when exact provider, model, and protocol identities make the value applicable; label it as nonofficial and retain source and retrieval time.
- The first implementation prioritizes OpenAI-compatible upstream endpoints. New models may be added to an explicitly configured list; existing models must not be silently removed. When a route inherits an implicit built-in catalog and safe addition cannot be established, show new models without applying them.
- Where a model has no configured maximum output value, writing a verified missing value is permitted, with an explicit warning that this changes DSH's default request output limit.
- Background discovery may run, but every configuration change requires preview and confirmation. If the original plugin can write the same provider, refuse the fork's apply and ask the user to pause the original; do not modify it automatically.
- Nonofficial reference lookup is enabled by default; it must disclose the provider/model/protocol identifiers it may use, never transmit credentials or private upstream addresses, and can be disabled.
- The user approved a core-only fork: retain model discovery, reference metadata, preview, confirmation and safe DSH writeback; remove pricing, Ollama management, active probing, webhooks, auto-updating and unsafe rollback.

## Boundaries

### Always
- Retain upstream MIT copyright and license and visibly identify the fork.
- Keep existing provider and model settings, explicitly configured false values, unrelated fields, model ordering, and unrelated credentials intact.
- Distinguish direct authoritative upstream facts from nonofficial reference data and unknown information.
- Treat model IDs, returned metadata and remote content as untrusted input.

### Ask first
- Using real billable model inference; unattended model configuration writes remain disabled under the user's selected policy.
- Changing user-selected model metadata, deleting existing model entries, or accepting conflicting/ambiguous data.
- Credentials, npm login, OTP and other actions requiring the person's own account interaction.

### Never
- Claim to discover every reasoning level when an upstream does not provide authoritative, protocol-applicable evidence.
- Infer an effort mapping from the model name, model family, generic reasoning boolean or undocumented numeric budget.
- Forward upstream credentials to a reference service or another origin, log them, or expose them to browser code.
- Publish the original project as an unmodified renamed copy or omit its attribution.

## Acceptance criteria

### AC-1: [MUST] [MODIFIED]

Given an OpenAI-compatible upstream returns uniquely identified models, when a user previews discovery, each new or existing ID is visible even if its metadata is unknown. Positive safe integers with a documented total-context meaning are displayed as context values; an input-only limit must not be silently equated with the combined input-plus-output context window. Output limits and each source and source class are shown without writing configuration.

**Proof:** test: `node --test test/metadata-sources.test.js test/sync-integration.test.js`.
### AC-2: [MUST] [ADDED]

Given an OpenAI-compatible upstream explicitly declares a complete list of supported reasoning levels and their wire values for the same endpoint and protocol, normalization and preview preserve every level and its exact wire value. A complete mapping is applicable only if each entry fits DSH's off/minimal/low/medium/high/xhigh/max keys and value rules; otherwise report the entire mapping as unrepresentable without generating or applying a partial mapping. A generic boolean, model name, nullable field, or inherited default alone cannot produce an effort mapping.

**Proof:** test: `node --test test/metadata-sources.test.js`.
### AC-3: [MUST] [ADDED]

Given no upstream value is available, an enabled nonofficial reference may produce a candidate only when a case-sensitive exact provider ID, model ID, and request protocol match exactly one reference record. Candidates show source URL and UTC retrieval time; a missing timestamp, a future timestamp, data older than 24 hours, duplicate matches, aliases, contradictory records, or incomplete effort-to-wire mappings produce no applicable candidate. Reference requests never include upstream credentials or the upstream's private URL.

**Proof:** test: `node --test test/reference-catalog.test.js`.
### AC-4: [MUST] [MODIFIED]

Given an existing model with explicit or catalog-inherited context, output, input, effort mapping, false, null, empty object/array, or unknown fields, when metadata is applied, all these values remain unchanged. Fill a metadata field only when absent from explicit and inherited catalog configuration; for capacity fields only, a demonstrable DSH system fallback guess may be replaced with verified candidate data. A user-configured provider-level default is not a system guess and remains unchanged. Never materialize an incomplete effort map over an inherited map. Preserve model ordering and permit adding only the unique newly discovered IDs approved by the user.

**Proof:** test: `node --test test/reconcile.test.js test/sync-integration.test.js`.
### AC-5: [MUST] [MODIFIED]

Given two sessions modify configuration concurrently, when a revision conflict occurs, the updater re-reads and recomputes, making at most three attempts. If recomputation changes the user-approved model diff, or attempts are exhausted, it fails without writing those changes and requires a new preview; it never sends or alters unrelated credential values.

**Proof:** test: `node --test test/concurrency.test.js`.
### AC-6: [MUST] [MODIFIED]

Given a network error, invalid JSON, empty list, size limit, incomplete pagination, truncation, unknown provider, invalid numeric value, unsupported effort, or ambiguous source, then the affected source reports unknown or failed and cannot drive configuration changes or deletions; other providers can proceed only on separately complete responses.

**Proof:** test: `node --test test/metadata-sources.test.js test/concurrency.test.js test/sync-integration.test.js`.
### AC-7: [MUST] [MODIFIED]

On install and every restart, the plugin never triggers unattended model writes, paid inference or automatic rollback. Background discovery may run but each write requires a fresh preview and explicit confirmation of exactly that diff; no scheduler, updater or history action bypasses confirmation. Real inference requires explicit consent per action with a potential-cost warning.

**Proof:** test: `node --test test/defaults.test.js test/sync-integration.test.js`.
### AC-8: [MUST] [MODIFIED]

For success, error, timeout and redirect responses, send upstream credentials only to the configured upstream origin (scheme, host and port), never to a reference source, cross-origin redirect, HTTP downgrade, client, logs, or diagnostics. Reject unauthenticated, cross-origin and CSRF attempts on state-changing local HTTP routes; render untrusted IDs as text. Bound each request to 15 seconds, a 4 MiB response, 20 pages, and three retries.

**Proof:** test: `node --test test/network-safety.test.js`.
### AC-9: [MUST] [ADDED]

Given the original plugin is installed, when the fork is installed, enabled, used, disabled, or restarted, its package, module, private settings namespace, HTTP routes, private state, updater and UI identifiers never collide with or mutate the original's private state. Both may read shared DSH provider configuration. If the original plugin may concurrently write the same provider, the fork must refuse its apply and ask the user to pause the original; it must not disable the original itself. Revision conflicts among cooperating writers must preserve both users' changes.

**Proof:** test: `node --test test/identity.test.js test/isolated-integration.test.js`.
### AC-10: [MUST] [ADDED]

Given an explicit maximum output value is to be applied, then the preview and documentation disclose that DSH also uses it as a request default.

**Proof:** test: `node --test test/presentation.test.js`.
### AC-11: [MUST] [ADDED]

The distributable contains the upstream license, accurate supported-source limitations, an installable DSH manifest and executable nonzero test suite. Offline tests and packing must pass, and a separate isolated profile must actually install, enable and unload it on DSH 0.2.3-alpha.2 without touching user configuration.

**Proof:** command: `npm test && npm run check && npm pack`; integration: isolated DSH install/load/unload with a recorded outcome.
### AC-12: [SHOULD] [ADDED]

The UI reports each provider's last attempted source, UTC timestamp, success/error and before/after value with unknown labels.
### AC-13: [MUST] [ADDED]

Publish the tested version to a public `kts-kris/dsh-model-metadata-sync` fork and npm `dsh-model-metadata-sync`, verify that the public tarball installs and matches the tested commit, and submit one accurate catalog entry as a real PR; record the public package and PR URLs. CI/maintainer acceptance and actual index inclusion remain independent external outcomes and must not be represented as already completed.

**Proof:** artifact: public repository commit, published npm tarball integrity, isolated install output, PR URL and separate index check.
### AC-14: [MUST] [MODIFIED]

An inherited unsafe or truncated history snapshot must never be replayed as a complete rollback; either protect all model fields with version-checked snapshots or disable that rollback path and visibly explain why.

**Proof:** test: `node --test test/history.test.js`.
### AC-15: [MUST] [ADDED]

After a complete discovery the preview distinguishes new/existing IDs even with missing metadata. For a route with an explicit model list, on manual apply only user-selected unique new IDs are appended in upstream order, preserving all existing models and their order. For an implicitly inherited catalog, show new IDs as not safely applicable and write none until a preservation method is proven. An empty selection adds none; duplicates and unrepresentable data cannot lead to a write.

**Proof:** test: `node --test test/sync-integration.test.js`.

## Handoff

Goal: Deliver a safe, source-attributed DSH model metadata fork and submit it to the configured plugin catalog.
Done when:
- [ ] Offline and isolated-integration tests pass with nonzero executed test counts.
- [ ] A tested package and public fork are published with attribution and installation proof.
- [ ] The catalog PR is submitted, and CI, merge, and index inclusion are reported independently.
Isolation: Use disposable mocks and an isolated profile; never modify the user's live profile or credentials during tests.
Stop if: A model setting, source identity, credential boundary, concurrent update, or publication authorization cannot be established safely.

## Out of scope

- Guaranteed discovery of all capabilities for upstreams that do not expose them.
- Request-time price/billing calculations. Explicitly approved DSH `maxTokens` and `reasoningEfforts` settings may affect subsequent request defaults and reasoning controls.
- Automatic deletion or replacement of existing user models or original-plugin configuration.
- Undocumented login methods or receiving credentials in chat.

## Source scope and external prerequisites

- Initial protocol is OpenAI Chat Completions compatible. At minimum the implementation must support a documented raw `supported_reasoning_levels` array from the configured upstream, where all supported values are DSH level names and map to identical wire strings, plus an explicit complete level-to-wire mapping, each with positive and absent/partial/unsupported negative fixtures. It must not assume every OpenAI-compatible deployment implements these extensions or that `reasoning: true` implies levels.
- A nonofficial reference's retrieval timestamp measures local fetch age, not upstream freshness; absent upstream version metadata must be disclosed, not presented as proof of source currency. Nonofficial reference lookup is enabled by default per user decision and may disclose provider, model, and protocol identity to that source, but never the private endpoint or credential. The UI must disclose that behavior and offer a switch to disable it. Persist provenance separately from DSH model fields where schema requires it.
- Read failure while resolving inherited state means unknown, not absent; do not apply any field whose effective prior value cannot be determined. Explicit null, empty collections and false count as configured. A full upstream model list with duplicate IDs is rejected, not partially applied.
- User-confirmed new-model additions to an explicit list preserve the existing sequence, then append approved unique IDs in upstream order. For inherited catalogs, new IDs remain visible but unsupported for write until safe preservation is proven. Preview identifies capacity disagreements and effective-source uncertainties. Preview confirmation must name the exact diff.
- Preserved upstream behaviors are limited to manual discovery, previews, model selection and optional read-only scheduling. Pricing synchronization, Ollama management, active probes, webhooks, auto-updating and historical rollback are removed or disabled and documented. The old project's update mechanism must never update or remove the original plugin.
- The user completed npm authentication in a user-controlled terminal; `npm whoami` reported `kts2kris` on 2026-11-25. Publishing rights for the chosen package name have not yet been exercised; never request passwords or OTPs in chat.
- Actual acceptance by the catalog after its repository-age gate and human review is external. PR submission, merge, npm publication and inclusion in the user's particular Discover index are separate reported states.
