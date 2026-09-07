/**
 * 인증 정본 — /mcp 접근 판정의 전부가 이 파일에 있다.
 *
 * 판정 파이프라인: 익명 개방(로컬 opt-in 한정) → 관리자 토큰(timingSafeEqual) →
 * 발급 토큰 원격 검증(eocpa.kr/validate, fail-closed, 유효 5분·무효 1분 캐시).
 *
 * 불변식:
 *  - 설정 누락은 권한 사유가 아니다. MCP_TOKEN 이 비면 관리자 경로만 꺼지고 /mcp 는 계속 잠긴다.
 *  - 무인증 개방은 명시적 opt-in(MYKIFRS_ALLOW_ANONYMOUS=1) 뿐이고, 배포 환경
 *    (FLY_APP_NAME 존재)에서는 켜도 무시된다.
 *  - 검증 서버 오류·타임아웃·비정상 응답은 전부 차단(fail-closed)이며 부정 결과를 캐시하지
 *    않는다(일시 장애가 1분 차단으로 굳는 것을 막는다).
 *  - 관리자 토큰 비교는 타이밍 비의존. 미설정이면 항상 불일치.
 */
import { timingSafeEqual } from "node:crypto";
import { hashToken, type Session } from "../store/usage-db.js";

/** 무인증 개방 여부를 env 에서 접는다 — 배포 환경(Fly)에서는 opt-in 도 무시. */
export function resolveAnonymous(env: {
  MYKIFRS_ALLOW_ANONYMOUS?: string;
  FLY_APP_NAME?: string;
}): { allow: boolean; warn: string | null } {
  const requested = env.MYKIFRS_ALLOW_ANONYMOUS === "1";
  const onFly = Boolean(env.FLY_APP_NAME);
  if (requested && onFly)
    return { allow: false, warn: "MYKIFRS_ALLOW_ANONYMOUS 는 배포 환경에서 무시된다 — /mcp 는 토큰 필수" };
  return { allow: requested, warn: null };
}

