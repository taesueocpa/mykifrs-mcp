/**
 * 회계기준원·공인회계사회 자료 도구 공유 — search_materials·get_material 이 함께 쓴다.
 *
 * material_key("{board}:{id}")가 행의 유일 식별자다. id 는 원천 게시물 번호(KASB seq·KICPA bltnNo 등)라
 * 게시판마다 번호 공간이 따로라서 board 를 붙인 키만 단건을 특정한다(qna_key 와 같은 이유).
 * 게시판 코드·라벨의 정본은 store 의 MATERIAL_BOARDS 하나다 — 입력 enum·[Response] 사전·키 검증이 모두 파생.
 */
import type Database from "better-sqlite3";
import { MATERIAL_BOARDS, MATERIAL_BOARD_KEYS, TIER1_BOARDS, type MaterialBoard } from "../store/kasb-db.js";
import { MATERIAL_VALIDITY_NOTE, type Validity } from "../store/validity.js";

/**
 * 실무 해석 게시판(정착지원TF·품질관리실장 회의자료) — 질의회신과 같은 층이라 search_qnas 가 회신과 한 목록으로
 * 검색하고, search_materials 의 검색 대상에서는 뺀다(찾는 길을 하나로). 전문은 get_material 로 연다.
 */
export const PRACTICE_BOARDS: readonly MaterialBoard[] = ["tf", "qc"];
/** 기준·고시 원문 게시판(감사인증·윤리기준, 외부 기관 고시) — search_standards 가 기준서 문단과 한 목록으로 검색한다. */
export const STANDARD_BOARDS: readonly MaterialBoard[] = ["assure", "ext_std"];
/** search_materials 가 검색하는 게시판 = 사전 − 핵심 도구에 실린 1-tier 게시판 = 2-tier. */
export const SEARCHABLE_BOARDS = MATERIAL_BOARD_KEYS
  .filter((k) => !PRACTICE_BOARDS.includes(k) && !STANDARD_BOARDS.includes(k)) as [MaterialBoard, ...MaterialBoard[]];

export type Scored<T> = { score: number | null; material: boolean; item: T };

/**
 * 핵심 검색(기준서 문단·회신)과 함께 실린 1-tier 자료를 한 목록으로. 점수(bm25, 작을수록 적합)가 있으면 한 줄로
 * 세우고, 없으면(LIKE 경로) 본래 결과 뒤에 붙인다. bm25 는 색인마다 통계가 달라 비교가 근사이고 본문이 긴 자료는
 * 늘 뒤로 밀린다("영업손익" — 1118 TF 가 30건 중 27위) — 걸린 자료는 min(min, limit/3) 건까지 본래 결과의 꼬리를
 * 밀어내고 자리를 지킨다(점수로 들어온 것도 센다, 점수 순서는 유지). min 은 도구가 정한다 — 회신 옆 실무 해석은 3,
 * 문단 옆 기준 원문은 1(검색어와 약하게 걸린 원문이 문단을 여럿 밀어내지 않게; 더 보려면 category 로 좁힌다).
 */
export function mergeWithFloor<T>(primary: Scored<T>[], materials: Scored<T>[], limit: number, scored: boolean,
  min = 3): T[] {
  const byScore = (a: Scored<T>, b: Scored<T>) => (a.score ?? 0) - (b.score ?? 0);
  const top = (scored ? [...primary, ...materials].sort(byScore) : [...primary, ...materials]).slice(0, limit);
  const floor = Math.min(min, Math.floor(limit / 3), materials.length);
  for (const m of materials) {
    if (top.filter((x) => x.material).length >= floor) break;
    if (top.includes(m)) continue;
    const worst = top.map((x) => x.material).lastIndexOf(false);
    if (worst < 0) break;
    top.splice(worst, 1, m);
  }
  return (scored ? top.sort(byScore) : top).map((x) => x.item);
}

export interface MaterialHit {
  board: string; id: number; category: string | null; date: string | null; title: string; tier: 1 | 2;
  /** FTS bm25 점수(작을수록 적합) — 3글자 미만 토큰만이면 null */
  score: number | null;
  snippet: string | null;
}

/**
 * 자료 검색 — search_materials 와 search_qnas(실무 해석)가 같은 질의 규칙을 쓴다: tier 1 먼저, 같은 tier 안에서는
 * FTS rank(3글자 미만 토큰만이면 최신순).
 */
export function searchMaterialRows(
  corpus: Database.Database, q: { match: string | null; short: string[] },
  opts: { boards?: readonly string[]; tier?: 1 | 2; limit: number },
): MaterialHit[] {
  const tierSql = `CASE WHEN m.board IN (${TIER1_BOARDS.map(() => "?").join(", ")}) THEN 1 ELSE 2 END`;
  const conds: string[] = [];
  const params: unknown[] = [...TIER1_BOARDS];
  if (q.match) { conds.push("material_fts MATCH ?"); params.push(q.match); }
  for (const s of q.short) { conds.push("(m.body LIKE ? OR m.title LIKE ?)"); params.push(`%${s}%`, `%${s}%`); }
  if (opts.boards?.length) { conds.push(`m.board IN (${opts.boards.map(() => "?").join(", ")})`); params.push(...opts.boards); }
  if (opts.tier) { conds.push(`${tierSql} = ?`); params.push(...TIER1_BOARDS, opts.tier); }
  params.push(opts.limit);
  return corpus.prepare(`
    SELECT m.board, m.id, m.category, m.date, m.title, ${tierSql} AS tier,
           ${q.match ? "bm25(material_fts)" : "NULL"} AS score,
           snippet(material_fts, 1, '⟦', '⟧', '…', 24) AS snippet
    FROM material_fts f
    JOIN materials m ON m.rowid = f.rowid
    WHERE ${conds.join(" AND ")}
    ORDER BY tier, ${q.match ? "rank" : "m.date DESC"} LIMIT ?`).all(...params) as MaterialHit[];
}

/** 효력 표시 — 효력 주의 자료(validity.ts R1~R5)에만 붙는다(소비 규칙은 note 로 응답에 싣는다). */
export function materialValidityField(v: Validity[] | undefined): { validity?: { note: string; marks: Validity[] } } {
  return v && v.length ? { validity: { note: MATERIAL_VALIDITY_NOTE, marks: v } } : {};
}

const KEY_RE = new RegExp(`^(${MATERIAL_BOARD_KEYS.join("|")}):(\\d+)$`);

export const materialKey = (board: string, id: number): string => `${board}:${id}`;

/** "{board}:{id}" 를 분해한다 — 모르는 게시판·형식 오류는 null. */
export function parseMaterialKey(key: string): { board: MaterialBoard; id: number } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { board: m[1] as MaterialBoard, id: Number(m[2]) } : null;
}

/** search_materials board 입력 describe 용 게시판 사전 — "qna_maint(질의회신 정비목록) · …" */
export const BOARD_LEGEND = SEARCHABLE_BOARDS.map((k) => `${k}(${MATERIAL_BOARDS[k].label})`).join(" · ");
