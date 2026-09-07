/**
 * 도구 레지스트리 — 광고 표면의 유일한 정본.
 *
 * stdio·원격 서버 모두 이 배열 하나를 소비한다(src/server/build-server.ts) — 도구 정의의 복제본이
 * 없으므로 "양쪽 동기화" 같은 규율이 필요 없다.
 *
 * 배열 순서 = tools/list 카탈로그 순서(결정적). 도구 수·description 문서·랜딩 표기는
 * 전부 여기서 파생한다 — 수기 리터럴을 다른 곳에 만들지 않는다.
 */
import type { ToolSpec } from "./spec.js";
import { searchStandards } from "./search-standards.js";
import { searchQnas } from "./search-qnas.js";
import { getParagraph } from "./get-paragraph.js";
import { getQna } from "./get-qna.js";
import { listStandards } from "./list-standards.js";
import { getUsageStats } from "./get-usage-stats.js";

// eslint 없음 — 타입만 넓힌다(개별 파일은 Shape 를 좁게 유지).
export const TOOLS: ReadonlyArray<ToolSpec<any>> = [
  searchStandards,
  searchQnas,
  getParagraph,
  getQna,
  listStandards,
  getUsageStats,
];
