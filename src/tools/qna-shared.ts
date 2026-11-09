import { VALIDITY_NOTE, type Validity } from "../store/validity.js";

export function validityField(v: Validity[] | undefined): { validity?: { note: string; marks: Validity[] } } {
  return v && v.length ? { validity: { note: VALIDITY_NOTE, marks: v } } : {};
}

export const LEGACY_ORG: Readonly<Record<number, string>> = {
  1: "회계기준원",               // GKQA 계열: 일반기업회계기준 질의회신
  2: "금융감독원",               // 금감원YYYY-NNN: 구 기업회계기준 질의회신
  3: "IFRS 해석위원회 논의결과",  // 안건 요약(문서번호 없음)
  4: "금융감독원",               // 금감원YYYY-NNN: K-IFRS 질의회신
  5: "회계기준원",               // 회계기준원YYYY-NNN: K-IFRS 질의회신
  6: "금융감독원",               // 금감원사례-N: K-IFRS 회계처리 사례
};
export const LEGACY_ORG_FALLBACK = "구 QnA";

const KEY_RE = /^(v2|legacy):(\d+)$/;

export const qnaKey = (source: string, id: number): string => `${source}:${id}`;

export function parseQnaKey(key: string): { source: string; id: number } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { source: m[1], id: Number(m[2]) } : null;
}

export interface QnaRow {
  source: string;
  id: number;
  type: number | null;
  doc_number: string | null;
  date: string | null;
  title: string | null;
  rel_stds: string | null;
  type_title: string | null;
}

export function resolveOrg(r: Pick<QnaRow, "source" | "type" | "type_title">): string | null {
  if (r.type_title) return r.type_title;
  if (r.source === "legacy") return (r.type != null ? LEGACY_ORG[r.type] : undefined) ?? LEGACY_ORG_FALLBACK;
  return null;
}

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
