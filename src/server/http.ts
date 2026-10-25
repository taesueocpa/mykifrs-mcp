/**
 * 원격 HTTP 모드 — Express 조립·배선만 (Streamable HTTP, stateless).
 *
 * 경로:
 *  - POST /mcp          메인 채널 — 무절단(전문·문맥을 그대로 돌려준다)
 *  - POST /mcp/playmcp  PlayMCP 채널 — 응답 예산 가드 + 채널 기본값 + 운영 도구 미등록
 *                       (playmcp-profile.ts). PlayMCP 등록 URL 은 이 경로를 가리킨다.
 *  - GET  /health       공개 헬스체크 · GET / → eocpa.kr/mykifrs 301
 *
 * 두 MCP 경로의 차이는 프로필뿐이다 — Origin 검증·인증 게이트·usage 로깅은 공통이다.
 * 두 경로 모두 dual-era 다: SDK 의 `isLegacyRequest` 로 가려, 모던(MCP 2026-07-28)은
 * `createMcpHandler` 레그가, 2025-era(`initialize` 핸드셰이크)는 Streamable HTTP 전송 레그가 맡는다.
 * 두 레그 모두 같은 팩토리(build-server.ts)가 만든 서버를 쓴다 — 도구 정의는 한 곳이다.
 * usage 는 두 층이다: 도구 호출은 dispatch.ts 가 tool_calls 에, /mcp 요청 전량(Origin 403·401·403·
 * 405 포함)은 이 파일의 logMcpRequest 가 mcp_requests 에 남긴다.
 * `tools/call` 만 토큰을 요구한다: 관리자 토큰(MCP_TOKEN) 또는 eocpa.kr 발급 토큰.
 * 판정 로직은 전부 src/server/auth.ts 소관 — 이 파일은 순서 배선만 소유한다.
 *
 * 접속: https://mykifrs.eocpa.kr/mcp?key=<토큰>  또는  Authorization: Bearer <토큰>
 *      (커스텀 헤더 x-eocpa-token 도 같은 슬롯 — auth.ts extractToken)
 */
import express from "express";
import type Database from "better-sqlite3";
import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { openCorpus } from "../store/kasb-db.js";
import { UsageDb } from "../store/usage-db.js";
import { buildServer } from "./build-server.js";
import {
  TokenGate, extractToken, resolveAnonymous, requiresCredential, deniedStatus, isAllowedMcpOrigin, allowedOriginsFromEnv,
} from "./auth.js";
import type { McpProfile } from "./playmcp-profile.js";

export interface AppDeps {
  corpus: Database.Database;
  usage: UsageDb;
  gate: TokenGate;
  /** /mcp Origin 허용목록(MCP_ALLOWED_ORIGINS) — localhost 계열은 목록과 무관하게 항상 허용. */
  allowedOrigins?: readonly string[];
}

/**
 * 실제 클라이언트 IP — Fly 프록시 뒤에서는 req.ip 가 프록시 내부 주소라 전 이용자가 한 값으로 뭉친다.
 * Fly 가 엣지에서 덮어쓰는 Fly-Client-IP 를 먼저 보고, 헤더가 없으면(로컬) 소켓 주소로 떨어진다.
 */
export function clientIp(req: express.Request): string {
  return (req.headers["fly-client-ip"] as string | undefined) || req.ip || req.socket.remoteAddress || "unknown";
}

