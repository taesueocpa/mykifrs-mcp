import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { parseQnaKey, qnaKey, qnaMeta, type QnaRow } from "./qna-shared.js";

type FullRow = QnaRow & { full_content: string | null };

const SELECT = `
  SELECT q.source, q.id, q.type, q.doc_number, q.date, q.title, q.rel_stds, q.full_content,
         t.title AS type_title
  FROM qnas q LEFT JOIN qna_types t ON t.type = q.type`;

/** 전문 행 정형화 — 공통 메타 사이에 full_content 를 끼운다(키 순서는 응답 텍스트의 일부). */
function full(r: FullRow) {
  const m = qnaMeta(r);
  return {
    source: m.source, qna_key: m.qna_key, doc_number: m.doc_number, date: m.date, title: m.title,
    rel_stds: m.rel_stds, full_content: r.full_content, org: m.org,
  };
}

export const getQna = defineTool({
  name: "get_qna",
  title: "질의회신 전문",
  summary: "질의회신 전문을 반환합니다.",
  purpose: `- The 회신 full text for a doc_number (search_qnas, get_paragraph's related_qnas) or a qna_key (search_qnas).`,
  usage: `1. "2017-001 회신 전문" → doc_number="2017-001"
2. "legacy:6009 전문" → qna_key="legacy:6009"`,
  response: `- { results:[{source, qna_key, doc_number, date, title, rel_stds, full_content, org}] }
- Miss → { error: "문서번호 없음: {doc_number}", similar:[{source, qna_key, doc_number, title}] } (≤5 부분일치)
  or { error: "qna_key 없음: {qna_key}" }.
- source / org / rel_stds: same meaning as in search_qnas.`,
  rules: `- results is an array; doc_number is NOT unique ("GKQA03-100" → 2 rows). Never answer from the first
  row alone — pin one by qna_key.
- qna_key = "{source}:{id}" exactly as returned; if both arguments are given, qna_key wins.
- 번호 formats differ by series ("2021-G-KQA005" · "GKQA01-085" · "금감원사례-1") — pass the value as
  received, never alter case or separators.
- On a miss, re-ask using \`similar\` rather than guessing another 번호.`,
  input: {
    doc_number: z.string().optional().describe("질의회신 문서번호 — qna_key 를 주지 않을 때 필수"),
    qna_key: z.string().optional()
      .describe("행 식별자 \"{source}:{id}\" (search_qnas 의 qna_key, 예: legacy:6009) — 번호가 비었거나 중복일 때"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ doc_number, qna_key }, { corpus }) => {
    if (qna_key?.trim()) {
      const k = parseQnaKey(qna_key);
      if (!k) return asText({ error: `qna_key 형식 오류: ${qna_key}` });
      const rows = corpus.prepare(`${SELECT} WHERE q.source = ? AND q.id = ?`).all(k.source, k.id) as FullRow[];
      if (rows.length === 0) return asText({ error: `qna_key 없음: ${qna_key}` });
      return asText({ results: rows.map(full) });
    }
    // 빈 번호를 그대로 조회하면 번호 없는 행 전부(구 IFRS IC 논의 요약)가 돌아온다 — 인자 부재로 다룬다.
    if (doc_number == null || doc_number.trim() === "") return asText({ error: "doc_number 또는 qna_key 필요" });

    const rows = corpus.prepare(`${SELECT} WHERE q.doc_number = ?`).all(doc_number) as FullRow[];
    if (rows.length === 0) {
      const fuzzy = corpus.prepare(`
        SELECT source, id, doc_number, title FROM qnas WHERE doc_number LIKE ? LIMIT 5`)
        .all(`%${doc_number}%`) as Array<Pick<QnaRow, "source" | "id" | "doc_number" | "title">>;
      return asText({
        error: `문서번호 없음: ${doc_number}`,
        similar: fuzzy.map((f) => ({
          source: f.source, qna_key: qnaKey(f.source, f.id), doc_number: f.doc_number, title: f.title,
        })),
      });
    }
    return asText({ results: rows.map(full) });
  },
});
