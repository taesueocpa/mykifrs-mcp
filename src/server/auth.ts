import { timingSafeEqual } from "node:crypto";
import { hashToken, type Session } from "../store/usage-db.js";

// 배포 환경(FLY_APP_NAME)에서는 무인증 opt-in 을 무시한다
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
  adminToken: string;
  allowAnonymous: boolean;
  validateUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const VALID_TTL_MS = 300_000;
const INVALID_TTL_MS = 60_000;
const CACHE_CAP = 5000;
const VALIDATE_TIMEOUT_MS = 10_000;

export class TokenGate {
  private readonly cfg: TokenGateConfig;
  private readonly cache = new Map<string, { valid: boolean; exp: number }>();

  constructor(cfg: TokenGateConfig) {
    this.cfg = cfg;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  isAdmin(token: string): boolean {
    if (!this.cfg.adminToken || !token) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.cfg.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async authorize(token: string): Promise<boolean> {
    if (this.cfg.allowAnonymous) return true;
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
      if (!r.ok) return false; // 검증 서버 오류는 차단하고 캐시하지 않는다
      const { valid } = (await r.json()) as { valid: boolean };
      this.cache.set(token, { valid, exp: now + (valid ? VALID_TTL_MS : INVALID_TTL_MS) });
      if (this.cache.size > CACHE_CAP) this.cache.clear();
      return valid;
    } catch (err) {
      console.error("토큰 검증 오류:", err);
      return false;
    }
  }

  sessionFor(token: string, client?: string | null): Session {
    return {
      userHash: hashToken(token),
      isOwner: this.isAdmin(token),
      transport: "http",
      client,
    };
  }
}

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

// tools/call 만 자격을 요구한다. 커넥터는 등록할 때 자격 없이 tools/list 를 부른다
export function requiresCredential(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some((b) => (b as { method?: unknown } | null | undefined)?.method === "tools/call");
}

// 자격을 냈는데 거부되면 403. 401 은 클라이언트가 OAuth 시작으로 읽는다
export function deniedStatus(token: string | undefined): 401 | 403 {
  return token ? 403 : 401;
}

// DNS rebinding 방어. Origin 이 없는 요청은 통과, localhost 는 항상 허용
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function isAllowedMcpOrigin(origin: string, extraAllowed: readonly string[] = []): boolean {
  const norm = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (LOCAL_ORIGIN_RE.test(norm)) return true;
  return extraAllowed.some((o) => o.trim().replace(/\/+$/, "").toLowerCase() === norm);
}

export function allowedOriginsFromEnv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