/** Express 앱 조립. */
export function createApp({ corpus, usage, gate, allowedOrigins = [] }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  // /mcp 요청 로그(usage mcp_requests) — 응답이 확정될 때 1행. 요청 하나가 지나는 세 갈래(Origin 403 ·
  // POST 핸들러 · GET/DELETE 405) 중 정확히 한 곳에서만 건다. 응답 전에 끊긴 연결은 finish 가 안 나
  // 남지 않는다. 폭주는 UsageDb 의 IP 당 분당 상한이 끊는다.
  const logMcpRequest = (req: express.Request, res: express.Response, token: string) => {
    const startedAt = Date.now();
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const rpc = typeof body?.method === "string" ? (body.method as string) : null;
    const method = req.method === "POST" ? rpc : req.method;
    const tool = rpc === "tools/call" && typeof body?.params?.name === "string" ? (body.params.name as string) : null;
    res.once("finish", () => {
      usage.recordMcpRequest({
        method,
        tool,
        status: res.statusCode,
        token,
        isOwner: gate.isAdmin(token),
        ip: clientIp(req),
        ua: req.headers["user-agent"],
        durationMs: Date.now() - startedAt,
      });
    });
  };

  // [MCP 스펙 MUST] /mcp·/mcp/playmcp Origin 검증 — 부재는 통과, 존재하는데 허용목록 밖이면 403(auth.ts).
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || isAllowedMcpOrigin(origin, allowedOrigins)) return next();
    logMcpRequest(req, res, extractToken(req.headers, req.query.key));
    res.status(403).json({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message:
          `Forbidden: Origin '${String(origin).slice(0, 200)}' is not allowed on this MCP endpoint. ` +
          `브라우저 기반 클라이언트라면 서버 환경변수 MCP_ALLOWED_ORIGINS 에 이 origin 을 추가하세요.`,
      },
      id: null,
    });
  });

  /**
   * 모던 레그의 usage 세션 — 팩토리는 요청 객체만 받으므로(McpRequestContext.requestInfo) 토큰을
   * 여기서 다시 꺼낸다. 슬롯 우선순위·판정은 auth.ts `extractToken` 한 곳이 소유하고, 이 함수는
   * web `Request` 를 그 입력 꼴로 옮기는 어댑터일 뿐이다(정책 복제가 아니다).
   */
  const sessionFromRequest = (request: Request | undefined) => {
    const h = request?.headers;
    // `?key=` 가 여럿이면 Express 는 배열로 읽어 extractToken 이 버린다 — 여기서도 하나일 때만 받는다
    // (게이트가 본 자격과 usage 세션의 자격이 갈리지 않게).
    const keys = request ? new URL(request.url).searchParams.getAll("key") : [];
    const key = keys.length === 1 ? keys[0] : null;
    const token = extractToken(
      {
        authorization: h?.get("authorization") ?? undefined,
        "x-eocpa-token": h?.get("x-eocpa-token") ?? undefined,
        "x-api-key": h?.get("x-api-key") ?? undefined,
      },
      key ?? undefined,
    );
    return gate.sessionFor(token, h?.get("user-agent") ?? undefined);
  };

  /**
   * 모던(2026-07-28) 레그 — **프로세스당 프로필별 1벌**. 핸들러가 요청마다 팩토리를 부르므로
   * 서버 인스턴스는 여전히 요청 단위다(stateless). 요청마다 createMcpHandler 를 만들면
   * `responseMode: "json"` 고지가 요청마다 로그에 찍힌다 — 그래서 여기서 한 번만 만든다.
   *   legacy: "reject" = 이 레그는 모던 전용이고 2025-era 는 아래 전송 배선이 그대로 서빙한다.
   *   responseMode: "json" = 중간 알림을 보내지 않으므로 단일 JSON 응답.
   */
  const modernMcp: Record<McpProfile, ReturnType<typeof toNodeHandler>> = {
    full: toNodeHandler(
      createMcpHandler(
        (mcpCtx) => buildServer({ corpus, usage, session: sessionFromRequest(mcpCtx.requestInfo) }, { profile: "full" }),
        { legacy: "reject", responseMode: "json" },
      ),
    ),
    playmcp: toNodeHandler(
      createMcpHandler(
        (mcpCtx) => buildServer({ corpus, usage, session: sessionFromRequest(mcpCtx.requestInfo) }, { profile: "playmcp" }),
        { legacy: "reject", responseMode: "json" },
      ),
    ),
  };

  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  // 랜딩은 eocpa.kr 로 통합 — /mcp·/health 이외의 웹 표면은 여기 없다.
  app.get("/", (_req, res) => { res.redirect(301, "https://eocpa.kr/mykifrs"); });

  const mcpHandler = (profile: McpProfile) => async (req: express.Request, res: express.Response) => {
    const token = extractToken(req.headers, req.query.key);
    logMcpRequest(req, res, token);
    // 자격 요구 범위와 거부 코드는 auth.ts 가 판정한다:
    //   ① tools/call 만 자격을 요구한다 — 핸드셰이크·디스커버리(initialize·tools/list·ping)는 무자격 통과.
    //   ② 제시됐으나 거부된 자격은 403, 미제시만 401.
    if (requiresCredential(req.body) && !(await gate.authorize(token))) {
      res.status(deniedStatus(token)).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: token
            ? "이 토큰은 유효하지 않습니다 — 회전·중지됐거나 검증 서버에 닿지 못했습니다. 재발급·확인: https://eocpa.kr/token"
            : "Unauthorized — https://eocpa.kr/token 에서 토큰을 발급받으세요",
        },
        id: (Array.isArray(req.body) ? req.body[0]?.id : req.body?.id) ?? null,
      });
      return;
    }
    // 요청마다 새 서버 인스턴스(stateless). 세션 = 토큰 해시 + 운영자 여부(관리자 토큰 일치만).
    const session = gate.sessionFor(token, req.headers["user-agent"]);

    try {
      // era 분기 — SDK 자신의 분류기로 가린다(엔트리가 쓰는 바로 그 함수). 모던 envelope(요청마다
      // `_meta` 로 버전을 주장하는 2026-07-28)이면 modern 레그, 아니면(`initialize`·2025-era POST)
      // legacy 레그다. express.json 이 본문을 이미 소진했으므로 parsedBody 로 넘긴다(스트림 재독 없음).
      // 두 era 가 같은 인증 게이트·요청로그·세션을 지나온 뒤라 갈리는 것은 유선 형식뿐이고,
      // 분기도 이 try 안이라 어느 레그의 예상 못 한 예외든 아래 catch 가 500 으로 받는다.
      const legacyEra = await isLegacyRequest(await toWebRequest(req, req.body), req.body);

      if (!legacyEra) {
        // 모던(2026-07-28) — `server/discover`·`resultType`·헤더-본문 대조·캐시 힌트는 SDK 가 처리한다.
        await modernMcp[profile](req, res, req.body);
        return;
      }

      const server = buildServer({ corpus, usage, session }, { profile });
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP 요청 오류:", err);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  };

  app.post("/mcp", mcpHandler("full"));
  app.post("/mcp/playmcp", mcpHandler("playmcp"));

  // stateless 모드: 세션 재개(GET SSE)·세션 종료(DELETE) 미지원
  const methodNotAllowed = (req: express.Request, res: express.Response) => {
    logMcpRequest(req, res, extractToken(req.headers, req.query.key));
    res.status(405).set("Allow", "POST").send();
  };
  for (const path of ["/mcp", "/mcp/playmcp"]) {
    app.get(path, methodNotAllowed);
    app.delete(path, methodNotAllowed);
  }
  return app;
}

