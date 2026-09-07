# MyKIFRS MCP

Full-text search over Korean accounting standards and the official Q&A that interprets them, served as a remote [MCP](https://modelcontextprotocol.io) server for accounting professionals.

The corpus covers K-IFRS, K-GAAP (일반기업회계기준), interpretations, the Conceptual Framework, Korean auditing standards, ICFR (내부회계관리제도) standards, KSSB sustainability disclosure standards, and 3,669 authoritative Q&A (회계기준원·금융감독원·신속처리질의·IFRS IC agenda decisions). Standards are stored paragraph by paragraph, and each paragraph carries the Q&A that cite it.

- Endpoint: `https://mykifrs.eocpa.kr/mcp` (Streamable HTTP, stateless)
- Credential: an eocpa token from [eocpa.kr/token](https://eocpa.kr/token)
- Nothing to install: register the URL in claude.ai, Claude Desktop, Claude Code, Cursor, or any Streamable HTTP client
- Landing page (Korean): [eocpa.kr/mykifrs](https://eocpa.kr/mykifrs)

## Why

A language model can paraphrase an accounting standard; a practitioner has to cite it. The paragraph number, the exact wording, the conditions in the neighboring paragraphs, and the regulator's answer to the same question are what go into a memo. This server returns them verbatim: search hits point at a `unique_key` such as `1116-33`, `get_paragraph` returns that paragraph with its surrounding context, and `related_qnas` lists the Q&A documents that were issued about it.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_standards` | `query`, `std_num?`, `limit?` | Paragraph hits across all standards (`unique_key`, standard title, category, snippet), relevance-ranked |
| `search_qnas` | `query`, `limit?` | Q&A hits with document number, date, issuing body, related standards, snippet |
| `get_paragraph` | `unique_key`, `context?` | The paragraph text with `context` neighbors on each side, standard metadata, and `related_qnas` |
| `get_qna` | `doc_number` | Full text of a Q&A document (an array — some numbers appear more than once) |
| `list_standards` | `category?` | Catalog of standards in the corpus with their `std_num` |
| `get_usage_stats` | `days?` | Aggregate server usage statistics |

Every tool is read-only, idempotent, and local (SQLite + FTS5). No external call is made while serving a request.

### Search behavior

- Tokens of three or more characters go to FTS5 (AND-joined, rank-ordered). One- and two-character tokens become `LIKE` filters, because the trigram index cannot match them. A query made only of short tokens still works but is ordered by standard number, not relevance.
- Search hits return a snippet with matched terms wrapped in `⟦…⟧`. A snippet is a fragment; quote `get_paragraph`'s `content_text`, never the snippet.
- `unique_key` is `{standard number}-{paragraph number}` and paragraph numbers are not digits-only (`B58`, `AG12`, `6.1.1`). Pass the value verbatim.

## Using the server

### 1. Get a credential

Request an eocpa token at [eocpa.kr/token](https://eocpa.kr/token). Tool calls require it; discovery (`initialize`, `tools/list`, `ping`) works without one, so connector onboarding never fails on authentication.

### 2. Connect

The credential can travel in any of these slots; the server treats them identically:

| Slot | Example |
|---|---|
| Custom header | `x-eocpa-token: <token>` (also accepted: `x-api-key`) |
| Bearer | `Authorization: Bearer <token>` |
| Query string | `https://mykifrs.eocpa.kr/mcp?key=<token>` |

**claude.ai (web)** — the custom connector dialog takes a URL only, so put the token in the query string:

```
https://mykifrs.eocpa.kr/mcp?key=<token>
```

**Claude Desktop / Claude Code** — bridge with `mcp-remote` so the token stays in a header:

```json
{
  "mcpServers": {
    "mykifrs": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mykifrs.eocpa.kr/mcp", "--header", "x-eocpa-token:${EOCPA_TOKEN}"],
      "env": { "EOCPA_TOKEN": "<token>" }
    }
  }
}
```

**Clients with a header field** (Cursor and others) — enter the endpoint and the `x-eocpa-token` header directly.

A Claude Code plugin manifest is included at [.claude-plugin/plugin.json](.claude-plugin/plugin.json), and [server.json](server.json) is the manifest for the official MCP Registry.

### 3. Check

```bash
curl https://mykifrs.eocpa.kr/health

curl -X POST https://mykifrs.eocpa.kr/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-eocpa-token: <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A tool call without a credential returns `401`; a credential that is present but rejected returns `403` with a message that says so.

### PlayMCP channel

`https://mykifrs.eocpa.kr/mcp/playmcp` is the same server behind the same authentication, with the response contract the PlayMCP platform requires: every tool result stays within 24,000 characters. Results that would exceed it are structurally truncated (array tails and the longest strings are shortened) and flagged with `playmcp_truncated: true`, a `playmcp_truncation_note`, and `playmcp_text_truncated` on any object whose text was cut. `get_usage_stats` is not registered on this channel. The standard `/mcp` endpoint never truncates.

## Data and terms of use

The corpus (`data/kasb.sqlite`) is **not** part of this repository. Standards text is the work of the Korea Accounting Standards Board and, for K-IFRS, the IFRS Foundation; the Q&A are publications of KASB and the Financial Supervisory Service. The hosted server is offered for personal reference by accounting practitioners. Redistribution of the full text or turning the corpus into a public service requires the rights holders' permission.

## Development

Requires Node.js 22+.

```bash
git clone https://github.com/taesueocpa/mykifrs-mcp.git
cd mykifrs-mcp
npm install
npm run build
```

Running the server locally needs a corpus at `data/kasb.sqlite` (schema in `src/store/kasb-db.ts`), which this repository does not ship. With one in place:

```bash
npm run stdio     # stdio transport
npm start         # HTTP on :8080 — /mcp and /mcp/playmcp
```

| Environment variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 8080) |
| `KASB_DB` | Corpus location (default `data/kasb.sqlite`) |
| `TOKEN_VALIDATE_URL` | Token validation endpoint (default `https://eocpa.kr/validate`) |
| `MYKIFRS_ALLOW_ANONYMOUS=1` | Local development only — skips token validation; ignored on Fly.io |
| `USAGE_DB_PATH` | Usage log location (default `data/usage.sqlite`) |
| `PLAYMCP_LIMIT`, `PLAYMCP_LIMIT_UNIT` | PlayMCP channel budget (default `24000`, `chars`) |
| `MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` allowlist for `/mcp` (DNS-rebinding guard). Requests without an `Origin` header and localhost origins always pass |

Layout:

```
src/main.ts          entry point (stdio by default, --http or MCP_MODE=http for remote)
src/tools/           tool registry — the single source of truth for both transports
src/server/          dispatch, server assembly, auth, HTTP wiring, PlayMCP profile and budget guard
src/store/           SQLite schema, boot-time validation, FTS definition, usage log
src/search/          query tokenizer (FTS / LIKE split)
```

## Related

- [MyFSS MCP](https://github.com/taesueocpa/myfss-mcp) — FSS/FSC accounting supervision documents
- [eocpa.kr](https://eocpa.kr) — hub and token issuance
