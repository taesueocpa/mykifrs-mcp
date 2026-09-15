import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";

export const getParagraph = defineTool({
  name: "get_paragraph",
  title: "기준서 문단 원문",
  summary: "기준서 문단 전문을 앞뒤 문맥과 함께 반환합니다.",
  purpose: `- To quote a found 문단 exactly — a search snippet is never quotable evidence.
- To check 조건절·예외 with neighbors.`,
  usage: `1. "1116호 33문단 원문" → unique_key="1116-33"
2. "앞뒤로 더 넓게" → unique_key="1116-33", context=5`,
  response: `- { standard:{std_num, title, category}, target, related_qnas:[doc_number], items:[…] }
- items[]: { seq, item_type, unique_key, para_num, level, title, ref, content_text };
  item_type "paragraph"=본문, "title"=제목.
- related_qnas → get_qna.
- Miss → { error: "문단 없음: {unique_key}", similar:[{unique_key, para_num}] } (≤5).`,
  rules: `- unique_key = "{기준서번호}-{문단번호}"; 문단 numbers aren't digits-only (B58·6.1.1) —
  pass verbatim, never normalize.
- Keys can carry a "-N" suffix ("1109-B2.7" misses, "1109-B2.7-1" hits — 12% of 문단). On a miss
  retry a \`similar\` candidate; never read it as "the 문단 does not exist".
- context expands within one part — boundaries return fewer items; not an error.
- Quote content_text, never a snippet.`,
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
    if (!target) {
      // 수집 원본이 같은 문단번호를 여러 번 내면 키에 "-N" 을 붙여 유일하게 만든다. 그 결과
      // 자연 키("1109-B2.7")로는 조회되지 않는 문단이 코퍼스의 12% 다 — 미스를 "문단이 없다"로
      // 읽으면 근거를 통째로 놓치므로, get_qna 와 같은 방식으로 후보를 함께 돌려준다.
      const dash = unique_key.indexOf("-");
      const std = dash > 0 ? Number(unique_key.slice(0, dash)) : NaN;
      const para = dash > 0 ? unique_key.slice(dash + 1) : "";
      const similar = Number.isFinite(std) && para
        ? corpus.prepare(`
            SELECT unique_key, para_num FROM content_items
            WHERE std_num = ? AND unique_key IS NOT NULL
              AND (para_num = ? OR unique_key LIKE ?)
            ORDER BY length(unique_key), seq LIMIT 5`).all(std, para, `${unique_key}-%`)
        : [];
      return asText({ error: `문단 없음: ${unique_key}`, similar });
    }

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
