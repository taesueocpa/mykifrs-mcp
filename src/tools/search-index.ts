import type Database from "better-sqlite3";
import { hasTerm, idf, type QueryTerms, type RankStats } from "../search/rank.js";
import type { QnaRow } from "./qna-shared.js";

interface Doc {
  rowid: number;
  text: string;
  lower: string;
  head: string;
}

export interface ParagraphDoc extends Doc {
  std_num: number; std_title: string; category: string; unique_key: string; para_num: string | null;
  document_id: string | null; part_type: string | null;
}

export type QnaDoc = Doc & QnaRow;

export interface DocIndex<T extends Doc> {
  docs: T[];
  byRowid: Map<number, T>;
  avgLen: number;
  df: Map<string, number>;
}

const DF_CACHE_MAX = 5000;

const lowerOf = (s: string): string => {
  const l = s.toLowerCase();
  return l === s ? s : l;
};

function build<T extends Doc>(rows: Array<Omit<T, "lower" | "head"> & { headRaw: string | null }>): DocIndex<T> {
  const docs: T[] = [];
  let total = 0;
  for (const { headRaw, ...r } of rows) {
    const text = r.text ?? "";
    total += text.length;
    docs.push({ ...(r as unknown as T), text, lower: lowerOf(text), head: headRaw ? lowerOf(headRaw) : "" });
  }
  return {
    docs, byRowid: new Map(docs.map((d) => [d.rowid, d])), avgLen: docs.length ? total / docs.length : 1, df: new Map(),
  };
}

const cache = new WeakMap<Database.Database, { paragraphs?: DocIndex<ParagraphDoc>; qnas?: DocIndex<QnaDoc> }>();

function slot(db: Database.Database) {
  let s = cache.get(db);
  if (!s) {
    s = {};
    cache.set(db, s);
  }
  return s;
}

export function paragraphIndex(db: Database.Database): DocIndex<ParagraphDoc> {
  const s = slot(db);
  s.paragraphs ??= build<ParagraphDoc>(db.prepare(`
    SELECT ci.rowid AS rowid, ci.std_num, s.title AS std_title, s.category, ci.unique_key, ci.para_num, ci.document_id,
           part.document_type AS part_type, sec.title AS headRaw, ci.content_text AS text
    FROM content_items ci
    JOIN standards s ON s.std_num = ci.std_num
    LEFT JOIN sections sec ON sec.std_num = ci.std_num AND sec.document_id = ci.document_id
    LEFT JOIN sections part ON part.std_num = ci.std_num AND part.document_id = ci.part_document_id
    WHERE ci.item_type = 'paragraph'`).all() as never);
  return s.paragraphs;
}

export function qnaIndex(db: Database.Database): DocIndex<QnaDoc> {
  const s = slot(db);
  s.qnas ??= build<QnaDoc>(db.prepare(`
    SELECT qn.rowid AS rowid, qn.source, qn.id, qn.type, qn.doc_number, qn.date, qn.title, qn.rel_stds,
           t.title AS type_title, qn.title AS headRaw, qn.full_content AS text
    FROM qnas qn LEFT JOIN qna_types t ON t.type = qn.type`).all() as never);
  return s.qnas;
}

export function warmSearchIndex(db: Database.Database): void {
  paragraphIndex(db);
  qnaIndex(db);
}

export function findDocs<T extends Doc>(ix: DocIndex<T>, terms: readonly string[], keep?: (d: T) => boolean): T[] {
  const out: T[] = [];
  for (const d of ix.docs) {
    if (keep && !keep(d)) continue;
    if (terms.every((t) => hasTerm(d.lower, t) || hasTerm(d.head, t))) out.push(d);
  }
  return out;
}

export function rankStats<T extends Doc>(ix: DocIndex<T>, q: QueryTerms): RankStats {
  const out = new Map<string, number>();
  for (const t of q.terms) {
    let df = ix.df.get(t);
    if (df === undefined) {
      df = 0;
      for (const d of ix.docs) if (hasTerm(d.lower, t)) df++;
      if (ix.df.size >= DF_CACHE_MAX) ix.df.clear();
      ix.df.set(t, df);
    }
    out.set(t, idf(df, ix.docs.length));
  }
  return { idf: out, avgLen: ix.avgLen };
}
