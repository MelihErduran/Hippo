// Must match native/ranker/src/ranker.cpp exactly (the parity test checks).

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have',
  'are', 'was', 'but', 'not', 'you', 'your', 'about', 'into',
  'just', 'then', 'than', 'its', 'our', 'out', 'all', 'can',
  'will', 'what', 'when', 'where', 'who', 'how', 'to', 'of',
  'in', 'on', 'at', 'is', 'it', 'be', 'or', 'as',
  'by', 'me', 'my', 'do', 'so', 'up', 'if', 'we',
  'he', 'she', 'they', 'them', 'his', 'her', 'there', 'been',
  'also', 'an',
]);

/**
 * Lowercase ASCII letters, keep non-ASCII characters as-is (so "ödev" survives),
 * split on anything else, drop single ASCII characters and stopwords.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      const singleAscii = cur.length === 1 && cur.charCodeAt(0) < 128;
      if (!singleAscii && !STOPWORDS.has(cur)) out.push(cur);
      cur = '';
    }
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 128) cur += ch;
    else if (cp >= 65 && cp <= 90) cur += String.fromCharCode(cp + 32);
    else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) cur += ch;
    else flush();
  }
  flush();
  return out;
}
