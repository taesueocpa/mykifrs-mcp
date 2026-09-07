/**
 * kasb.sqlite — read-only 코퍼스(usage.sqlite 와 분리).
 *
 *  - openForIngest(): 쓰기 모드 + 스키마 보장(코퍼스를 직접 구축할 때).
 *  - openCorpus(): 서버용. read-only + 부팅 검증(파일 존재·FTS 인덱스 존재) — 실패하면
 *    CorpusError 를 던져 부팅을 중단한다.
 *  - rebuildFts(): external content FTS 는 원본 테이블 변경 후 전체 리빌드해야 하는 파생 데이터다.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CorpusError } from "../core/errors.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
/** 배포 이미지 등에서는 KASB_DB 로 재지정. 로컬 기본은 ./data/kasb.sqlite. */
export const DB_PATH = process.env.KASB_DB ?? join(DATA_DIR, "kasb.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS standards (
  std_num      INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL,        -- concept|kifrs|interpretation|translation|kgaap|esg|special|icfr|audit|assurance|other
  in_scope     INTEGER NOT NULL DEFAULT 1,
  crawl_status TEXT,                 -- ok | empty | error:<메시지>
  crawled_at   TEXT
);

-- 목차: /api/standard-indexes/{stdNum} 응답 원본
CREATE TABLE IF NOT EXISTS sections (
  std_num       INTEGER NOT NULL,
  document_id   TEXT NOT NULL,
  level         INTEGER,
  title         TEXT,
  ref           TEXT,
  document_type TEXT,                -- level 0 루트에만 값 존재 (body-introduction 등)
  is_hidden     INTEGER,
  sort          INTEGER,
  parent_ids    TEXT,                -- JSON 배열
  PRIMARY KEY (std_num, document_id)
);

-- 본문: /api/paragraphs/{stdNum}/{level0 documentId} 응답을 문서 순서대로 평탄화.
-- item_type='title'은 중간 제목, 'paragraph'는 실제 문단.
CREATE TABLE IF NOT EXISTS content_items (
  std_num          INTEGER NOT NULL,
  part_document_id TEXT NOT NULL,    -- level 0 루트 (본문/적용사례/결론도출근거/기타)
  seq              INTEGER NOT NULL, -- 응답 배열 내 순서
  item_type        TEXT NOT NULL,
  unique_key       TEXT,             -- 예: "1116-9" (paragraph만)
  para_num         TEXT,
  document_id      TEXT,             -- 소속 섹션
  level            INTEGER,          -- title만
  title            TEXT,
  ref              TEXT,
  content_html     TEXT,
  content_text     TEXT,
  faq_doc_numbers  TEXT,             -- 관련 질의회신 docNumber CSV (기준서 문단 ↔ QnA 상호참조)
  sort             INTEGER,
  PRIMARY KEY (std_num, part_document_id, seq)
);

-- 질의회신: source='v2'(/api/qnas/v2, 회계기준원·금감원·신속처리·IFRS IC)
--          source='legacy'(/api/qnas, 구 QnA·IFRS IC 아젠다 결정 등)
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
  raw_json     TEXT NOT NULL,        -- 응답 레코드 원본 (스키마 확장 대비)
  crawled_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, id)
);

CREATE TABLE IF NOT EXISTS qna_types (
  type          INTEGER PRIMARY KEY,
  facility_type INTEGER,             -- 1=회계기준원/IFRS IC, 2=금융감독원
  standard_type INTEGER,             -- 1=K-IFRS, 2=일반기업회계기준
  title         TEXT,
  sort          INTEGER
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

/** 수집용: 쓰기 모드로 열고 스키마를 보장한다. */
export function openForIngest(path: string = DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/**
 * 서버용: read-only 로 열고 부팅 가능 상태를 검증한다.
 * 실패는 CorpusError — message 가 곧 복구 안내다.
 */
export function openCorpus(path: string = DB_PATH): Database.Database {
  if (!existsSync(path))
    throw new CorpusError(`kasb.sqlite 없음: ${path} (KASB_DB 로 경로 지정)`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const fts = db
    .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('content_fts','qna_fts')`)
    .get() as { n: number };
  if (fts.n < 2) {
    db.close();
    throw new CorpusError("FTS 인덱스 없음 — rebuildFts() 로 인덱스를 먼저 만들 것");
  }
  return db;
}

/**
 * FTS5 인덱스 전체 리빌드 (파생 데이터 — 원본 테이블 변경 후 재실행).
 *
 * - trigram 토크나이저: 한국어 조사·복합명사 대응 (형태소 분석기 불필요).
 *   주의: MATCH 는 3글자 이상 질의만 지원. 2글자 이하는 LIKE 보조 필터로 질의한다
 *   (src/search/query.ts 의 splitQuery 가 그 분배를 소유한다).
 * - external content 방식: 원문을 복제하지 않고 content_items/qnas 를 참조한다.
 */
export function rebuildFts(db: Database.Database): { contentRows: number; qnaRows: number } {
  db.exec(`
DROP TABLE IF EXISTS content_fts;
DROP TABLE IF EXISTS qna_fts;

CREATE VIRTUAL TABLE content_fts USING fts5(
  title,                -- 섹션 제목 (item_type='title' 행)
  content_text,         -- 문단 평문 (item_type='paragraph' 행)
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
`);
  db.exec(`INSERT INTO content_fts(content_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO qna_fts(qna_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO content_fts(content_fts) VALUES('optimize')`);
  db.exec(`INSERT INTO qna_fts(qna_fts) VALUES('optimize')`);
  const contentRows = (db.prepare(`SELECT COUNT(*) n FROM content_fts`).get() as { n: number }).n;
  const qnaRows = (db.prepare(`SELECT COUNT(*) n FROM qna_fts`).get() as { n: number }).n;
  return { contentRows, qnaRows };
}
