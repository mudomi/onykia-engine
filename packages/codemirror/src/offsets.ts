// Offset conversion: CodeMirror uses UTF-16 code units; Typst/Rust uses UTF-8 bytes.

export function toByteOffset(text: string, utf16Offset: number): number {
  // TextEncoder.encode(slice) is the simplest correct implementation: JS
  // string slicing operates in UTF-16 code units (same as CM positions), so
  // slicing at utf16Offset and encoding gives the byte count up to that point.
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
        // Surrogate pair --> U+10000-U+10FFFF --> 4 UTF-8 bytes, 2 UTF-16 units.
        bytes += 4;
        i += 2;
      } else {
        // Lone high surrogate encodes as U+FFFD in UTF-8 (3 bytes).
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

// O(n) build, O(1) lookup — use when converting many offsets against the same text.
export function buildByteToCharMap(text: string): Uint32Array {
  // Upper bound: every byte could be its own ASCII char (1 byte per char),
  // so byteLen ≤ text.length * 4 (worst case all 4-byte sequences).
  // We don't know byteLen up front, so encode once to get it.
  const utf8 = new TextEncoder().encode(text);
  const map = new Uint32Array(utf8.length + 1);
  let byteIdx = 0;
  for (let charIdx = 0; charIdx < text.length; charIdx++) {
    const code = text.charCodeAt(charIdx);
    map[byteIdx] = charIdx;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(charIdx + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        map[byteIdx + 1] = charIdx;
        map[byteIdx + 2] = charIdx;
        map[byteIdx + 3] = charIdx;
        byteIdx += 4;
        charIdx++; // consume the low surrogate
      } else {
        map[byteIdx + 1] = charIdx;
        map[byteIdx + 2] = charIdx;
        byteIdx += 3;
      }
    } else if (code >= 0x800) {
      map[byteIdx + 1] = charIdx;
      map[byteIdx + 2] = charIdx;
      byteIdx += 3;
    } else if (code >= 0x80) {
      map[byteIdx + 1] = charIdx;
      byteIdx += 2;
    } else {
      byteIdx++;
    }
  }
  map[byteIdx] = text.length; // sentinel for end-of-doc offsets
  return map;
}
