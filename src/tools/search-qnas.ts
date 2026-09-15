import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { qnaMeta, type QnaRow } from "./qna-shared.js";

export const searchQnas = defineTool({
  name: "search_qnas",
  title: "질의회신 전문검색",
  summary: "회계기준원·금융감독원·신속처리질의·IFRS 해석위원회 질의회신 3,669건을 전문검색합니다.",
  purpose: `- Official 회신 for practice issues the 기준서 text alone cannot settle.
- For 회신 tied to a 문단, get_paragraph's related_qnas is more precise.`,
  usage: `1. "전환사채 콜옵션 회계처리 질의회신" → query="전환사채 콜옵션"
2. "리스료 재측정 회신 30건" → query="리스료 재측정", limit=30`,
  response: `- { hits, results:[{source, qna_key, doc_number, date, title, rel_stds, org, snippet}] }
- source = 수록 세대 ("v2" 현행 / "legacy" 구 QnA), NOT the 회신 기관.
- org = 회신 기관: 회계기준원 / 금융감독원 / 신속처리질의 / IFRS 해석위원회 논의결과 ("구 QnA" = unmapped
  legacy 유형).
- rel_stds is raw HTML: <span data-std="1109" data-id="6.1.1"> → unique_key "1109-6.1.1".`,
  rules: `- Tokens ≥3 chars → FTS (AND, rank); 1~2 chars → LIKE.
- Never present \`source\` as the 회신 기관 — use \`org\`.
- Strip HTML in rel_stds; build 문단 키 from data-std/data-id.
- qna_key ("{source}:{id}") is get_qna's single-row handle — use it when doc_number is "" or duplicated.
  legacy 회신 are mostly 2000~2011 (구 기업회계기준) — check \`date\` before citing.`,
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
      SELECT qn.source, qn.id, qn.type, qn.doc_number, qn.date, qn.title, qn.rel_stds,
             t.title AS type_title,
             snippet(qna_fts, 1, '⟦', '⟧', '…', 24) AS snippet
      FROM qna_fts q
      JOIN qnas qn ON qn.rowid = q.rowid
      LEFT JOIN qna_types t ON t.type = qn.type
      WHERE ${conds.join(" AND ")}
      ${match ? "ORDER BY rank" : ""} LIMIT ?`).all(...params) as Array<QnaRow & { snippet: string }>;
    return asText({ hits: rows.length, results: rows.map((r) => ({ ...qnaMeta(r), snippet: r.snippet })) });
  },
});
