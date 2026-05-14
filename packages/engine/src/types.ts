export type ExportTarget = 'pdf' | 'svg' | 'png' | 'html' | 'none';

export interface WasmFactory {
  wasmUrl: string;
  worker(): Worker;
}

export interface HandlerOptions {
  /** Initial shared-memory pages (64 KB each). Default: 512 (32 MB). */
  initMemory?: number;
  /** Maximum shared-memory pages (64 KB each). Default: 16384 (1 GB) - matches the WASM `--max-memory` link flag. */
  maxMemory?: number;
  /** Reject outstanding promises when the handler is destroyed. Default: true. */
  rejectOnDestruction?: boolean;
  /** rayon thread-pool size. Default: `min(hardwareConcurrency, 16)`. Floored, clamped to `[1, 16]`. */
  numThreads?: number;
}

export type AskName = 'package' | 'font';

export interface AskArgs {
  package: { namespace: string; name: string; version: string };
  font: { key: string };
}

export type AskHandler = <K extends AskName>(name: K, args: AskArgs[K]) => Promise<Uint8Array>;

export type FontStyle = 'normal' | 'italic' | 'oblique';

export interface FontStub {
  /** Family name as it should appear in autocomplete and `#text(font: ...)`. */
  family: string;
  /** Opaque identifier passed back to the host's `font` ask handler. */
  key: string;
  style?: FontStyle;
  /** OpenType weight, 100..=900 (400 = regular, 700 = bold). */
  weight?: number;
  /** OpenType-style stretch number 1..=9 (5 = normal). */
  stretch?: number;
}

export type NotifyName = 'status' | 'diagnostics' | 'outline' | 'pages';

export interface StatusNotification {
  status: 'ok' | 'busy' | 'error' | 'crashed';
  message?: string;
}

export interface Range {
  start: number;
  end: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  range?: Range;
  path?: string;
  package?: string;
  id?: string;
  hints?: string[];
}

export interface DiagnosticsNotification {
  diagnostics: Diagnostic[];
}

export interface OutlineEntry {
  level: number;
  title: string;
  position: unknown;
  children?: OutlineEntry[];
}

export interface OutlineNotification {
  entries: OutlineEntry[];
}

export interface PageInfo {
  width: number;
  height: number;
}

export interface PagesNotification {
  pages: PageInfo[];
}

export interface NotifyPayloads {
  status: StatusNotification;
  diagnostics: DiagnosticsNotification;
  outline: OutlineNotification;
  pages: PagesNotification;
}

export type NotifyHandler = <K extends NotifyName>(name: K, payload: NotifyPayloads[K]) => void;

export type CompletionKind =
  | 'symbol' | 'constant' | 'type' | 'func' | 'param'
  | 'syntax' | 'label' | 'font' | 'package' | 'path';

export interface Completion {
  label: string;
  detail?: string;
  apply?: string;
  kind: CompletionKind;
  boost?: number;
}

export interface AutocompleteResult {
  from: number;
  completions: Completion[];
}

export interface TooltipResult {
  html: string;
}

export type DefinitionResult = { kind: 'source'; path: string; pos: number };

export type JumpResult =
  | { kind: 'position'; page: number; x: number; y: number }
  | { kind: 'source'; path: string; pos: number }
  | { kind: 'url'; url: string };

export interface HighlightResult {
  /** Flat [start, end, tagIndex, ...] triples aligned with `tags().names`. */
  data: Uint32Array;
}

export interface TagsResult {
  names: string[];
}

export interface RenderResult {
  data: Uint8ClampedArray;
  width: number;
}

export interface ExportResult {
  data: Uint8Array;
  mime: string;
}
