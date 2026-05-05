import * as monaco from 'monaco-editor';
import type { Core, Diagnostic } from '@mudomi/onykia-engine';
import { fromByteOffset } from './offsets.js';

// Tag for monaco.editor.setModelMarkers: lets us replace our markers without
// touching markers placed by other providers (TS lints, user-defined, etc.).
const OWNER = 'onykia';

export function applyDiagnostics(
  model: monaco.editor.ITextModel,
  diagnostics: Diagnostic[],
  currentPath: string,
): void {
  const text = model.getValue();
  const markers: monaco.editor.IMarkerData[] = [];

  for (const d of diagnostics) {
    if (d.package) continue;
    if (!d.range) continue;
    if (d.path && d.path !== currentPath) continue;

    const start = model.getPositionAt(fromByteOffset(text, d.range.start));
    const end = model.getPositionAt(fromByteOffset(text, d.range.end));

    markers.push({
      severity: toMonacoSeverity(d.severity),
      message: d.hints?.length ? `${d.message}\n\n${d.hints.join('\n')}` : d.message,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
  }

  monaco.editor.setModelMarkers(model, OWNER, markers);
}

export function diagnosticsSubscription(
  core: Core,
  model: monaco.editor.ITextModel,
  currentPath: string,
): () => void {
  return core.onDiagnostics(({ diagnostics }) => {
    applyDiagnostics(model, diagnostics, currentPath);
  });
}

function toMonacoSeverity(s: Diagnostic['severity']): monaco.MarkerSeverity {
  switch (s) {
    case 'error': return monaco.MarkerSeverity.Error;
    case 'warning': return monaco.MarkerSeverity.Warning;
  }
}
