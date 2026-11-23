import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { STANDARD_CATEGORIES, STANDARD_CATEGORY_KEYS } from "../store/kasb-db.js";

const CATEGORY_LEGEND = STANDARD_CATEGORY_KEYS.map((k) => `${k}(${STANDARD_CATEGORIES[k]})`).join(" · ");

export const listStandards = defineTool({
  name: "list_standards",
  title: "수록 기준서 카탈로그",
  summary: "수록된 기준서 카탈로그를 반환합니다.",
  purpose: `- Which 기준서 are in the corpus, and which numbers feed search_standards' std_num filter.`,
  usage: `1. "수록된 기준서 전부" → (인자 없음)
2. "감사기준서만" → category="audit"
3. "내부회계관리제도 관련" → category="icfr"`,
  response: `- { count, standards:[{std_num, title, category}] }
- category values: ${CATEGORY_LEGEND}.`,
  rules: `- Lists 수집 성공(crawl_status='ok') 기준서 only — an absent 기준서 means "미수집", not "존재하지 않음".
- 감사인증·윤리기준 (검토·인증·품질관리 등)과 고시 원문 are outside this catalog — search_standards category="assure"·"ext_std".
- category is a free-form string, not an enum: an unknown value returns count=0, not an error.`,
  input: {
    category: z.string().optional().describe("카테고리로 필터 (생략 시 전체)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ category }, { corpus }) => {
    const rows = category
      ? corpus.prepare(`SELECT std_num, title, category FROM standards
                    WHERE crawl_status = 'ok' AND category = ? ORDER BY std_num`).all(category)
      : corpus.prepare(`SELECT std_num, title, category FROM standards
                    WHERE crawl_status = 'ok' ORDER BY category, std_num`).all();
    return asText({ count: rows.length, standards: rows });
  },
});
