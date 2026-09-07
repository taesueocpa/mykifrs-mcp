import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";

export const getParagraph = defineTool({
  name: "get_paragraph",
  title: "기준서 문단 원문",
  summary: "기준서 문단 전문을 앞뒤 문맥과 함께 반환합니다.",
  purpose: `- To quote a found 문단 exactly — the search snippet is never quotable evidence.
- To check 조건절·예외 with neighbors — a lone 문단 invites misreading.`,
  usage: `1. "1116호 33문단 원문" → unique_key="1116-33"
2. "앞뒤로 더 넓게 보여줘" → unique_key="1116-33", context=5
3. "이 문단만 딱" → unique_key="1115-B58", context=0`,
  response: `- { standard:{std_num, title, category}, target, related_qnas:[doc_number], items:[…] }
- items[]: { seq, item_type, unique_key, para_num, level, title, ref, content_text }
- item_type: "paragraph" = 본문, "title" = 제목 행.
- related_qnas: doc_number array (e.g. ["GKQA01-085"]) — feed each to get_qna.
- Unknown key returns { error: "문단 없음: {unique_key}" }.`,
  rules: `- unique_key = "{기준서번호}-{문단번호}". 문단 numbers aren't digits-only
  (B58·AG12·SP1.2·6.1.1) — pass the value verbatim, never normalize it.
- context expands within the same 기준서 part only — boundaries return fewer items; not an error.
- Quote content_text, never a search snippet.`,
  input: {
    unique_key: z.string().describe("문단 키 (예: '1116-33')"),
    context: z.number().optional().default(2).describe("앞뒤로 포함할 항목 수 (기본 2)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ unique_key, context }, { corpus }) => {
    const target = corpus.prepare(`
      SELECT std_num, part_document_id, seq, faq_doc_numbers FROM content_items
      WHERE unique_key = ?`).get(unique_key) as
      { std_num: number; part_document_id: string; seq: number; faq_doc_numbers: string | null } | undefined;
    if (!target) return asText({ error: `문단 없음: ${unique_key}` });

    const std = corpus.prepare(`SELECT title, category FROM standards WHERE std_num = ?`).get(target.std_num) as
      { title: string; category: string } | undefined;
    const items = corpus.prepare(`
      SELECT seq, item_type, unique_key, para_num, level, title, ref, content_text
      FROM content_items
      WHERE std_num = ? AND part_document_id = ? AND seq BETWEEN ? AND ?
      ORDER BY seq`).all(target.std_num, target.part_document_id,
        target.seq - context, target.seq + context);
    return asText({
      standard: { std_num: target.std_num, ...std },
      target: unique_key,
      related_qnas: target.faq_doc_numbers ? target.faq_doc_numbers.split(",") : [],
      items,
    });
  },
});
