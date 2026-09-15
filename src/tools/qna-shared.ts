/**
 * 질의회신 도구 공유 사전·정형화 — search_qnas·get_qna 가 함께 쓴다.
 *
 * org(회신 기관)의 정본은 두 갈래다: v2 행은 qna_types 사전(type → title), legacy 행은 LEGACY_ORG.
 * 구 QnA API 의 유형 코드 1~6 은 v2 사전에 없어서 여기서 매핑한다 — 각 유형의 문서번호 계열
 * (GKQA·금감원YYYY-NNN·회계기준원YYYY-NNN·금감원사례-N)과 본문 양식으로 기관을 확인한 값이다.
 * 표에 없는 유형은 LEGACY_ORG_FALLBACK 으로 나간다(조용히 다른 기관에 붙지 않는다).
 *
 * qna_key("{source}:{id}")는 행의 유일 식별자다. doc_number 는 비어 있거나(구 IFRS IC 논의 요약)
 * 두 세대에 같은 번호로 중복될 수 있고, id 는 세대 간에 충돌하므로 둘을 합친 키만 단건을 특정한다.
 */

/** legacy 유형 코드 → 회신 기관. 라벨은 v2 qna_types 의 title 과 같은 어휘를 쓴다(org 가 세대를 가리지 않게). */
export const LEGACY_ORG: Readonly<Record<number, string>> = {
  1: "회계기준원",               // GKQA·YYYY-G-KQA 계열 — 일반기업회계기준(구 기업회계기준) 질의회신
  2: "금융감독원",               // 금감원YYYY-NNN — 구 기업회계기준 시절 질의회신
  3: "IFRS 해석위원회 논의결과",  // 안건 논의 요약 — 문서번호가 없다
  4: "금융감독원",               // 금감원YYYY-NNN — K-IFRS 질의회신
  5: "회계기준원",               // 회계기준원YYYY-NNN — K-IFRS 질의회신
  6: "금융감독원",               // 금감원사례-N — K-IFRS 회계처리 사례
};
export const LEGACY_ORG_FALLBACK = "구 QnA";

const KEY_RE = /^(v2|legacy):(\d+)$/;

export const qnaKey = (source: string, id: number): string => `${source}:${id}`;

/** "{source}:{id}" 를 분해한다 — 형식이 아니면 null (id 단독은 세대 간 충돌이라 받지 않는다). */
export function parseQnaKey(key: string): { source: string; id: number } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { source: m[1], id: Number(m[2]) } : null;
}

/** 두 도구의 SELECT 가 공통으로 실어야 하는 열 — 정형화(qnaMeta)의 입력 계약. */
export interface QnaRow {
  source: string;
  id: number;
  type: number | null;
  doc_number: string | null;
  date: string | null;
  title: string | null;
  rel_stds: string | null;
  type_title: string | null; // qna_types.title (LEFT JOIN)
}

export function resolveOrg(r: Pick<QnaRow, "source" | "type" | "type_title">): string | null {
  if (r.type_title) return r.type_title;
  if (r.source === "legacy") return (r.type != null ? LEGACY_ORG[r.type] : undefined) ?? LEGACY_ORG_FALLBACK;
  return null;
}

/** 목록·전문 공통 메타 — 키 순서가 응답 텍스트의 일부이므로 여기서 한 번만 정한다. */
export function qnaMeta(r: QnaRow) {
  return {
    source: r.source,
    qna_key: qnaKey(r.source, r.id),
    doc_number: r.doc_number,
    date: r.date,
    title: r.title,
    rel_stds: r.rel_stds,
    org: resolveOrg(r),
  };
}
