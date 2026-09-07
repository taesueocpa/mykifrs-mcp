import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";

export const listStandards = defineTool({
  name: "list_standards",
  title: "수록 기준서 카탈로그",
  summary: "수록된 기준서 카탈로그를 반환합니다.",
  purpose: `- Which 기준서 are in the corpus, and which numbers feed search_standards' std_num filter.`,
  usage: `1. "수록된 기준서 전부" → (인자 없음)
2. "감사기준서만" → category="audit"
3. "내부회계관리제도 관련" → category="icfr"`,
  response: `- { count, standards:[{std_num, title, category}] }
- category values: kifrs(한국채택국제회계기준) · interpretation(해석서) · concept(재무보고를 위한 개념체계)
  · kgaap(일반기업회계기준) · audit(감사기준서) · icfr(내부회계관리제도) · esg(KSSB 지속가능성 공시기준)
  · translation(번역본) · special(특수분야).`,
  rules: `- Lists 수집 성공(crawl_status='ok') 기준서 only — an absent 기준서 means "미수집", not "존재하지 않음".
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
