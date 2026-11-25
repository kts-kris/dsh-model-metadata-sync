# Data model: metadata synchronization

## Provider route
- `providerId`: exact case-sensitive DSH provider identifier.
- `protocol`: OpenAI Chat Completions for the first supported path.
- `endpointOrigin`: exact configured scheme, host and port; credentials never leave this origin.
- `configuredModels`: original ordered, unmodified DSH model objects.
- `revision`: DSH settings namespace-wide revision associated with the exact captured descriptor; it is not provider-specific.
- `catalogMode`: `explicit` for a nonempty models array, `inherited` for absent/empty models, or `unknown`; `modelOverrides` is separately recorded. Never assume an inherited list is explicit or compatible with simultaneous overrides.

## Evidence and candidate
- `modelId`: case-sensitive string uniquely returned by the configured provider.
- `field`: `contextWindow`, `maxTokens`, or `reasoningEfforts`.
- `value`: positive safe integer for capacity or an exact DSH-supported effort-to-wire mapping.
- `sourceKind`: `upstream` (the user's configured gateway declaration) or `reference` (nonofficial data).
- `sourceId`: sanitized source name and public source URL where appropriate; no private URLs are sent to a third party.
- `retrievedAt`: UTC time of local retrieval. `sourceVersion` is optional and separately disclosed; retrieval age does not establish source age.
- `state`: `known`, `unknown`, `conflicting`, `ambiguous`, `stale`, `unrepresentable`, or `failed`.

## Preview
- `previewId`: generated opaque identifier scoped to the running plugin instance, single-use and expiring after five minutes. It is invalidated on plugin unload, cancellation, changed source/identity or successful apply; concurrent consumption has one winner.
- `revision`, `providerId`, `orderedSelection`: exact namespace revision, target route and chosen new IDs. Bind to a secret-safe endpoint origin fingerprint, protocol, provenance and exact diff; do not hash raw credentials, headers, or the full descriptor.
- `items`: identity, original/effective values, candidate values, sources and reasons; unavailable effective state is not absent.
- `diff`: the exact proposed ordered changes, including the effect of `maxTokens` on request defaults.
- `digest`: deterministic digest of the normalized exact diff and ordered selection; a changed recomputation requires another preview.

## Apply result
- `state`: `applied`, `unchanged`, `invalid-preview`, `conflict`, `repreview-required`, `unknown-state`, `original-writer-active`, `not-authorized`, or `write-rejected`.
- `providerId`, applicable revision and sanitized diagnostic; no credential values, raw upstream bodies, unprojected model fields, or opaque auth headers. Each provider commits independently; partial results explicitly name succeeded and failed providers.

## Private persisted state
- Fork-owned settings, source selections, safe preview/history metadata, and per-source cache; none address the original plugin's private namespace.
- Do not use upstream truncated history snapshots for full-state rollback; rollback remains disabled until complete revision-checked snapshots are implemented.
