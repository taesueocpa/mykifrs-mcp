import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { qnaMeta, validityField, type QnaRow } from "./qna-shared.js";
import { materialKey, mergeWithFloor, PRACTICE_BOARDS, searchMaterialRows } from "./material-shared.js";
import { validityByDoc } from "../store/validity.js";

export const searchQnas = defineTool({
  name: "search_qnas",
  title: "질의회신·실무 해석 전문검색",
  summary: "질의회신과 정착지원TF·품질관리실장 회의자료를 한 목록으로 전문검색합니다.",
  purpose: `- 회신 and KASB 실무 해석 (정착지원TF·품질관리실장 회의) for issues the 기준서 alone cannot settle.
- 문단-linked 회신 → get_paragraph related_qnas.`,
  usage: `1. "전환사채 콜옵션 회계처리 질의회신" → query="전환사채 콜옵션"
2. "1118호 영업손익 TF 논의까지 30건" → query="영업손익", limit=30`,
  response: `- { hits, results } by relevance; matched tf·qc keep ≥3 slots (≤limit/3). kind "qna" = 회신 {source, qna_key, doc_number, date, title,
  rel_stds, org, snippet} → get_qna; kind "tf"·"qc" = 정착지원TF·품질관리실장 회의 {material_key, category, date,
  title, snippet} → get_material.
- org = 회신 기관 (회계기준원·금융감독원·신속처리질의·IFRS 해석위원회 논의결과·구 QnA); source = 수록 세대
  (v2·legacy), never the 기관.
- rel_stds is HTML — data-std + data-id → unique_key ("1109-6.1.1").`,
  rules: `- Tokens ≥3 chars → FTS (AND, rank); 1~2 chars → LIKE (회신 first).
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

    const conds: string[] = [];
    const params: unknown[] = [];
    if (match) { conds.push("qna_fts MATCH ?"); params.push(match); }
    for (const s of short) { conds.push("q.full_content LIKE ?"); params.push(`%${s}%`); }
    params.push(limit);

    const rows = corpus.prepare(`
      SELECT qn.source, qn.id, qn.type, qn.doc_number, qn.date, qn.title, qn.rel_stds,
             t.title AS type_title, ${match ? "bm25(qna_fts)" : "NULL"} AS score,
             snippet(qna_fts, 1, '⟦', '⟧', '…', 24) AS snippet
      FROM qna_fts q
      JOIN qnas qn ON qn.rowid = q.rowid
      LEFT JOIN qna_types t ON t.type = qn.type
      WHERE ${conds.join(" AND ")}
      ${match ? "ORDER BY rank" : ""} LIMIT ?`).all(...params) as Array<QnaRow & { score: number | null; snippet: string }>;
    const vmap = validityByDoc(corpus, rows.map((r) => r.doc_number));
    const qnas = rows.map((r) => ({
      score: r.score, material: false,
      item: { kind: "qna", ...qnaMeta(r), ...validityField(vmap.get(r.doc_number ?? "")), snippet: r.snippet } as object,
    }));
    // 실무 해석 — 같은 검색어·같은 FTS 규칙(searchMaterialRows). 합치는 규칙은 mergeWithFloor 하나.
    const practice = searchMaterialRows(corpus, { match, short }, { boards: PRACTICE_BOARDS, limit }).map((p) => ({
      score: p.score, material: true,
      item: { kind: p.board, material_key: materialKey(p.board, p.id), category: p.category, date: p.date, title: p.title,
        snippet: p.snippet } as object,
    }));
    const results = mergeWithFloor(qnas, practice, limit, Boolean(match));
    return asText({ hits: results.length, results });
  },
});
