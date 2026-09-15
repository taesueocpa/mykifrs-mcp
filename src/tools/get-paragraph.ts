import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";

/**
 * KASB 는 번호가 없는 블록(부록 도입문·표·양식)과 각주에도 키가 필요해 내부 토큰을 붙인다 —
 * "웩N"·"왝N" 은 둘 다 기준서에 존재하지 않는 문단번호다. 응답만 봐선 토큰인지 알 수 없어
 * 그대로 인용하면 없는 문단이 만들어지므로, 소속 섹션 제목과 함께 경고를 동봉한다.
 * 정상 문단에는 붙지 않는다.
 */
function syntheticNote(paraNum: string | null, section: string | null): { note?: string } {
  if (!paraNum) return {};
  if (paraNum.startsWith("웩"))
    return { note: `para_num '${paraNum}' 은 번호 없는 블록(부록 도입문·표·양식)에 KASB 가 붙인 내부 토큰이다`
      + ` — 문단번호로 인용하지 말고 소속 섹션${section ? ` '${section}'` : ""} 을 인용 앵커로 쓸 것` };
  if (paraNum.startsWith("왝"))
    return { note: `para_num '${paraNum}' 은 각주에 붙은 KASB 내부 토큰이다 (숫자는 각주가 달린 문단 번호)`
      + ` — 본문 첫머리의 '(주N)' 과 그 앵커 문단으로 인용할 것` };
  return {};
}

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
      SELECT std_num, part_document_id, seq, para_num, document_id, faq_doc_numbers FROM content_items
      WHERE unique_key = ?`).get(unique_key) as
      { std_num: number; part_document_id: string; seq: number; para_num: string | null;
        document_id: string | null; faq_doc_numbers: string | null } | undefined;
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
    const section = target.document_id
      ? (corpus.prepare(`SELECT title FROM sections WHERE std_num = ? AND document_id = ?`)
          .get(target.std_num, target.document_id) as { title: string | null } | undefined)?.title ?? null
      : null;
    return asText({
      standard: { std_num: target.std_num, ...std },
      target: unique_key,
      section,
      ...syntheticNote(target.para_num, section),
      related_qnas: target.faq_doc_numbers ? target.faq_doc_numbers.split(",") : [],
      items,
    });
  },
});
