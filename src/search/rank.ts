const K1 = 1.2;
const B = 0.75;
export const HEADING_BOOST = 1.0;
const PHRASE_BOOST = 0.5;

export interface QueryTerms {
  terms: string[];
  phrases: string[];
}

export function queryTerms(query: string): QueryTerms {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  const phrases: string[] = [];
  if (terms.length >= 2) {
    for (const p of [terms.join(""), terms.join(" ")]) if ([...p].length >= 3 && !phrases.includes(p)) phrases.push(p);
  }
  return { terms, phrases };
}

export const FALSE_FRIENDS: Readonly<Record<string, readonly string[]>> = {
  "리스": ["리스크", "리스트", "크리스", "그리스", "폴리스", "프리스", "리스본"],
  "감사": ["감사합니다", "감사드"],
  "공시": ["공시지가", "공시가격"],
};

function insideFalseFriend(haystack: string, i: number, needle: string): boolean {
  for (const f of FALSE_FRIENDS[needle] ?? []) {
    const k = f.indexOf(needle);
    if (i - k >= 0 && haystack.startsWith(f, i - k)) return true;
  }
  return false;
}

export function findTerm(haystack: string, needle: string, from = 0): number {
  if (!needle) return -1;
  if (!FALSE_FRIENDS[needle]) return haystack.indexOf(needle, from);
  for (let i = haystack.indexOf(needle, from); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    if (!insideFalseFriend(haystack, i, needle)) return i;
  }
  return -1;
}

export function hasTerm(haystack: string, needle: string): boolean {
  return findTerm(haystack, needle) >= 0;
}

export function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = findTerm(haystack, needle); i >= 0; i = findTerm(haystack, needle, i + needle.length)) n++;
  return n;
}

export function idf(df: number, total: number): number {
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

export interface RankStats {
  idf: Map<string, number>;
  avgLen: number;
}

export function relevance(q: QueryTerms, stats: RankStats, body: string, head: string, weight = 1): number {
  const norm = 1 - B + (B * body.length) / Math.max(1, stats.avgLen);
  let score = 0;
  let idfSum = 0;
  for (const t of q.terms) {
    const w = stats.idf.get(t) ?? 0;
    idfSum += w;
    const tf = countOccurrences(body, t);
    score += (w * tf * (K1 + 1)) / (tf + K1 * norm);
    if (hasTerm(head, t)) score += w * HEADING_BOOST;
  }
  if (q.phrases.some((p) => body.includes(p))) score += idfSum * PHRASE_BOOST;
  if (head && q.phrases.some((p) => head.includes(p))) score += idfSum * PHRASE_BOOST;
  return score * weight;
}

export function paragraphWeight(partType: string | null, paraNum: string | null): number {
  const p = paraNum ?? "";
  if (/^DO/.test(p)) return 0.4;
  if (partType === "basis-introduction" || /^(BC|결)/.test(p)) return 0.5;
  if (/^웩/.test(p)) return 0.6;
  if (partType === "other") return 0.6;
  if (partType === "example" || /^(IE|IG|사례)/.test(p)) return 0.75;
  return 1;
}

export function makeSnippet(
  text: string, lower: string, q: QueryTerms, stats: Pick<RankStats, "idf">, before = 14, after = 30,
): string {
  let at = -1;
  let len = 0;
  for (const p of q.phrases) {
    const i = lower.indexOf(p);
    if (i >= 0) { at = i; len = p.length; break; }
  }
  if (at < 0) {
    const byIdf = [...q.terms].sort((a, b) => (stats.idf.get(b) ?? 0) - (stats.idf.get(a) ?? 0));
    for (const t of byIdf) {
      const i = findTerm(lower, t);
      if (i >= 0) { at = i; len = t.length; break; }
    }
  }
  if (at < 0) { at = 0; len = 0; }
  const start = Math.max(0, at - before);
  const end = Math.min(text.length, at + len + after);
  const mark = new Array<boolean>(end - start).fill(false);
  for (const t of q.terms) {
    for (let i = findTerm(lower, t, start); i >= 0 && i < end; i = findTerm(lower, t, i + t.length))
      mark.fill(true, i - start, Math.min(i + t.length, end) - start);
  }
  let out = "";
  for (let i = 0; i < mark.length; i++) {
    if (mark[i] && (i === 0 || !mark[i - 1])) out += "⟦";
    out += text[start + i];
    if (mark[i] && (i === mark.length - 1 || !mark[i + 1])) out += "⟧";
  }
  return `${start > 0 ? "…" : ""}${out.replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}
