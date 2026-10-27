/**
 * 질의회신 효력 표시 — KASB 가 기준 제·개정에 맞춰 폐기·수정·공개제외한 회신을 공식 목록에서 뽑아 둔다.
 *
 * 정본은 materials 의 질의회신 정비목록(board='qna_maint') 두 종류다:
 *  - 일반기업회계기준 질의회신 정비목록 NN-N — 「폐기(N건)」·「수정(N건)」 절 아래 [GKQA..] 번호
 *  - 구 기업회계기준↔일반기업회계기준 질의회신 비교표 — 행마다 검토결과(공개유지·공개제외·수정공개·폐기)와 근거
 * 추정으로 표시하지 않는다 — 이 두 목록에 없는 회신은 표시하지 않는다(구 금감원 회신 등은 date 로 판단).
 *
 * qna_validity·material_validity 는 파생 데이터다. 원본(materials)이 바뀌면 rebuildValidity 로 다시 만든다 —
 * 수집·FTS 리빌드·테스트 픽스처가 같은 함수를 부른다(파생 로직은 한 곳에서만).
 */
import type Database from "better-sqlite3";

export interface Validity {
  status: string; // 폐기 | 수정 | 공개제외 | 수정공개
  basis: string;  // 근거 (정비목록 회차 또는 비교표 근거 문장)
  source: string; // 근거 자료의 material_key — get_material 로 전문을 본다
}

/** 표시된 회신에 붙는 소비 규칙 — 응답 legend 가 정본이다(get_paragraph 의 note 와 같은 방식). */
export const VALIDITY_NOTE =
  "KASB 가 현행 기준에 비추어 폐기·수정·공개제외한 회신 — 현행 회신으로 인용하지 말고 basis·source(get_material)를 확인할 것";

const DOC_RE = /\[(G?KQA\d{2}-\d{3,4})\]/g;

/** 정비목록 본문 → (번호, 조치). 절 머리 "N. 폐기(k건)"·"N. 수정(k건)" 이 다음 머리 전까지의 조치를 정한다. */
export function parseMaintenanceList(title: string, body: string): Array<{ doc: string; status: string; basis: string }> {
  const round = title.match(/정비목록\s*(\d+-\d+)/)?.[1] ?? "?";
  const out = new Map<string, { doc: string; status: string; basis: string }>();
  let act: string | null = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^#*\s*\d+\.\s*(폐기|수정)\s*\(\s*\d+\s*건\s*\)/);
    if (h) { act = h[1]; continue; }
    if (!act) continue;
    for (const m of line.matchAll(DOC_RE)) {
      const basis = act === "폐기"
        ? `일반기업회계기준 질의회신 정비목록 ${round}: 현행 회계기준에 비추어 유효하지 않아 폐기`
        : `일반기업회계기준 질의회신 정비목록 ${round}: 수정 — 수정 후 내용은 정비목록에 있다`;
      out.set(`${m[1]}|${act}`, { doc: m[1], status: act, basis });
    }
  }
  return [...out.values()];
}

/** 비교표(마크다운 표) → 공개유지가 아닌 행. 칸: 순번 | 제목 | 신규번호 | 기존번호 | 회신일 | 검토결과 | 근거.
 *  근거 앞머리는 자료 제목(title) 그대로다. */
