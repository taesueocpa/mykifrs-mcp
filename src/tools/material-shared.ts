import type Database from "better-sqlite3";
import { MATERIAL_BOARDS, MATERIAL_BOARD_KEYS, TIER1_BOARDS, type MaterialBoard } from "../store/kasb-db.js";
import { MATERIAL_VALIDITY_NOTE, type Validity } from "../store/validity.js";

export const PRACTICE_BOARDS: readonly MaterialBoard[] = ["tf", "qc"];
export const STANDARD_BOARDS: readonly MaterialBoard[] = ["assure", "ext_std"];
export const SEARCHABLE_BOARDS = MATERIAL_BOARD_KEYS
  .filter((k) => !PRACTICE_BOARDS.includes(k) && !STANDARD_BOARDS.includes(k)) as [MaterialBoard, ...MaterialBoard[]];

export type Scored<T> = { score: number | null; material: boolean; item: T };

// bm25 는 본문이 긴 자료를 뒤로 민다. 자료가 결과에 최소 floor 건은 남게 한다
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
  score: number | null;
  snippet: string | null;
}

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

export function materialValidityField(v: Validity[] | undefined): { validity?: { note: string; marks: Validity[] } } {
  return v && v.length ? { validity: { note: MATERIAL_VALIDITY_NOTE, marks: v } } : {};
}

const KEY_RE = new RegExp(`^(${MATERIAL_BOARD_KEYS.join("|")}):(\\d+)$`);

export const materialKey = (board: string, id: number): string => `${board}:${id}`;

export function parseMaterialKey(key: string): { board: MaterialBoard; id: number } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { board: m[1] as MaterialBoard, id: Number(m[2]) } : null;
}

export const BOARD_LEGEND = SEARCHABLE_BOARDS.map((k) => `${k}(${MATERIAL_BOARDS[k].label})`).join(" · ");
