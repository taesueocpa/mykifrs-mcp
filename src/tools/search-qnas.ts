import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";

export const searchQnas = defineTool({
  name: "search_qnas",
  title: "질의회신 전문검색",
  summary: "회계기준원·금융감독원·신속처리질의·IFRS 해석위원회 질의회신 3,669건을 전문검색합니다.",
  purpose: `- Official 회신 for practice issues the 기준서 text alone cannot settle.
- For 회신 tied to a specific 기준서 문단, get_paragraph's related_qnas is more precise.`,
  usage: `1. "전환사채 콜옵션 회계처리 질의회신" → query="전환사채 콜옵션"
2. "리스료 재측정 회신 30건까지" → query="리스료 재측정", limit=30`,
  response: `- { hits, results:[{source, doc_number, date, title, rel_stds, org, snippet}] }
- source: "v2" = 현행 질의회신DB, "legacy" = 구 QnA. This is the 수록 세대, NOT the 회신 기관.
- org: 회신 기관 — 회계기준원 / 금융감독원 / 신속처리질의 / IFRS 해석위원회 논의결과 / 구 QnA.
- rel_stds is raw HTML: <span data-std="1109" data-id="6.1.1"> → unique_key "1109-6.1.1".
- Empty query returns { error: "검색어가 비어 있음" }.`,
  rules: `- Tokenization matches search_standards (≥3 chars → FTS AND + rank, 1~2 chars → LIKE).
- Never present \`source\` as the 회신 기관 — use \`org\` for that.
- Strip the HTML tags in rel_stds before showing it; read data-std/data-id to build 문단 키.`,
  input: {
    query: z.string().describe("검색 키워드 (공백 구분)"),
    limit: z.number().optional().default(10).describe("최대 결과 수 (기본 10)"),
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
      SELECT q.source, q.doc_number, qn.date, qn.title, qn.rel_stds,
             COALESCE(t.title, CASE q.source WHEN 'legacy' THEN '구 QnA' END) AS org,
             snippet(qna_fts, 1, '⟦', '⟧', '…', 24) AS snippet
      FROM qna_fts q
      JOIN qnas qn ON qn.rowid = q.rowid
      LEFT JOIN qna_types t ON t.type = qn.type
      WHERE ${conds.join(" AND ")}
      ${match ? "ORDER BY rank" : ""} LIMIT ?`).all(...params);
    return asText({ hits: rows.length, results: rows });
  },
});
