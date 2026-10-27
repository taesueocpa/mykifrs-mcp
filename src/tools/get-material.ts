import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { materialKey, materialValidityField, parseMaterialKey } from "./material-shared.js";
import { validityByMaterial } from "../store/validity.js";

export const getMaterial = defineTool({
  name: "get_material",
  title: "회계기준원·공인회계사회 자료 전문",
  summary: "회계기준원·공인회계사회 자료와 외부 기관 고시의 전문(상세 본문과 첨부 파싱 본문)을 반환합니다.",
  purpose: `- Full text of one material_key (search_materials; search_standards kind assure·ext_std; search_qnas kind tf·qc).`,
  usage: `1. "tf:40689 전문" → material_key="tf:40689"
2. "길어서 잘렸는데 이어서" → material_key="tf:40689", offset_chars=60000`,
  response: `- { material_key, board, category, date, title, url, files:[{name, parsed}], body_total_chars,
  offset_chars, truncated, body }
- body = 상세 본문 + 첨부마다 "[첨부] 파일명" 머리를 단 파싱 본문. A 첨부 opening "(이미지 PDF — OCR 전사본"
  was OCR-read — verify figures against url.
- files[].parsed=false → 첨부 not extracted (zip·pptx 등) — point the user to url.
- Miss → { error: "material_key 없음: …" } or { error: "material_key 형식 오류: …" }.`,
  rules: `- truncated=true means offset_chars+max_chars < body_total_chars — raise offset_chars to continue;
  raising max_chars grows the whole response.
- board: search_materials' board legend, plus tf 정착지원TF · qc 품질관리실장 회의 · assure 감사인증·윤리기준 ·
  ext_std 고시 원문.`,
  input: {
    material_key: z.string()
      .describe("자료 식별자 \"{board}:{id}\" (search_materials·search_qnas 의 material_key, 예: tf:40689)"),
    max_chars: z.number().optional().default(60000).describe("본문 최대 길이(자)"),
    offset_chars: z.number().optional().default(0).describe("본문 시작 오프셋 (긴 자료 이어읽기)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // PlayMCP 채널: 첨부를 붙인 본문은 길다(교육자료·TF 회차 PDF/HWP). offset_chars 이어읽기와 truncated
  // 표식이 있어 18,000 자로 줄여도 답에 닿는 데 지장 없다(myfss get_document 와 같은 값).
  liteDefaults: { max_chars: 18000 },
  handler: async ({ material_key, max_chars, offset_chars }, { corpus }) => {
    const k = parseMaterialKey(material_key);
    if (!k) return asText({ error: `material_key 형식 오류: ${material_key}` });
    const r = corpus.prepare(`
      SELECT board, id, category, date, title, url, body, files FROM materials WHERE board = ? AND id = ?`)
      .get(k.board, k.id) as {
        board: string; id: number; category: string | null; date: string | null; title: string; url: string;
        body: string | null; files: string;
      } | undefined;
    if (!r) return asText({ error: `material_key 없음: ${material_key}` });
    const full = r.body ?? "";
    const v = validityByMaterial(corpus, [r]);
    return asText({
      material_key: materialKey(r.board, r.id),
      board: r.board,
      category: r.category,
      date: r.date,
      title: r.title,
      ...materialValidityField(v.get(materialKey(r.board, r.id))),
      url: r.url,
      files: JSON.parse(r.files) as Array<{ name: string; parsed: boolean }>,
      body_total_chars: full.length,
      offset_chars,
      truncated: offset_chars + max_chars < full.length,
      body: full.slice(offset_chars, offset_chars + max_chars),
    });
  },
});
