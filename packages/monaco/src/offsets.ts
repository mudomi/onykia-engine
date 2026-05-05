/**
 * Offset conversion between Monaco (UTF-16 code units) and Rust/Typst
 * (UTF-8 bytes). Same constraints as the CodeMirror bindings - Typst
 * positions are UTF-8 byte offsets, JS strings are UTF-16. ASCII text is
 * identical in both; anything beyond U+007F diverges.
 *
 * Monaco's `ITextModel` exposes `getOffsetAt(position)` and
 * `getPositionAt(offset)` in UTF-16 code units, so we go via
 * `model.getValue()` to do the byte-level math.
 */

export function toByteOffset(text: string, utf16Offset: number): number {
  return new TextEncoder().encode(text.slice(0, utf16Offset)).length;
}

export function fromByteOffset(text: string, byteOffset: number): number {
  let bytes = 0;
  let i = 0;
  while (i < text.length && bytes < byteOffset) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 2;
      } else {
        bytes += 3;
        i++;
      }
    } else if (code >= 0x800) {
      bytes += 3;
      i++;
    } else if (code >= 0x80) {
      bytes += 2;
      i++;
    } else {
      bytes++;
      i++;
    }
  }
  return i;
}