export interface TokenGateConfig {
  /** 관리자 토큰(MCP_TOKEN). "" = 관리자 경로 비활성 — 개방 사유가 아니다. */
  adminToken: string;
  /** resolveAnonymous() 로 이미 접은 값. */
  allowAnonymous: boolean;
  /** 발급 토큰 검증 엔드포인트 (eocpa.kr/validate). */
  validateUrl: string;
  /** 테스트 주입점 — 기본 globalThis.fetch / Date.now. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const VALID_TTL_MS = 300_000; // 유효 5분
const INVALID_TTL_MS = 60_000; // 무효 1분
const CACHE_CAP = 5000;
const VALIDATE_TIMEOUT_MS = 10_000; // 검증 서버 콜드 웨이크 여유

export class TokenGate {
  private readonly cfg: TokenGateConfig;
  private readonly cache = new Map<string, { valid: boolean; exp: number }>();

  constructor(cfg: TokenGateConfig) {
    this.cfg = cfg;
  }

  /** 캐시 항목 수 — 상한(CACHE_CAP) 동작의 관측용. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 관리자 토큰 일치 여부(타이밍 비의존). MCP_TOKEN 미설정이면 항상 false — 미설정은 권한 사유가 아니다. */
  isAdmin(token: string): boolean {
    if (!this.cfg.adminToken || !token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.cfg.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** /mcp 접근 허용 여부. */
  async authorize(token: string): Promise<boolean> {
    if (this.cfg.allowAnonymous) return true; // 로컬 개발 전용 — 명시적 opt-in, 배포에선 무시됨
    if (!token) return false;
    if (this.isAdmin(token)) return true;

    const now = (this.cfg.now ?? Date.now)();
    const cached = this.cache.get(token);
    if (cached && cached.exp > now) return cached.valid;
    try {
      const doFetch = this.cfg.fetchImpl ?? fetch;
      const r = await doFetch(
        `${this.cfg.validateUrl}?key=${encodeURIComponent(token)}&svc=kifrs`,
        { signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) },
      );
      if (!r.ok) return false; // 검증 서버 오류 시 차단 (fail-closed) — 캐시하지 않는다
      const { valid } = (await r.json()) as { valid: boolean };
      this.cache.set(token, { valid, exp: now + (valid ? VALID_TTL_MS : INVALID_TTL_MS) });
      if (this.cache.size > CACHE_CAP) this.cache.clear();
      return valid;
    } catch (err) {
      console.error("토큰 검증 오류:", err);
      return false;
    }
  }

  /** 요청 1건의 로깅 세션 — 이용자=토큰 해시(원문 미저장), 운영자=관리자 토큰 일치만. */
  sessionFor(token: string, client?: string | null): Session {
    return {
      userHash: hashToken(token),
      isOwner: this.isAdmin(token),
      transport: "http",
      client,
    };
  }
}

/**
 * 요청에서 접속 토큰 추출. 우선순위: 커스텀 헤더(`x-eocpa-token` → `x-api-key`) → `Authorization: Bearer`
 * → `?key=`. 커스텀 헤더는 PlayMCP 처럼 Authorization 을 OAuth 전용으로 다루는 게이트웨이용이다 —
 * 같은 토큰을 어느 슬롯에 실어도 판정은 같다.
 */
export function extractToken(
  headers: { authorization?: string; "x-eocpa-token"?: string; "x-api-key"?: string },
  queryKey: unknown,
): string {
  const raw =
    headers["x-eocpa-token"] ||
    headers["x-api-key"] ||
    (headers.authorization ?? "").replace(/^Bearer\s+/i, "") ||
    (typeof queryKey === "string" ? queryKey : "");
  return raw.trim();
}

/**
 * 이 요청이 자격을 요구하는가 — `tools/call` 만 요구한다.
 *
 * `initialize`·`notifications/*`·`tools/list`·`ping` 은 프로토콜 핸드셰이크·디스커버리라 코퍼스를
 * 한 글자도 내주지 않는다. 그리고 커넥터(claude.ai 등)는 등록할 때 무자격으로 서버를 한 번
 * 찔러 보는데, 거기서 401 을 받으면 MCP 인가 스펙상 "인가 플로우를 개시하라"는 신호로 읽어
 * 「로그인 필요」를 붙인다. 배치 요청은 하나라도 `tools/call` 이면 자격을 요구한다.
 */
export function requiresCredential(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some((b) => (b as { method?: unknown } | null | undefined)?.method === "tools/call");
}

/**
 * 거부 응답의 상태코드 — 제시됐으나 거부된 자격은 401 이 아니라 403 이다.
 *
 * 401 은 MCP 인가 스펙이 인가 플로우 개시에 예약해 둔 코드라, SDK 클라이언트는 401 을 받으면 본문을
 * 버리고 OAuth 로 간다 — 원인("이 토큰은 유효하지 않다")이 이용자에게 닿지 않는다. 자격 **미제시**만
 * 401 로 남긴다.
 */
export function deniedStatus(token: string | undefined): 401 | 403 {
  return token ? 403 : 401;
}

/**
 * [MCP 스펙 MUST] /mcp Origin 헤더 검증 — DNS rebinding 방어(Streamable HTTP §Security).
 * 비브라우저 MCP 클라이언트(claude.ai 커넥터·Claude Code·Inspector CLI·PlayMCP 게이트웨이)는 Origin 을
 * 보내지 않으므로 **부재는 통과**가 스펙 정합이고, 이 함수는 '존재하는' Origin 만 판정한다.
 * rebinding 의 실질 표적은 로컬 HTTP 인스턴스라 localhost 계열(포트 무관)은 상시 허용, 원격 웹 기반
 * 클라이언트는 MCP_ALLOWED_ORIGINS(콤마 구분)로 명시 등재한다. 'null'·유사 도메인(localhost.evil.com)은 거부.
 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function isAllowedMcpOrigin(origin: string, extraAllowed: readonly string[] = []): boolean {
  const norm = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (LOCAL_ORIGIN_RE.test(norm)) return true;
  return extraAllowed.some((o) => o.trim().replace(/\/+$/, "").toLowerCase() === norm);
}

/** MCP_ALLOWED_ORIGINS 판독 — 콤마 구분, 공백·빈 항목 무시. */
export function allowedOriginsFromEnv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
