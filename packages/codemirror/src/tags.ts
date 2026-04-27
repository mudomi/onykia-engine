import { Tag, tags } from '@lezer/highlight';
import { HighlightStyle } from '@codemirror/language';

/** Typst-specific tags (not in the default Lezer highlight set). */
export const typstTags = {
  mathDelimiter: Tag.define(),
  listMarker: Tag.define(),
  interpolated: Tag.define(),
  func: Tag.define(),
};

/** Maps WASM-emitted token names to Lezer highlight tags. */
export const nameToTag: Record<string, Tag> = {
  'typ-comment': tags.comment,
  'typ-punct': tags.punctuation,
  'typ-escape': tags.escape,
  'typ-strong': tags.strong,
  'typ-emph': tags.emphasis,
  'typ-link': tags.link,
  'typ-raw': tags.monospace,
  'typ-label': tags.labelName,
  'typ-ref': tags.labelName,
  'typ-heading': tags.heading,
  'typ-marker': typstTags.listMarker,
  'typ-term': tags.definitionKeyword,
  'typ-math-delim': typstTags.mathDelimiter,
  'typ-math-op': tags.arithmeticOperator,
  'typ-key': tags.keyword,
  'typ-op': tags.operator,
  'typ-num': tags.number,
  'typ-str': tags.string,
  'typ-func': typstTags.func,
  'typ-pol': typstTags.interpolated,
  'typ-error': tags.invalid,
};

/** A neutral default HighlightStyle. Hosts can override by passing their own. */
export const defaultTypstHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#6a737d', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#d73a49' },
  { tag: tags.string, color: '#032f62' },
  { tag: tags.number, color: '#005cc5' },
  { tag: tags.operator, color: '#d73a49' },
  { tag: tags.punctuation, color: '#24292e' },
  { tag: tags.escape, color: '#22863a' },
  { tag: tags.heading, color: '#005cc5', fontWeight: 'bold' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#0366d6', textDecoration: 'underline' },
  { tag: tags.monospace, color: '#6f42c1', fontFamily: 'ui-monospace, monospace' },
  { tag: tags.labelName, color: '#22863a' },
  { tag: tags.definitionKeyword, color: '#e36209', fontWeight: 'bold' },
  { tag: typstTags.func, color: '#6f42c1' },
  { tag: typstTags.mathDelimiter, color: '#e36209' },
  { tag: typstTags.interpolated, color: '#0366d6' },
  { tag: typstTags.listMarker, color: '#e36209', fontWeight: 'bold' },
  { tag: tags.invalid, color: '#b31d28', textDecoration: 'underline wavy' },
]);