export async function serveHttp(): Promise<void> {
  const PORT = Number(process.env.PORT ?? 8080);
  const MCP_TOKEN = process.env.MCP_TOKEN ?? "";

  const anonymous = resolveAnonymous(process.env);
  if (anonymous.warn) console.error(anonymous.warn);
  if (!MCP_TOKEN && !anonymous.allow)
    console.error("MCP_TOKEN 미설정 — 관리자 토큰 비활성. /mcp 는 발급 토큰만 수락한다");

  // 부팅 검증 포함(파일 존재·FTS 인덱스) — 실패는 CorpusError 로 즉시 중단된다.
  const corpus = openCorpus();
  const usage = new UsageDb();
  const gate = new TokenGate({
    adminToken: MCP_TOKEN,
    allowAnonymous: anonymous.allow,
    validateUrl: process.env.TOKEN_VALIDATE_URL ?? "https://eocpa.kr/validate",
  });

  const allowedOrigins = allowedOriginsFromEnv(process.env.MCP_ALLOWED_ORIGINS);
  createApp({ corpus, usage, gate, allowedOrigins }).listen(PORT, () => {
    console.log(
      `mykifrs MCP 서버: :${PORT} (/mcp · /mcp/playmcp, dual-era: 2025-era + 2026-07-28, ` +
      `인증: ${anonymous.allow ? "OFF — 로컬 개방 모드" : "ON"}, 관리자 토큰: ${MCP_TOKEN ? "설정됨" : "없음"})`,
    );
  });
}
