import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";

export const getQna = defineTool({
  name: "get_qna",
  title: "질의회신 전문",
  summary: "질의회신 전문을 반환합니다.",
  purpose: `- The 회신 full text for a doc_number from search_qnas results or get_paragraph's related_qnas.`,
  usage: `1. "2017-001 회신 전문" → doc_number="2017-001"
2. "GKQA01-085 원문" → doc_number="GKQA01-085"`,
  response: `- { results:[{source, doc_number, date, title, rel_stds, full_content, org}] }
- Miss returns { error: "문서번호 없음: {doc_number}", similar:[{source, doc_number, title}] }
  — up to 5 부분일치 candidates.
- source / org / rel_stds carry the same meaning as in search_qnas.`,
  rules: `- **results is an array and doc_number is NOT unique** — the same 번호 can appear 2+ times
  (measured: "GKQA03-100" → 2 rows). Never answer from the first row alone.
- 번호 formats differ by series: "2021-G-KQA005" · "GKQA01-085" · "SSI-35551" · "2017-001" ·
  "금감원사례-1". Pass the value as received — never alter case or separators.
- On a miss, re-ask using \`similar\` rather than guessing another 번호.`,
  input: {
    doc_number: z.string().describe("질의회신 문서번호"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ doc_number }, { corpus }) => {
    const rows = corpus.prepare(`
      SELECT q.source, q.doc_number, q.date, q.title, q.rel_stds, q.full_content,
             COALESCE(t.title, CASE q.source WHEN 'legacy' THEN '구 QnA' END) AS org
      FROM qnas q LEFT JOIN qna_types t ON t.type = q.type
      WHERE q.doc_number = ?`).all(doc_number);
    if (rows.length === 0) {
      const fuzzy = corpus.prepare(`
        SELECT source, doc_number, title FROM qnas WHERE doc_number LIKE ? LIMIT 5`)
        .all(`%${doc_number}%`);
      return asText({ error: `문서번호 없음: ${doc_number}`, similar: fuzzy });
    }
    return asText({ results: rows });
  },
});
