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

/**
 * materials.board 코드 사전 — 수집(ingest/crawl-web·crawl-kicpa)과 도구(search_materials·get_material)가 함께
 * 쓰는 정본. 값을 늘리면 수집 설정과 도구 [Response] 가 이 표에서 같이 따라온다. 여기서 뺀 코드의 행은
 * rebuildFts 가 지운다(지속가능성 공시 자료와 KASB·KICPA 잡지 기고문 — 기고자료·회계기준원 기고문·IFRS 실무사례 —
 * 는 수록 범위 밖이다).
 *
 * tier — 근거의 층: 1 = 1차 근거(기준·고시 원문, 정착지원TF, 품질관리실장 회의자료 — 기준서·질의회신과 같은 층),
 * 2 = 보조(교육·사례·초안·동향·과제). 1-tier 는 핵심 검색 도구에 같이 실린다 — 정착지원TF·품질관리실장 회의자료는
 * search_qnas, 기준·고시 원문은 search_standards(tools/material-shared 의 PRACTICE_BOARDS·STANDARD_BOARDS).
 * search_materials 는 2-tier 만 검색한다.
 */
export const MATERIAL_BOARDS = {
  // ── 1-tier ──
  tf: { label: "정착지원TF 논의내용", tier: 1 },
  qc: { label: "품질관리실장 회의자료(K-IFRS 질의회신 요약)", tier: 1 },
  assure: { label: "감사인증·윤리기준(KICPA, 최신판 — 품질관리·검토·인증·윤리·가치평가서비스 수행기준 등)", tier: 1 },
  ext_std: { label: "외부 기관 기준·고시(공익법인·집합건물 회계처리기준, 분·반기 검토준칙, 공공감사기준 등)", tier: 1 },
  // ── 2-tier ──
  qna_maint: { label: "질의회신 정비목록", tier: 2 },
  edu: { label: "질의회신 교육자료", tier: 2 },
  project: { label: "제정개정과제", tier: 2 },
  consult: { label: "의견조회", tier: 2 },
  ed: { label: "공개초안", tier: 2 },
  comment: { label: "IFRS 검토의견", tier: 2 },
  trend: { label: "IASB 동향", tier: 2 },
  amend: { label: "제·개정 공표", tier: 2 },
  research: { label: "연구보고서·KARI Report", tier: 2 },
  glossary: { label: "K-IFRS 주요용어", tier: 2 },
  event: { label: "세미나·KAI Forum", tier: 2 },
  // 한국공인회계사회(KICPA) — ingest/crawl-kicpa
  kicpa_council: { label: "전·당기 감사인 의견불일치 조정 협의회 사례(KICPA)", tier: 2 },
  valuation: { label: "가치평가 자료실(KICPA — 위험 프리미엄·IVS·외부평가 서식)", tier: 2 },
} as const satisfies Record<string, { label: string; tier: 1 | 2 }>;
export type MaterialBoard = keyof typeof MATERIAL_BOARDS;
export const MATERIAL_BOARD_KEYS = Object.keys(MATERIAL_BOARDS) as [MaterialBoard, ...MaterialBoard[]];
export const TIER1_BOARDS = MATERIAL_BOARD_KEYS.filter((k) => MATERIAL_BOARDS[k].tier === 1);

/**
 * standards.category 사전 — 수집 카탈로그(ingest/catalog)·list_standards [Response]·search_standards category 인자가
 * 함께 쓰는 정본. assurance 는 KASB 열람서비스에 목록만 있고 본문이 없다 — 본문은 KICPA 판(materials assure)이다.
 */
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
  category     TEXT NOT NULL,        -- concept|kifrs|interpretation|translation|kgaap|special|icfr|audit|assurance|sme|nonprofit|other
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

-- KASB 홈페이지(www.kasb.or.kr) 자료: 정착지원TF·질의회신 정비목록·질의회신 교육·제정개정과제·의견조회·
-- 기고자료 + KICPA 게시판·외부 기관 고시. 회신이 아니라서 qnas 와 나눈다. body 는 상세 본문 + 첨부 파싱 본문
-- (첨부마다 "[첨부] 파일명" 머리). id 는 원천 게시물 번호(KASB seq·KICPA bltnNo·법령정보센터 일련번호) —
-- 게시판(board)마다 번호 공간이 따로다.
CREATE TABLE IF NOT EXISTS materials (
  board      TEXT NOT NULL,
  id         INTEGER NOT NULL,
  category   TEXT,                   -- 분류·관련기준서 (예: "제1118호 재무제표 표시와 공시", "ISSB 회의결과")
  title      TEXT NOT NULL,
  date       TEXT,                   -- 등록일 YYYY-MM-DD (과제 페이지는 NULL)
  url        TEXT NOT NULL,          -- 상세 페이지
  body       TEXT,
  files      TEXT NOT NULL,          -- JSON [{name, parsed}] — parsed=false 면 본문 미추출(형식 미지원 등)
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (board, id)
);

-- 질의회신 효력 표시 — 정비목록·비교표에서 파생(src/store/validity.ts rebuildValidity). 회신 하나에 여러 근거가 붙을 수 있다.
CREATE TABLE IF NOT EXISTS qna_validity (
  doc_number TEXT NOT NULL,
  status     TEXT NOT NULL,          -- 폐기 | 수정 | 공개제외 | 수정공개
  basis      TEXT NOT NULL,
  source     TEXT NOT NULL,          -- 근거 자료의 material_key (qna_maint:{id})
  PRIMARY KEY (doc_number, status, source)
);

-- 자료 효력 표시 — 확정 공표·재공개초안으로 대체된 공개초안·검토의견 등(src/store/validity.ts rebuildValidity).
CREATE TABLE IF NOT EXISTS material_validity (
  board  TEXT NOT NULL,
  id     INTEGER NOT NULL,
  status TEXT NOT NULL,              -- 확정 공표 | 재공개초안으로 대체 | 시행 전 | 개정판 공표 | 기준 개정 전 작성 | 폐지 기준서 기반
  basis  TEXT NOT NULL,
  source TEXT NOT NULL,              -- 근거 자료의 material_key (amend:{id} · ed:{id}) 또는 std:{기준서 번호}
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
    .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('content_fts','qna_fts','material_fts')`)
    .get() as { n: number };
  if (fts.n < 3) {
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
 * - external content 방식: 원문을 복제하지 않고 content_items/qnas/materials 를 참조한다 — 원본 행의
 *   rowid 를 가리키므로, 원본을 DELETE→INSERT 하는 수집(기준서 크롤)은 끝에 반드시 이 함수를 불러야 한다.
 *   건너뛰면 검색이 "fts5: missing row" 로 죽는다.
 */
export function rebuildFts(db: Database.Database): { contentRows: number; qnaRows: number; materialRows: number } {
  // 사전(MATERIAL_BOARDS)에서 뺀 게시판의 행 — 도구가 열 수 없는 행을 색인에 남기지 않는다.
  const known = MATERIAL_BOARD_KEYS.map(() => "?").join(", ");
  db.prepare(`DELETE FROM material_validity WHERE board NOT IN (${known})`).run(...MATERIAL_BOARD_KEYS);
  db.prepare(`DELETE FROM materials WHERE board NOT IN (${known})`).run(...MATERIAL_BOARD_KEYS);
  db.exec(`
DROP TABLE IF EXISTS content_fts;
DROP TABLE IF EXISTS qna_fts;
DROP TABLE IF EXISTS material_fts;

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
