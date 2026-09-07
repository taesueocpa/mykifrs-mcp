import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";

export const searchStandards = defineTool({
  name: "search_standards",
  title: "기준서 전문검색",
  summary: "K-IFRS·일반기업회계기준·감사기준서·내부회계관리제도·ESG(KSSB) 기준서 본문을 전문검색합니다.",
  purpose: `- Find the 기준서 문단 grounding a treatment ("사용권자산 손상 is which 문단?").
- For a hit's 원문·문맥, pass its unique_key to get_paragraph.`,
  usage: `1. "사용권자산 손상 관련 기준" → query="사용권자산 손상"
2. "1116호 안에서만 리스료 재측정" → query="리스료 재측정", std_num=1116
3. "수익 인식 5단계 문단 30개까지" → query="수익 인식 단계", limit=30`,
  response: `- { hits, results:[{std_num, std_title, category, unique_key, snippet}] }
- unique_key = "{std_num}-{문단번호}" (e.g. "1116-33", "1109-6.1.1", "2-2.7") — feed to get_paragraph.
- snippet marks matches with ⟦…⟧ and elides with "…".
- Empty query returns { error: "검색어가 비어 있음" }.`,
  rules: `- Tokens of ≥3 chars go to FTS (AND-joined, rank-ordered); 1~2 char tokens become LIKE filters.
  Short-token-only queries work but are ordered by std_num, not relevance.
- Body 문단 only (item_type='paragraph') — 제목 rows are excluded, so a hit is always body text.
- snippet is a fragment, never the whole 문단 — do not quote it as 기준서 원문.`,
  input: {
    query: z.string().describe("검색 키워드 (공백 구분)"),
    std_num: z.number().optional().describe("특정 기준서로 한정 (예: 1116)"),
    limit: z.number().optional().default(10).describe("최대 결과 수 (기본 10)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, std_num, limit }, { corpus }) => {
    const { match, short } = splitQuery(query);
    if (!match && short.length === 0) return asText({ error: "검색어가 비어 있음" });

    const conds: string[] = ["c.item_type = 'paragraph'"];
    const params: unknown[] = [];
    if (match) { conds.push("content_fts MATCH ?"); params.push(match); }
    for (const s of short) { conds.push("c.content_text LIKE ?"); params.push(`%${s}%`); }
    if (std_num != null) { conds.push("c.std_num = ?"); params.push(std_num); }
    params.push(limit);

    const rows = corpus.prepare(`
      SELECT c.std_num, s.title AS std_title, s.category, c.unique_key,
             snippet(content_fts, 1, '⟦', '⟧', '…', 24) AS snippet
      FROM content_fts c JOIN standards s ON s.std_num = c.std_num
      WHERE ${conds.join(" AND ")}
      ${match ? "ORDER BY rank" : "ORDER BY c.std_num"} LIMIT ?`).all(...params);
    return asText({ hits: rows.length, results: rows });
  },
});
