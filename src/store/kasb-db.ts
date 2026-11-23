import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CorpusError } from "../core/errors.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const DB_PATH = process.env.KASB_DB ?? join(DATA_DIR, "kasb.sqlite");

export const MATERIAL_BOARDS = {
  tf: { label: "정착지원TF 논의내용", tier: 1 },
  qc: { label: "품질관리실장 회의자료(K-IFRS 질의회신 요약)", tier: 1 },
  assure: { label: "감사인증·윤리기준(KICPA, 최신판 — 품질관리·검토·인증·윤리·가치평가서비스 수행기준 등)", tier: 1 },
  ext_std: { label: "외부 기관 기준·고시(공익법인·집합건물 회계처리기준, 분·반기 검토준칙, 공공감사기준 등)", tier: 1 },
  qna_maint: { label: "질의회신 정비목록", tier: 2 },
  project: { label: "제정개정과제", tier: 2 },
  ed: { label: "공개초안", tier: 2 },
  amend: { label: "제·개정 공표", tier: 2 },
  glossary: { label: "K-IFRS 주요용어", tier: 2 },
  kicpa_council: { label: "전·당기 감사인 의견불일치 조정 협의회 사례(KICPA)", tier: 2 },
  valuation: { label: "가치평가 자료실(KICPA — 위험 프리미엄·IVS·외부평가 서식)", tier: 2 },
} as const satisfies Record<string, { label: string; tier: 1 | 2 }>;
export type MaterialBoard = keyof typeof MATERIAL_BOARDS;
export const MATERIAL_BOARD_KEYS = Object.keys(MATERIAL_BOARDS) as [MaterialBoard, ...MaterialBoard[]];
export const TIER1_BOARDS = MATERIAL_BOARD_KEYS.filter((k) => MATERIAL_BOARDS[k].tier === 1);

export const STANDARD_CATEGORIES = {
  kifrs: "한국채택국제회계기준",
  interpretation: "해석서",
  concept: "재무보고를 위한 개념체계",
  translation: "번역본",
  kgaap: "일반기업회계기준",
  special: "특수분야",
  audit: "감사기준서",
  icfr: "내부회계관리제도",
  sme: "중소기업회계기준",
  nonprofit: "비영리조직회계기준",
  assurance: "검토·인증업무 기준(목록만)",
  other: "기업회계기준 전문·적용의견서·회계감사실무지침·행동강령",
} as const;
export type StandardCategory = keyof typeof STANDARD_CATEGORIES;
export const STANDARD_CATEGORY_KEYS = Object.keys(STANDARD_CATEGORIES) as [StandardCategory, ...StandardCategory[]];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS standards (
  std_num      INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL,
  in_scope     INTEGER NOT NULL DEFAULT 1,
  crawl_status TEXT,
  crawled_at   TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  std_num       INTEGER NOT NULL,
  document_id   TEXT NOT NULL,
  level         INTEGER,
  title         TEXT,
  ref           TEXT,
  document_type TEXT,
  is_hidden     INTEGER,
  sort          INTEGER,
  parent_ids    TEXT,
  PRIMARY KEY (std_num, document_id)
);

CREATE TABLE IF NOT EXISTS content_items (
  std_num          INTEGER NOT NULL,
  part_document_id TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  item_type        TEXT NOT NULL,
  unique_key       TEXT,
  para_num         TEXT,
  document_id      TEXT,
  level            INTEGER,
  title            TEXT,
  ref              TEXT,
  content_html     TEXT,
  content_text     TEXT,
  faq_doc_numbers  TEXT,
  sort             INTEGER,
  PRIMARY KEY (std_num, part_document_id, seq)
);

CREATE TABLE IF NOT EXISTS qnas (
  source       TEXT NOT NULL,
  id           INTEGER NOT NULL,
  type         INTEGER,
  doc_number   TEXT,
  date         TEXT,
  title        TEXT,
  rel_stds     TEXT,
  full_content TEXT,
  question     TEXT,
  answer       TEXT,
  reason       TEXT,
  raw_json     TEXT NOT NULL,
  crawled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, id)
);

CREATE TABLE IF NOT EXISTS qna_types (
  type          INTEGER PRIMARY KEY,
  facility_type INTEGER,
  standard_type INTEGER,
  title         TEXT,
  sort          INTEGER
);

CREATE TABLE IF NOT EXISTS materials (
  board      TEXT NOT NULL,
  id         INTEGER NOT NULL,
  category   TEXT,
  title      TEXT NOT NULL,
  date       TEXT,
  url        TEXT NOT NULL,
  body       TEXT,
  files      TEXT NOT NULL,
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (board, id)
);

CREATE TABLE IF NOT EXISTS qna_validity (
  doc_number TEXT NOT NULL,
  status     TEXT NOT NULL,
  basis      TEXT NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (doc_number, status, source)
);

CREATE TABLE IF NOT EXISTS material_validity (
  board  TEXT NOT NULL,
  id     INTEGER NOT NULL,
  status TEXT NOT NULL,
  basis  TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (board, id, status, source)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_items_std ON content_items(std_num);
CREATE INDEX IF NOT EXISTS idx_content_items_key ON content_items(unique_key);
CREATE INDEX IF NOT EXISTS idx_qnas_doc_number ON qnas(doc_number);
CREATE INDEX IF NOT EXISTS idx_qnas_type ON qnas(type);
`;

export function openForIngest(path: string = DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function openCorpus(path: string = DB_PATH): Database.Database {
  if (!existsSync(path))
    throw new CorpusError(`kasb.sqlite 없음: ${path} (KASB_DB 로 경로 지정)`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const fts = db
    .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('content_fts','qna_fts','material_fts')`)
    .get() as { n: number };
  if (fts.n < 3) {
    db.close();
    throw new CorpusError("FTS 인덱스 없음 — rebuildFts() 로 인덱스를 먼저 만들 것");
  }
  return db;
}

export function rebuildFts(db: Database.Database): { contentRows: number; qnaRows: number; materialRows: number } {
  const known = MATERIAL_BOARD_KEYS.map(() => "?").join(", ");
  db.prepare(`DELETE FROM material_validity WHERE board NOT IN (${known})`).run(...MATERIAL_BOARD_KEYS);
  db.prepare(`DELETE FROM materials WHERE board NOT IN (${known})`).run(...MATERIAL_BOARD_KEYS);
  db.exec(`
DROP TABLE IF EXISTS content_fts;
DROP TABLE IF EXISTS qna_fts;
DROP TABLE IF EXISTS material_fts;

CREATE VIRTUAL TABLE content_fts USING fts5(
  title,
  content_text,
  std_num UNINDEXED,
  unique_key UNINDEXED,
  item_type UNINDEXED,
  content='content_items',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE qna_fts USING fts5(
  title,
  full_content,
  doc_number UNINDEXED,
  source UNINDEXED,
  content='qnas',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE material_fts USING fts5(
  title,
  body,
  board UNINDEXED,
  content='materials',
  tokenize='trigram'
);
`);
  for (const t of ["content_fts", "qna_fts", "material_fts"]) {
    db.exec(`INSERT INTO ${t}(${t}) VALUES('rebuild')`);
    db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
  }
  const rows = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  return { contentRows: rows("content_fts"), qnaRows: rows("qna_fts"), materialRows: rows("material_fts") };
}
