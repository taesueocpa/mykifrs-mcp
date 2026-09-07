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
 * `tools/call` 만 토큰을 요구한다: 관리자 토큰(MCP_TOKEN) 또는 eocpa.kr 발급 토큰.
 * 판정 로직은 전부 src/server/auth.ts 소관 — 이 파일은 순서 배선만 소유한다.
 *
 * 접속: https://mykifrs.eocpa.kr/mcp?key=<토큰>  또는  Authorization: Bearer <토큰>
 *      (커스텀 헤더 x-eocpa-token 도 같은 슬롯 — auth.ts extractToken)
 */
import express from "express";
import type Database from "better-sqlite3";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

/** Express 앱 조립. */
export function createApp({ corpus, usage, gate, allowedOrigins = [] }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  // [MCP 스펙 MUST] /mcp·/mcp/playmcp Origin 검증 — 부재는 통과, 존재하는데 허용목록 밖이면 403(auth.ts).
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || isAllowedMcpOrigin(origin, allowedOrigins)) return next();
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

  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  // 랜딩은 eocpa.kr 로 통합 — /mcp·/health 이외의 웹 표면은 여기 없다.
  app.get("/", (_req, res) => { res.redirect(301, "https://eocpa.kr/mykifrs"); });

  const mcpHandler = (profile: McpProfile) => async (req: express.Request, res: express.Response) => {
    const token = extractToken(req.headers, req.query.key);
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
      const server = buildServer({ corpus, usage, session }, { profile });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => { transport.close(); server.close(); });
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
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
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
    console.error("MCP_TOKEN 미설정 — 관리자 경로(상세 통계) 비활성. /mcp 는 발급 토큰만 수락한다");

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
      `mykifrs MCP 서버: :${PORT} (/mcp · /mcp/playmcp, ` +
      `인증: ${anonymous.allow ? "OFF — 로컬 개방 모드" : "ON"}, 관리자 토큰: ${MCP_TOKEN ? "설정됨" : "없음"})`,
    );
  });
}
