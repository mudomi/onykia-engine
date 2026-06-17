// Transport-agnostic multi-user cursor presence for CodeMirror.
//
// Broadcasts the local selection and renders remote peers' cursors/selections.
// Both the network (publish/subscribe) and the cursor representation are
// injected, so this works over any transport (NATS, WebSocket, BroadcastChannel)
// and any stable-position scheme (Automerge Cursor, Yjs RelativePosition).
//
// Positions travel as opaque cursors, not integer offsets: the receiver
// resolves each cursor against its own document so positions stay correct
// despite concurrent edits and sync lag.

import {
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';

/** Network the extension publishes presence on and listens for peers through. */
export interface AwarenessTransport {
  publish(subject: string, data?: Uint8Array): void;
  subscribe(
    subject: string,
    cb: (data: Uint8Array | undefined) => void,
  ): { unsubscribe(): void };
  isClosed(): boolean;
}

/**
 * Converts between document offsets and a stable cursor representation `C`.
 * `C` must be JSON-serializable - it travels over the transport verbatim.
 */
export interface CursorCodec<C> {
  create(pos: number): C | null;
  resolve(cursor: C): number | null;
}

interface PeerState<C> {
  peerId: string;
  username: string;
  /** File the peer is viewing; cursors only render when it matches ours. */
  filePath: string;
  head: C | null;
  anchor: C | null;
}

interface ResolvedCursor {
  peerId: string;
  username: string;
  head: number;
  anchor: number;
}

// Throttle outgoing broadcasts so a burst of keystrokes sends at most one
// update per interval; 50ms keeps remote cursors responsive without flooding.
const CURSOR_BROADCAST_MS = 50;

export interface AwarenessCursorOptions<C> {
  peerId: string;
  username: string;
  filePath: string;
  docId: string;
  transport: AwarenessTransport;
  cursorCodec: CursorCodec<C>;
  /**
   * Map a peer id to a CSS color for its cursor and selection. When omitted,
   * decorations carry only a `cm-remote-cursor` class and a `data-peer`
   * attribute, leaving all coloring to the consumer's stylesheet.
   */
  colorForPeer?: (peerId: string) => string;
}

/**
 * CodeMirror extension that broadcasts the local cursor and renders remote
 * peers' cursors over the supplied transport.
 *
 * Returns the extension plus `destroy` (tear down the subscription and timer)
 * and `evictPeer` (drop a peer immediately, e.g. on a disconnect event).
 */
export function awarenessCursorExtension<C>(options: AwarenessCursorOptions<C>): {
  extension: Extension;
  destroy: () => void;
  evictPeer: (peerId: string) => void;
} {
  const { peerId, username, filePath, docId, transport, cursorCodec, colorForPeer } = options;
  const subject = `onykia.awareness.${docId}`;

  const remotePeers = new Map<string, PeerState<C>>();
  let currentView: EditorView | null = null;
  let lastBroadcast = 0;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  const setResolvedCursors = StateEffect.define<ResolvedCursor[]>();

  const cursorsField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decos, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setResolvedCursors)) {
          return buildDecorations(effect.value, tr.state.doc.length, colorForPeer);
        }
      }
      // Remap through local edits so cursors track text between broadcasts.
      if (tr.docChanged && decos !== Decoration.none) return decos.map(tr.changes);
      return decos;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  function resolveRemoteCursors(): ResolvedCursor[] {
    const resolved: ResolvedCursor[] = [];
    for (const peer of remotePeers.values()) {
      if (peer.filePath !== filePath || peer.head === null) continue;

      const head = cursorCodec.resolve(peer.head);
      if (head === null) continue;

      const anchor = peer.anchor !== null ? (cursorCodec.resolve(peer.anchor) ?? head) : head;
      resolved.push({ peerId: peer.peerId, username: peer.username, head, anchor });
    }
    return resolved;
  }

  function repaint() {
    currentView?.dispatch({ effects: setResolvedCursors.of(resolveRemoteCursors()) });
  }

  function broadcastCursor(view: EditorView) {
    if (transport.isClosed()) return;

    const sel = view.state.selection.main;
    const state: PeerState<C> = {
      peerId,
      username,
      filePath,
      head: cursorCodec.create(sel.head),
      anchor: cursorCodec.create(sel.anchor),
    };
    transport.publish(subject, encode(state));
    lastBroadcast = Date.now();
  }

  function scheduleBroadcast(view: EditorView) {
    if (broadcastTimer) clearTimeout(broadcastTimer);

    const elapsed = Date.now() - lastBroadcast;
    if (elapsed >= CURSOR_BROADCAST_MS) {
      broadcastCursor(view);
    } else {
      broadcastTimer = setTimeout(() => broadcastCursor(view), CURSOR_BROADCAST_MS - elapsed);
    }
  }

  const subscription = transport.subscribe(subject, (data) => {
    if (!data) return;
    const peer = decode<C>(data);
    // Ignore our own echo and presence-only heartbeats (no cursor to render).
    if (!peer || peer.peerId === peerId || peer.head === null) return;

    remotePeers.set(peer.peerId, peer);
    repaint();
  });

  const selectionListener = EditorView.updateListener.of((update) => {
    currentView = update.view;
    if (update.selectionSet || update.docChanged) scheduleBroadcast(update.view);
  });

  function evictPeer(id: string) {
    if (remotePeers.delete(id)) repaint();
  }

  function destroy() {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    try {
      subscription.unsubscribe();
    } catch {
      // Transport already closed; nothing to unsubscribe.
    }
    currentView = null;
  }

  return {
    extension: [cursorsField, selectionListener],
    destroy,
    evictPeer,
  };
}

