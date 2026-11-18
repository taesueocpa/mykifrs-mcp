import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { makeSnippet, queryTerms, relevance } from "../search/rank.js";
import { qnaMeta, validityField } from "./qna-shared.js";
import { materialKey, mergeWithFloor, PRACTICE_BOARDS, searchMaterialRows } from "./material-shared.js";
import { findDocs, qnaIndex, rankStats } from "./search-index.js";
import { validityByDoc } from "../store/validity.js";

export const searchQnas = defineTool({
  name: "search_qnas",
  title: "질의회신·실무 해석 전문검색",
  summary: "질의회신과 정착지원TF·품질관리실장 회의자료를 한 목록으로 전문검색합니다.",
  purpose: `- 회신 and KASB 실무 해석 (정착지원TF·품질관리실장 회의) for issues the 기준서 alone cannot settle.
- 문단-linked 회신 → get_paragraph related_qnas.`,
  usage: `1. "전환사채 콜옵션 회계처리 질의회신" → query="전환사채 콜옵션"
2. "1118호 영업손익 TF 논의까지 30건" → query="영업손익", limit=30`,
  response: `- { hits, results } by relevance; matched tf·qc keep ≥3 slots (≤limit/3). kind "qna" = 회신 {source, qna_key, doc_number, url,
  date, title, rel_stds, org, snippet} → get_qna; kind "tf"·"qc" = 정착지원TF·품질관리실장 회의 {material_key, category, date,
  title, url, snippet} → get_material.
- org = 회신 기관 (회계기준원·금융감독원·신속처리질의·IFRS 해석위원회 논의결과·구 QnA); source = 수록 세대
  (v2·legacy), never the 기관.
- rel_stds is HTML — data-std + data-id → unique_key ("1109-6.1.1").`,
  rules: `- Every token must appear (substring, in 제목 or 본문); 제목 hits first.
- kind tf·qc are 논의·회의 요약, not 회신 — never cite them as 질의회신.
- qna_key pins one 회신 when doc_number is "" or duplicated. legacy 회신 (mostly 2000~2011, 구 기업회계기준) —
  check date.`,
  input: {
    query: z.string().describe("검색 키워드 (공백 구분)"),
    limit: z.number().optional().default(10).describe("최대 결과 수 (기본 10, 회신·TF·회의자료 합계)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, limit }, { corpus }) => {
    const { match, short } = splitQuery(query);
    if (!match && short.length === 0) return asText({ error: "검색어가 비어 있음" });

    const ix = qnaIndex(corpus);
    const q = queryTerms(query);
    const stats = rankStats(ix, q);
    const top = findDocs(ix, q.terms)
      .map((d) => ({ d, s: relevance(q, stats, d.lower, d.head) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);
    const vmap = validityByDoc(corpus, top.map(({ d }) => d.doc_number));
    const qnas = top.map(({ d, s }) => ({
      score: -s, material: false,
      item: { kind: "qna", ...qnaMeta(d), ...validityField(vmap.get(d.doc_number ?? "")),
        snippet: makeSnippet(d.text, d.lower, q, stats) } as object,
    }));
    const practice = searchMaterialRows(corpus, { match, short, phrases: q.phrases }, { boards: PRACTICE_BOARDS, limit })
      .map((p) => ({
        score: p.score, material: true,
        item: { kind: p.board, material_key: materialKey(p.board, p.id), category: p.category, date: p.date, title: p.title,
          url: p.url, snippet: p.snippet } as object,
      }));
    const results = mergeWithFloor(qnas, practice, limit, true);
    return asText({ hits: results.length, results });
  },
});
