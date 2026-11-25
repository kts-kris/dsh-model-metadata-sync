import type { Context } from '@deepseek-ai/cordis';

/** Exports returned by the browser module-loader factory, not native ESM exports. */
export declare const inject: readonly ['slots', 'locale'];
export declare function apply(ctx: Context): void;

export interface ModelSyncResponse {
  ok: boolean;
  status: number;
  text(): string | PromiseLike<string>;
}

export interface ModelSyncRequestInit {
  method: 'GET' | 'POST';
  credentials: 'same-origin';
  headers?: { 'content-type': 'application/json' };
  body?: string;
}

/** Successful responses are parsed JSON objects, not validated Host results. */
export interface ModelSyncApiClient {
  getStatus(): Promise<Record<string, unknown>>;
  preview(provider: string, selectedNewIds: string[]): Promise<Record<string, unknown>>;
  cancel(previewId: string): Promise<Record<string, unknown>>;
  apply(previewId: string, digest: string): Promise<Record<string, unknown>>;
  setReferenceEnabled(enabled: boolean): Promise<Record<string, unknown>>;
}

export declare function createModelSyncApiClient(options?: {
  fetchImpl?: ((url: string, init: ModelSyncRequestInit) => ModelSyncResponse | PromiseLike<ModelSyncResponse>) | null;
}): ModelSyncApiClient;

export interface PreviewField {
  field: string;
  state: string;
  reason: string;
  before: string;
  candidate: string;
  after: string;
  source: { kind?: string; origin?: string; fetchedAt?: string };
}

export interface PresentedPreview {
  provider: string;
  previewId: string;
  digest: string;
  revision: unknown;
  expiresAt: string;
  selectedNewIds: string[];
  items: { modelId: string; existing: boolean; reason: string; fields: PreviewField[] }[];
  changes: ({ type: 'add-model'; modelId: string } | {
    type: 'set-field'; modelId: string; field: string; scope: string; index?: number; value: string;
  })[];
  warnings: string[];
  sources: { name: string; kind: string; status: string; reason: string; lastAttemptAt: string; origin: string; fetchedAt: string }[];
  canReview: boolean;
}

export declare function presentPreview(preview: unknown): PresentedPreview;

export interface ModelSyncControllerState {
  status: { providers: { id: string; status: string; lastAttemptAt: string }[]; referenceEnabled: boolean } | null;
  provider: string;
  selected: string[];
  preview: PresentedPreview | null;
  stale: boolean;
  expired: boolean;
  confirming: boolean;
  busy: boolean;
  referenceDirty: boolean;
  referenceDraft?: boolean;
  error: string;
  result: string;
}

export interface ModelSyncController {
  snapshot(): ModelSyncControllerState;
  activate(): void;
  dispose(): void;
  loadStatus(): Promise<void>;
  chooseProvider(provider: string): void;
  chooseReference(enabled: boolean): void;
  saveReference(): Promise<void>;
  preview(): Promise<void>;
  selectNew(modelId: string, checked: boolean): void;
  review(): void;
  back(): void;
  confirmApply(): Promise<void>;
  cancelPreview(): Promise<void>;
}

/** Client-side state machine only; it does not implement Host authorization. */
export declare function createController(
  api: ModelSyncApiClient,
  notify?: (state: ModelSyncControllerState) => void,
  clock?: () => number,
): ModelSyncController;

export declare const dictionaries: { en: Record<string, string>; zh: Record<string, string> };