class CursorWidget extends WidgetType {
  constructor(
    readonly color: string | undefined,
    readonly username: string,
    readonly peerId: string,
  ) {
    super();
  }

  eq(other: CursorWidget): boolean {
    return (
      this.color === other.color &&
      this.username === other.username &&
      this.peerId === other.peerId
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-remote-cursor';
    el.dataset.peer = this.peerId;
    if (this.color) el.style.borderLeftColor = this.color;

    const label = document.createElement('span');
    label.className = 'cm-remote-cursor-label';
    if (this.color) label.style.backgroundColor = this.color;
    label.textContent = this.username;
    el.appendChild(label);

    return el;
  }
}

function buildDecorations(
  cursors: ResolvedCursor[],
  docLength: number,
  colorForPeer?: (peerId: string) => string,
): DecorationSet {
  const specs: { from: number; to: number; decoration: Decoration }[] = [];

  for (const cursor of cursors) {
    const color = colorForPeer?.(cursor.peerId);

    const selFrom = Math.max(0, Math.min(cursor.head, cursor.anchor));
    const selTo = Math.min(docLength, Math.max(cursor.head, cursor.anchor));
    if (selFrom < selTo) {
      specs.push({
        from: selFrom,
        to: selTo,
        decoration: Decoration.mark({
          class: 'cm-remote-selection',
          attributes: {
            'data-peer': cursor.peerId,
            ...(color
              ? { style: `background-color: color-mix(in oklch, ${color} 25%, transparent)` }
              : {}),
          },
        }),
      });
    }

    const pos = Math.min(Math.max(0, cursor.head), docLength);
    specs.push({
      from: pos,
      to: pos,
      decoration: Decoration.widget({
        widget: new CursorWidget(color, cursor.username, cursor.peerId),
        side: 1,
      }),
    });
  }

  // RangeSetBuilder requires ranges added in ascending document order.
  specs.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, decoration } of specs) builder.add(from, to, decoration);
  return builder.finish();
}

function encode<C>(state: PeerState<C>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(state));
}

function decode<C>(data: Uint8Array): PeerState<C> | null {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as PeerState<C>;
  } catch {
    return null;
  }
}
