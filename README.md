# dsh-model-metadata-sync

[English](README.md) · [中文](README.zh.md) · [Русский](README.ru.md)

A development fork of [GooDAnDReaDY/dsh-model-sync](https://github.com/GooDAnDReaDY/dsh-model-sync), intended to help users review model metadata for configured DeepSeek Harness (DSH) providers. This is not a renamed release of the upstream plugin.

## Status: not ready to use

A limited read-only preview can discover IDs from explicitly configured OpenAI Chat Completions-compatible endpoints. It does not yet apply changes: apply and cancellation authority remain unavailable, reference lookup is not connected, and model metadata without independently verified semantics stays unknown. Legacy synchronization and background discovery are disabled. No package installation, public release, catalog inclusion or end-to-end safety of this development revision is asserted here.

The manifest currently targets Node.js 20 or newer and DSH `>=0.2.3-alpha.2 <0.3.0`; this is a declared range, **not** proof that installation or compatibility has passed. An isolated install/enable/unload test, offline checks, package-content verification and independent safety review are needed before release. Do not install this unfinished revision into a profile you depend on.

## Intended workflow — not yet available

1. Configure an upstream route in DSH. The initial intended protocol is OpenAI Chat Completions compatible; not all compatible endpoints expose metadata with the required semantics.
2. Request a **read-only preview**. The goal is to show discovered new and existing IDs, source and retrieval time, candidate and existing values, conflicts, and unknowns. A configured gateway's declaration is not necessarily an official model-vendor declaration.
3. Review and select changes. Existing explicit and inherited settings take precedence; only a demonstrable DSH system capacity fallback may be replaced with verified data. New IDs may be appended only to an explicit model list after selection. New IDs from an implicitly inherited catalog remain preview-only unless safe preservation is proven.
4. Confirm the exact fresh diff before applying it. **Any settings write requires an explicit user action or confirmation; model changes require a fresh preview and confirmation of that exact diff.** No background run, history action or update may bypass this requirement. If the diff changes, preview again.

When a verified maximum output value is applied as DSH `maxTokens`, it also changes DSH's **default request output limit**. Check this effect before confirming.

## Source, privacy and safety limits

- Intended optional nonofficial reference: the fixed anonymous `https://models.dev/api.json` snapshot. The reference preference can be switched off, but reference lookup itself is not yet connected. When implemented, lookup may disclose the provider, model and protocol identifiers used for matching; **upstream credentials and private upstream URLs must never be sent to the reference source.**
- A reference candidate must match one case-sensitive exact provider ID, model ID and request protocol, with a source URL and UTC retrieval time. Ambiguous, missing, conflicting, stale or unrepresentable evidence stays **unknown** and cannot authorize a write. Future retrieval timestamps remain unknown and cannot authorize a write. A local retrieval timestamp must be no more than **24 hours** old; this measures local fetch age, **not** when the source data was last updated or its accuracy.
- Context means a total input-plus-output window; an input-only limit is not silently treated as total context. Reasoning levels require a complete, protocol-applicable level-to-wire mapping; model names and generic reasoning flags do not prove one. When an existing effective value, identity, source or safe write cannot be proven, preserve it as unknown and refuse the affected write.
- The original plugin and this fork may read or write the same DSH provider. A revision check on this fork alone cannot prevent a later stale write by the original plugin. The intended apply must refuse while the original may write the same provider and ask the user to pause it; it must not disable the original automatically. This protection is not yet an operational apply path.

Pricing synchronization, Ollama management, active capability probing, webhooks and automatic plugin updates are outside this core fork. Legacy rollback is disabled: truncated or field-reduced history snapshots cannot safely restore a complete model list. Do not rely on these inherited features or old documentation.

## License and attribution

This fork retains the upstream [MIT license](LICENSE), including **Copyright © 2026 GooDAnDReaDY**. The license and attribution must accompany redistribution.
