import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { MATERIAL_BOARDS, STANDARD_CATEGORIES, STANDARD_CATEGORY_KEYS } from "../store/kasb-db.js";
import { validityByMaterial } from "../store/validity.js";
import { materialKey, materialValidityField, mergeWithFloor, searchMaterialRows, STANDARD_BOARDS } from "./material-shared.js";

/**
 * category 인자 값 = 본문이 있는 기준서 카테고리 + 기준·고시 원문 게시판. assurance(검토·인증업무 기준)는 KASB 에
 * 목록만 있어 빼고, 그 본문(KICPA 판)은 assure 로 찾는다.
 */
const FAMILIES = [...STANDARD_CATEGORY_KEYS.filter((k) => k !== "assurance"), ...STANDARD_BOARDS] as [string, ...string[]];
const FAMILY_LEGEND = FAMILIES.map((k) =>
  `${k}(${k in STANDARD_CATEGORIES ? STANDARD_CATEGORIES[k as keyof typeof STANDARD_CATEGORIES]
    : MATERIAL_BOARDS[k as keyof typeof MATERIAL_BOARDS].label})`).join(" · ");

export const searchStandards = defineTool({
  name: "search_standards",
  title: "기준서·기준 원문 전문검색",
  summary: "기준서 문단과 감사인증·윤리기준·고시 원문을 한 목록으로 전문검색합니다.",
  purpose: `- The 기준 grounding a treatment ("사용권자산 손상 is which 문단?"): 기준서 문단 (K-IFRS·일반기업·감사·내부회계·
  중소·비영리) plus 감사인증·윤리기준 and 고시 원문 (공익법인·집합건물 회계처리기준 등).`,
  usage: `1. "사용권자산 손상 관련 기준" → query="사용권자산 손상"
2. "일반기업회계기준에서 리스 분류" → query="리스 분류", category="kgaap"
3. "1116호 안에서만 리스료 재측정" → query="리스료 재측정", std_num=1116`,
  response: `- { hits, results } by relevance; a matched assure·ext_std keeps ≥1 slot (limit ≥3).
- kind "paragraph" {std_num, std_title, category, unique_key ("1116-33"·"1109-6.1.1"), snippet} → get_paragraph;
  kind "assure"·"ext_std" {material_key, category, date, title, snippet} → get_material.
- Empty query → { error: "검색어가 비어 있음" }.`,
  rules: `- One 쟁점 differs by family (K-IFRS vs 일반기업회계기준 vs 중소기업) — confirm category·std_title fits the entity
  before citing; narrow with category.
- Tokens ≥3 chars → FTS (AND, rank); 1~2 → LIKE. 제목 rows excluded.
- snippet (⟦…⟧ marks) is a fragment — quote get_paragraph/get_material text.`,
  input: {
    query: z.string().describe("검색 키워드 (공백 구분)"),
    category: z.enum(FAMILIES).optional().describe(`기준 계열로 한정 (생략 시 전체) — ${FAMILY_LEGEND}`),
    std_num: z.number().optional().describe("특정 기준서로 한정 (예: 1116) — 주면 기준서 문단만"),
    limit: z.number().optional().default(10).describe("최대 결과 수 (기본 10, 문단·원문 합계)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, category, std_num, limit }, { corpus }) => {
    const { match, short } = splitQuery(query);
    if (!match && short.length === 0) return asText({ error: "검색어가 비어 있음" });
    const board = STANDARD_BOARDS.find((b) => b === category);
    const wantParagraphs = !board;
    const wantMaterials = std_num == null && (category == null || board != null);

    let paragraphs: Array<{ score: number | null; material: boolean; item: object }> = [];
    if (wantParagraphs) {
      const conds: string[] = ["c.item_type = 'paragraph'"];
      const params: unknown[] = [];
      if (match) { conds.push("content_fts MATCH ?"); params.push(match); }
      for (const s of short) { conds.push("c.content_text LIKE ?"); params.push(`%${s}%`); }
      if (std_num != null) { conds.push("c.std_num = ?"); params.push(std_num); }
      if (category) { conds.push("s.category = ?"); params.push(category); }
      params.push(limit);
      const rows = corpus.prepare(`
        SELECT c.std_num, s.title AS std_title, s.category, c.unique_key, ${match ? "bm25(content_fts)" : "NULL"} AS score,
               snippet(content_fts, 1, '⟦', '⟧', '…', 24) AS snippet
        FROM content_fts c JOIN standards s ON s.std_num = c.std_num
        WHERE ${conds.join(" AND ")}
        ${match ? "ORDER BY rank" : "ORDER BY c.std_num"} LIMIT ?`).all(...params) as Array<{
          std_num: number; std_title: string; category: string; unique_key: string; score: number | null; snippet: string;
        }>;
      paragraphs = rows.map(({ score, ...r }) => ({ score, material: false, item: { kind: "paragraph", ...r } }));
    }

    let materials: Array<{ score: number | null; material: boolean; item: object }> = [];
    if (wantMaterials) {
      const hits = searchMaterialRows(corpus, { match, short }, { boards: board ? [board] : STANDARD_BOARDS, limit });
      const v = validityByMaterial(corpus, hits);
      materials = hits.map((h) => ({
        score: h.score, material: true,
        item: { kind: h.board, material_key: materialKey(h.board, h.id), category: h.category, date: h.date, title: h.title,
          ...materialValidityField(v.get(materialKey(h.board, h.id))), snippet: h.snippet },
      }));
    }

    const results = board ? materials.slice(0, limit).map((m) => m.item)
      : mergeWithFloor(paragraphs, materials, limit, Boolean(match), 1);
    return asText({ hits: results.length, results });
  },
});