export function parseComparisonTable(title: string, body: string): Array<{ doc: string; status: string; basis: string }> {
  const out: Array<{ doc: string; status: string; basis: string }> = [];
  for (const line of body.split("\n")) {
    const c = line.split("|").map((s) => s.trim());
    if (c.length < 8 || !/^G?KQA\d{2}-\d{3,4}$/.test(c[3])) continue;
    const status = c[6];
    if (!["공개제외", "수정공개", "폐기"].includes(status)) continue;
    // kordoc 이 셀 안 마크다운 기호를 이스케이프한다(\* \~ \_) — 근거 문장으로 읽히게 푼다
    const why = c[7].replace(/<br\s*\/?>/gi, " ").replace(/\\([*~_`|\\])/g, "$1").replace(/\s+/g, " ").trim();
    out.push({ doc: c[3], status, basis: `${title}: ${status}${why ? ` — ${why}` : ""}` });
  }
  return out;
}

/** 자료 효력 표시의 소비 규칙. */
export const MATERIAL_VALIDITY_NOTE =
  "효력 주의 자료(확정·대체된 초안, 시행 전 개정판, 개정판이 공표된 시행 중 판, 기준 개정 전 작성, 대체된 (구)기준서 기반 사례) — status·basis 를 확인하고 확정 기준서 본문(search_standards)·source 를 우선할 것";

/** 제목·본문 머리에서 K-IFRS 기준서 번호(제NNNN호). */
const stdNums = (s: string) => new Set([...s.matchAll(/제\s?(\d{4})호/g)].map((m) => m[1]));

/**
 * 자료 효력 표시.
 *  R1 확정 공표: (초안류 — 공개초안·IFRS 검토의견, 또는 제목이 공개초안·ED·검토의견인 행사자료) 다루는 기준서
 *     번호를 모두 포함하는 제·개정 공표(amend)가 그 뒤 날짜에 있다.
 *  R2 재공개초안으로 대체: (초안류) 같은 기준서 번호의 더 늦은 "재공개초안"이 있다.
 *  R3~R5 는 아래 각 블록 — KICPA 감사인증기준 판 짝, 외부 고시 실무지침서, (구)기준서 기반 KICPA 사례.
 * 정착지원TF·실무 분석은 대상이 아니다 — 같은 기준서가 나중에 개정됐다고 논의가 무효가 되지는 않는다
 * (R5 는 기준서가 개정이 아니라 통째로 대체된 경우만이다).
 * 공표 게시물이 없는 확정 건은 표시되지 않는다(근거 없이 추정하지 않는다).
 */
function deriveMaterialValidity(db: Database.Database): Array<{ board: string; id: number; status: string; basis: string; source: string }> {
  type M = { board: string; id: number; title: string; date: string | null; head: string };
  const all = db.prepare(`SELECT board, id, title, date, substr(COALESCE(body, ''), 1, 800) head FROM materials`).all() as M[];
  const nums = (m: M) => stdNums(`${m.title} ${m.head}`);
  const isDraft = (m: M) => m.board === "ed" || m.board === "comment"
    || (m.board === "event" && /공개초안|\bED\b|검토의견/.test(m.title));
  const amends = all.filter((m) => m.board === "amend" && m.date);
  const out: Array<{ board: string; id: number; status: string; basis: string; source: string }> = [];
  for (const d of all.filter((m) => isDraft(m) && m.date)) {
    const ns = nums(d);
    if (ns.size === 0) continue;
    for (const a of amends) {
      if (a.date! <= d.date!) continue;
      const an = nums(a);
      if ([...ns].every((n) => an.has(n)))
        out.push({ board: d.board, id: d.id, status: "확정 공표", source: `amend:${a.id}`,
          basis: `이후 ${[...ns].map((n) => `제${n}호`).join("·")}의 제·개정이 공표됨 — ${a.title} (${a.date})` });
    }
    for (const r of all.filter((m) => m.board === "ed" && m.date && m.date > d.date! && /재공개초안/.test(m.title))) {
      const rn = nums(r);
      if (rn.size && [...ns].every((n) => rn.has(n)))
        out.push({ board: d.board, id: d.id, status: "재공개초안으로 대체", source: `ed:${r.id}`,
          basis: `이후 재공개초안이 나옴 — ${r.title} (${r.date})` });
    }
  }

  // R3 감사인증기준(KICPA): 같은 기준에 "(시행 중)" 판과 "(시행 전)" 개정판이 함께 있으면 서로를 근거로 표시한다.
  const cats = db.prepare(`SELECT id, title, category FROM materials WHERE board = 'assure'`).all() as
    Array<{ id: number; title: string; category: string | null }>;
  for (const pre of cats.filter((m) => /시행\s*전/.test(m.title))) {
    const cur = cats.find((m) => m.category === pre.category && /시행\s*중/.test(m.title));
    out.push({ board: "assure", id: pre.id, status: "시행 전", source: `assure:${cur?.id ?? pre.id}`,
      basis: cur ? `아직 시행 전인 개정판 — 시행 전까지는 ${cur.title} 을 적용` : `아직 시행 전인 개정판 — ${pre.title}` });
    if (cur) out.push({ board: "assure", id: cur.id, status: "개정판 공표", source: `assure:${pre.id}`,
      basis: `시행 중인 판 — 개정판(${pre.title}) 시행 시 대체` });
  }

  // R4 외부 고시: 실무지침서가 같은 기준 고시의 최신 발령일보다 먼저 작성됐으면 개정 전 작성으로 표시한다.
  const ext = all.filter((m) => m.board === "ext_std" && m.date);
  const extCat = db.prepare(`SELECT category FROM materials WHERE board = 'ext_std' AND id = ?`);
  for (const g of ext.filter((m) => /실무지침/.test(m.title))) {
    const cat = (extCat.get(g.id) as { category: string | null } | undefined)?.category;
    const rule = ext.find((m) => m.id !== g.id && !/실무지침/.test(m.title)
      && (extCat.get(m.id) as { category: string | null } | undefined)?.category === cat && m.date! > g.date!);
    if (rule) out.push({ board: "ext_std", id: g.id, status: "기준 개정 전 작성", source: `ext_std:${rule.id}`,
      basis: `이후 ${cat ?? "기준"} 개정(발령 ${rule.date}) — 현행 고시를 우선할 것` });
  }

  // R5 KICPA 협의회 사례: 다루는 기준서(분류 칸의 4자리 번호)가 모두 대체된 (구)기준서면 표시한다 — 카탈로그가
  // 대체된 기준서에 "(구)" 를 붙인다(1011 건설계약·1017 리스·1018 수익·1104 보험계약). 1039 처럼 일부 조항이
  // 살아 있는 기준서는 (구) 가 아니라 대상이 아니다.
  const old = new Map((db.prepare(`SELECT std_num, title FROM standards WHERE title LIKE '(구)%'`).all() as
    Array<{ std_num: number; title: string }>).map((s) => [String(s.std_num), s.title]));
  const cases = db.prepare(`SELECT board, id, category FROM materials
    WHERE board = 'kicpa_council' AND category IS NOT NULL`).all() as
    Array<{ board: string; id: number; category: string }>;
  for (const c of cases) {
    const ns = [...new Set([...c.category.matchAll(/(?<![\d-])([12]\d{3})(?![\d-])/g)].map((m) => m[1]))];
    if (ns.length && ns.every((n) => old.has(n)))
      out.push({ board: c.board, id: c.id, status: "폐지 기준서 기반", source: `std:${ns.join(",")}`,
        basis: `다루는 기준서가 모두 대체됨 — ${ns.map((n) => `제${n}호 ${old.get(n)}`).join("·")}; 현행 기준서로 다시 확인할 것` });
  }
  return out;
}

/** qna_validity·material_validity 전체 재생성. unmatched = 목록에는 있는데 qnas 에 없는 번호(KASB 가 공개에서 내린 회신 등). */
export function rebuildValidity(db: Database.Database): { rows: number; materialRows: number; unmatched: string[] } {
  const lists = db.prepare(`SELECT id, title, body FROM materials WHERE board = 'qna_maint'`).all() as
    Array<{ id: number; title: string; body: string | null }>;
  const ins = db.prepare(`INSERT OR IGNORE INTO qna_validity (doc_number, status, basis, source) VALUES (?, ?, ?, ?)`);
  const has = db.prepare(`SELECT 1 FROM qnas WHERE doc_number = ? LIMIT 1`);
  const unmatched = new Set<string>();
  let rows = 0;
  db.transaction(() => {
    db.exec(`DELETE FROM qna_validity`);
    for (const l of lists) {
      const marks = /정비목록/.test(l.title) ? parseMaintenanceList(l.title, l.body ?? "")
        : /비교표/.test(l.title) ? parseComparisonTable(l.title, l.body ?? "") : [];
      for (const m of marks) {
        rows += ins.run(m.doc, m.status, m.basis, `qna_maint:${l.id}`).changes;
        if (!has.get(m.doc)) unmatched.add(m.doc);
      }
    }
  })();
  const insM = db.prepare(`INSERT OR IGNORE INTO material_validity (board, id, status, basis, source) VALUES (?, ?, ?, ?, ?)`);
  let materialRows = 0;
  db.transaction(() => {
    db.exec(`DELETE FROM material_validity`);
    for (const v of deriveMaterialValidity(db)) materialRows += insM.run(v.board, v.id, v.status, v.basis, v.source).changes;
  })();
  return { rows, materialRows, unmatched: [...unmatched].sort() };
}

/** 자료 키들 → 효력 표시. */
export function validityByMaterial(db: Database.Database, keys: Array<{ board: string; id: number }>): Map<string, Validity[]> {
  const out = new Map<string, Validity[]>();
  const q = db.prepare(`SELECT status, basis, source FROM material_validity WHERE board = ? AND id = ? ORDER BY source`);
  for (const k of keys) {
    const rows = q.all(k.board, k.id) as Validity[];
    if (rows.length) out.set(`${k.board}:${k.id}`, rows);
  }
  return out;
}

/** 번호들 → 효력 표시(없는 번호는 맵에 없다). */
export function validityByDoc(db: Database.Database, docs: Array<string | null>): Map<string, Validity[]> {
  const wanted = [...new Set(docs.filter((d): d is string => !!d))];
  const out = new Map<string, Validity[]>();
  if (wanted.length === 0) return out;
  const rows = db.prepare(`SELECT doc_number, status, basis, source FROM qna_validity
    WHERE doc_number IN (${wanted.map(() => "?").join(",")}) ORDER BY source, status`).all(...wanted) as
    Array<{ doc_number: string } & Validity>;
  for (const r of rows) {
    if (!out.has(r.doc_number)) out.set(r.doc_number, []);
    out.get(r.doc_number)!.push({ status: r.status, basis: r.basis, source: r.source });
  }
  return out;
}
