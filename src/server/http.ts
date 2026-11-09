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
  allowedOrigins?: readonly string[];
}

// Fly 프록시 뒤에서는 Fly-Client-IP 가 실제 클라이언트 IP 다
export function clientIp(req: express.Request): string {
  return (req.headers["fly-client-ip"] as string | undefined) || req.ip || req.socket.remoteAddress || "unknown";
}

export function createApp({ corpus, usage, gate, allowedOrigins = [] }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

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

  const sessionFromRequest = (request: Request | undefined) => {
    const h = request?.headers;
    // ?key= 가 여럿이면 인증 게이트와 같이 없는 것으로 본다
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
  app.get("/", (_req, res) => { res.redirect(301, "https://eocpa.kr/mykifrs"); });

  const mcpHandler = (profile: McpProfile) => async (req: express.Request, res: express.Response) => {
    const token = extractToken(req.headers, req.query.key);
    logMcpRequest(req, res, token);
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
    const session = gate.sessionFor(token, req.headers["user-agent"]);

    try {
      const legacyEra = await isLegacyRequest(await toWebRequest(req, req.body), req.body);

      if (!legacyEra) {
        await modernMcp[profile](req, res, req.body);
        return;
      }

      const server = buildServer({ corpus, usage, session }, { profile });
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
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
