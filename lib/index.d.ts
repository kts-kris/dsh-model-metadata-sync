import type Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';

export declare const name = 'dsh-model-metadata-sync';
export declare const inject: readonly ['webServer', 'webApp'];

/** Loader configuration; both fields default to true. */
export interface ModelSyncConfig {
  enabled?: boolean;
  referenceEnabled?: boolean;
}

export declare const Config: Schema<ModelSyncConfig>;

/** Recursively unwrap loader values exposing get(), arrays and objects. */
export type PlainConfig<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly unknown[] ? { -readonly [K in keyof T]: PlainConfig<T[K]> } :
  T extends { get(): infer V } ? PlainConfig<V> :
  T extends object ? { [K in keyof T]: PlainConfig<T[K]> } : T;

export declare function plainConfig<T>(value: T): PlainConfig<T>;

export interface ForkReferenceSettings {
  getReferenceEnabled(): boolean;
  setReferenceEnabled(enabled: boolean, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

/** Edits only the current fiber's loader entry; no editor is consulted until a write. */
export declare function createForkReferenceSettings(
  ctx: Context,
  config?: { referenceEnabled?: boolean | { get(): unknown } } | null,
): ForkReferenceSettings;

/** Registers reserved routes; this does not provide a preview/apply authority. */
export declare function apply(ctx: Context, config: ModelSyncConfig): void;
