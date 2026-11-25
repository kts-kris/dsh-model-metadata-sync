# Metadata synchronization contract

Status: Frozen after Gate 2

## Inputs and identity

- `provider` and `modelId`: exact case-sensitive strings from the user-configured route and its upstream response. Duplicate model IDs, ambiguous provider identity, invalid IDs or unsupported protocols reject that scope.
- `protocol`: initial support is OpenAI Chat Completions compatible. An upstream's additional fields are accepted only when their semantics and level-to-wire mapping are explicitly documented for that source/protocol; otherwise they are unknown.
- `source`: `{ kind: 'upstream' | 'reference', origin, fetchedAt, version? }`; `kind: upstream` describes the configured gateway's own declaration, not necessarily the underlying model vendor's official declaration. Nonofficial references never receive gateway endpoint or credential.
- Values must be positive safe integers for total context window and output tokens. An input-only limit is not assumed to be total context. Output limit becomes DSH `maxTokens` only in the previewed and user-approved diff.
- `reasoningEfforts`: a complete enumeration of supported levels, expressible as a nonempty subset of DSH keys `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, each with its exact upstream wire string. Only `off` may have null, meaning the wire value is omitted; absent levels are unsupported, not guessed. A map containing only `off`, unsupported values, duplicate/ambiguous keys, generic reasoning flag, or inferred family defaults is not applicable.

## Evidence priority and expiration

Explicit existing configuration, explicit provider-level defaults, and known inherited catalog declarations take precedence. Demonstrable built-in capacity fallback guesses are not treated as explicit values and may be replaced with verified data following preview; unreadable inheritance is unknown. Then exact configured-upstream declarations, then approved enabled reference entries matching provider/model/protocol exactly. A reference snapshot must have a UTC fetch time no more than 24 hours old; this represents fetch age, not upstream data currency. No fuzzy IDs, aliases, family guesses, cross-provider fallback, or unproven protocol conversion are permitted. Unknown, absent, invalid, stale, conflicting, or unreadable inputs do not imply false or zero.

## Preview

A preview has a provider, settings revision, model identities, source records, new/existing model distinction, before/effective value, candidate value, applicable/unknown/conflict reason, approved new-model selection and a stable digest of the exact diff. An empty/error/truncated/partial-paginated or duplicate-ID response is non-applicable. No preview mutates user model configuration.

## Apply

Only the exact preview digest and user-selected additions may be applied. Preserve every existing model object and order, including null, false, empty, `reasoningEfforts`, inherited values and unknown fields. Apply only fields known absent from explicit and inherited catalog configuration, or verified capacity values replacing the DSH system's demonstrable fallback guesses; explicit provider defaults and unreadable inherited state are protected. For a nonempty explicit models list without `modelOverrides`, mutate the provider's exact models path and append unique selected IDs. For an implicit built-in catalog, do not replace its inherited list: mutate an exact existing model override only if its absence and inheritance can be proven; preview new additions as unsupported until a safe preservation method is proven. DSH rejects a nonempty models list beside `modelOverrides`. Use the DSH settings path API with expected revision. At most three conflict attempts; re-read and recompute on each conflict and abort if the recomputed digest differs. No secrets are copied through the settings mutation. Return success, changed diff, unchanged, invalid preview, conflict/re-preview or refusal.

## Security boundary

- Max 15-second request, 4 MiB body, 20 pages and three retries; abort and retain prior state on any incomplete result.
- Credentials remain in DSH Host; no redirect to a different `(scheme, host, port)` may receive credentials; reference fetching must never receive the private upstream URL or credentials.
- Unauthenticated or cross-origin state-changing HTTP calls are refused by the DSH host's required-auth access controls plus a post-admission CSRF defense binding the browser Origin's scheme, host and port to the proven public origin. Host authority checking alone does not compare scheme; where the external origin behind a proxy cannot be established, fail closed. Test same-authority cross-scheme and missing Fetch-Metadata. Malicious IDs are data, never executable markup or filesystem paths.
- No implicit paid inference. Manual capability testing requires an explicit action and billing warning.

## Scheduling and history

Background discovery may collect/report changes but cannot apply without a fresh user confirmation. Legacy rollback cannot overwrite a full model list from truncated or field-reduced snapshots; disable it until complete optimistic-concurrency-safe restoration exists. A plugin's private routes/state/namespace/updater must never address the original plugin's private data.

## Host API and lifecycle

All application routes are registered through the DSH Host's required-auth route boundary. Cross-origin requests are refused. JSON request/response fields are explicitly projected; never return provider descriptors, arbitrary model objects, `headers`, credentials or raw upstream responses to the client.

| Method and path | Request | Response | Effects |
|---|---|---|---|
| `POST /dsh-model-metadata-sync/preview` | `{provider: string, selectedNewIds: string[]}` | `{previewId, expiresAt, revision, digest, provider, items, warnings}` | Perform bounded discovery and safe projection; store a five-minute, one-use server-side preview. No user-settings writes. |
| `POST /dsh-model-metadata-sync/apply` | `{previewId: string, digest: string}` | `{status: 'applied'|'unchanged', provider, revision, changes}` | One provider per transaction; require an authenticated owner and the exact unexpired preview, unchanged identity, source, selection and diff. Atomic one-winner token consumption; recompute on at most three namespace revision conflicts and require re-preview on any diff change. |
| `POST /dsh-model-metadata-sync/preview/cancel` | `{previewId: string}` | `{status: 'cancelled'|'not-found'}` | Cancel the owned pending preview without writing provider settings. |
| `GET /dsh-model-metadata-sync/status` | no body | `{providers: [{id, status, lastAttemptAt}], referenceEnabled}` | Return only explicitly safe projected status. |
| `POST /dsh-model-metadata-sync/reference-settings` | `{enabled: boolean}` | `{referenceEnabled: boolean}` | Save only this fork's reference-lookup preference through the DSH configuration editor; do not mutate any provider/model, other plugin or credential. Disabling immediately prevents future reference requests. Requires the same Host authentication and CSRF checks. |

The preview service retains private endpoint and protocol identity internally; digest input contains only a safe endpoint fingerprint and whitelisted diff, never full descriptors, headers or credentials. Host authentication/admission occurs before plugin handlers and can return DSH-owned HTTP 401/403/503 with plain-text `unauthorized`, `forbidden`, or `authentication unavailable`; do not replace it with anonymous access. After admission, business errors return `{error:{code,message}}` with safe static/sanitized text. Business HTTP mapping: `ORIGIN_REFUSED` 403, `UNKNOWN_SOURCE` 404, `UNSUPPORTED_PROTOCOL`/`INVALID_RESPONSE`/`UNSUPPORTED_EFFORT` 422, `INCOMPLETE_RESPONSE` 502, `REFERENCE_STALE`/`AMBIGUOUS_IDENTITY`/`REVISION_CONFLICT`/`REPREVIEW_REQUIRED`/`ORIGINAL_WRITER_ACTIVE` 409, `SETTINGS_UNAVAILABLE` 503, `WRITE_REJECTED` 409; cancellation and expiry report 409 `REPREVIEW_REQUIRED`. Network failure leaves an actionable status, not a fabricated empty catalog.

## Legacy and independent actions

- `/run` with non-dry-run, `/selection`, direct `modelSyncRunner` writes, scheduler auto-apply, import-based writeback, `/history/rollback`, and updater self-install are disabled until migrated to the preview authority; each returns a visible unsupported/refused result, never silently succeeds.
- `/try`, `/batch-try` and `/probe-*` are disabled initially rather than performing inference without per-action cost authorization. The UI must not offer an operative action for a disabled route.
- Pricing synchronization, Ollama management, active probes, webhooks, automatic updating, and historical rollback are removed or disabled per the user's explicit approval; no legacy route may perform those effects. Background catalog discovery is read-only and must not consume a preview token or commit settings.
- When the original plugin may write the same provider, `/apply` returns 409 `ORIGINAL_WRITER_ACTIVE` and instructs the user to pause it; the fork never toggles the original automatically. There is no claim that unilateral CAS can prevent a later stale write by the original.

## Error categories

`UNKNOWN_SOURCE`, `UNSUPPORTED_PROTOCOL`, `INVALID_RESPONSE`, `INCOMPLETE_RESPONSE`, `REFERENCE_STALE`, `AMBIGUOUS_IDENTITY`, `UNSUPPORTED_EFFORT`, `AUTH_REQUIRED`, `ORIGIN_REFUSED`, `SETTINGS_UNAVAILABLE`, `REVISION_CONFLICT`, `REPREVIEW_REQUIRED`, `ORIGINAL_WRITER_ACTIVE`, `WRITE_REJECTED`. Errors never contain credentials or unredacted upstream response bodies.
