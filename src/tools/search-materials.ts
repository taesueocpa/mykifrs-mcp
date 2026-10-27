import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { BOARD_LEGEND, materialKey, materialValidityField, SEARCHABLE_BOARDS, searchMaterialRows } from "./material-shared.js";
import { validityByMaterial } from "../store/validity.js";

export const searchMaterials = defineTool({
  name: "search_materials",
  title: "회계기준원·공인회계사회 보조 자료 검색",
  summary: "회계기준원·공인회계사회의 보조 자료(질의회신 교육자료·공개초안·IASB 동향·연구보고서·협의회 사례·가치평가 자료 등)를 전문검색합니다.",
  purpose: `- Supporting (2-tier) material: 질의회신 교육·정비목록, 공개초안·IFRS 검토의견·제·개정 공표, IASB 동향, 연구보고서,
  세미나·KAI Forum, 제정개정과제, KICPA 전·당기 협의회 사례, 가치평가 자료실 (위험 프리미엄·IVS).
- 1-tier is in the core tools: 기준서·감사인증·윤리기준·고시 원문 → search_standards; 회신·정착지원TF·품질관리실장
  회의 → search_qnas.`,
  usage: `1. "1028호 공정가치선택권 공개초안" → query="공정가치선택권", board="ed"
2. "2025 질의회신 교육 리스" → query="리스", board="edu"
3. "시장위험 프리미엄" → query="시장위험 프리미엄", board="valuation"`,
  response: `- { hits, results:[{material_key, board, category, date, title, snippet}] }
- board codes: listed in the board parameter's description. date null = 과제 페이지.`,
  rules: `- Tokens ≥3 chars → FTS (AND, rank); 1~2 chars → LIKE (newest first).
- Supporting only, never 회신 — where it conflicts with 기준서·회신·1-tier, follow those.
- Read the full text with get_material(material_key).`,
  input: {
    query: z.string().describe("검색 키워드 (공백 구분)"),
    board: z.enum(SEARCHABLE_BOARDS).optional().describe(`게시판으로 한정 (생략 시 전체) — ${BOARD_LEGEND}`),
    limit: z.number().optional().default(10).describe("최대 결과 수 (기본 10)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, board, limit }, { corpus }) => {
    const q = splitQuery(query);
    if (!q.match && q.short.length === 0) return asText({ error: "검색어가 비어 있음" });
    const rows = searchMaterialRows(corpus, q, { boards: board ? [board] : SEARCHABLE_BOARDS, limit });
    const v = validityByMaterial(corpus, rows);
    return asText({
      hits: rows.length,
      results: rows.map((r) => ({
        material_key: materialKey(r.board, r.id), board: r.board, category: r.category, date: r.date,
        title: r.title, ...materialValidityField(v.get(materialKey(r.board, r.id))), snippet: r.snippet,
      })),
    });
  },
});
