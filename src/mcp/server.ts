import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";

import { config } from "../config.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerSendTools } from "./tools/send.ts";
import { registerPrimitiveTools } from "./tools/primitives.ts";
import { registerGroupTools } from "./tools/groups.ts";
import { registerPresenceTools } from "./tools/presence.ts";
import { registerMediaTools } from "./tools/media.ts";
import { registerAnalyticsTools } from "./tools/analytics.ts";
import { registerAdminTools } from "./tools/admin.ts";
import { registerExtraTools } from "./tools/extras.ts";
import { registerChatTools } from "./tools/chat.ts";
import { scopeForTool, scopeEnabled } from "../safety/scopes.ts";

/**
 * Wrap `server.tool` so every registered tool is gated by its feature scope
 * (consent). A tool whose scope is disabled stays listed but returns a clear
 * "enable this scope" error when called, instead of acting. Central, so no
 * per-tool edits are needed and the gate can never be forgotten.
 */
function withScopeGate(server: McpServer): McpServer {
  const orig = server.tool.bind(server);
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...toolArgs: unknown[]) => {
    const name = toolArgs[0] as string;
    const handler = toolArgs[toolArgs.length - 1];
    const scope = scopeForTool(name);
    if (scope && typeof handler === "function") {
      const wrapped = async (...a: unknown[]) => {
        if (!scopeEnabled(scope)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: the '${scope}' scope is not enabled, so '${name}' is unavailable. ` +
                  `Enable it via WAMCP_SCOPES (e.g. add '${scope}') or run \`npm run setup\`.`,
              },
            ],
            isError: true,
          };
        }
        return (handler as (...x: unknown[]) => unknown)(...a);
      };
      toolArgs[toolArgs.length - 1] = wrapped;
    }
    return (orig as (...x: unknown[]) => unknown)(...toolArgs);
  };
  return server;
}

function buildServer(): McpServer {
  const server = withScopeGate(new McpServer({
    name: "whatsapp-mcp-plus",
    version: "0.1.0",
  }));

  registerReadTools(server);
  registerSendTools(server);
  registerPrimitiveTools(server);
  registerGroupTools(server);
  registerPresenceTools(server);
  registerMediaTools(server);
  registerAnalyticsTools(server);
  registerAdminTools(server);
  registerExtraTools(server);
  registerChatTools(server);
  return server;
}

export async function startMcpServer(logger: Logger): Promise<void> {
  if (config.transport === "http") {
    await startHttpServer(logger);
    return;
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  logger.info("MCP server connected over stdio; ready.");
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Streamable-HTTP mode: one long-running process owns the WhatsApp connection
 * and any number of MCP clients (interactive or headless) can attach to it.
 * Stateless — a fresh McpServer per request, all sharing the global socket/DB.
 *
 * Loopback only, and every request must carry the bearer token. Requests with
 * a non-loopback Host (DNS rebinding) or any Origin header (a browser page)
 * are refused, so a website can never drive the account.
 */
async function startHttpServer(logger: Logger): Promise<void> {
  const token = config.httpToken;
  if (!token || token.length < 32) {
    throw new Error("WAMCP_TRANSPORT=http requires WAMCP_HTTP_TOKEN (at least 32 chars).");
  }
  const expected = Buffer.from(`Bearer ${token}`);

  const httpServer = createServer(async (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const auth = Buffer.from(req.headers.authorization ?? "");
    const authorized = auth.length === expected.length && timingSafeEqual(auth, expected);
    if (!LOCAL_HOSTS.has(host) || req.headers.origin || !authorized) {
      res.writeHead(403).end();
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, "MCP HTTP request failed");
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(config.httpPort, "127.0.0.1", resolve));
  logger.info(`MCP server listening on http://127.0.0.1:${config.httpPort}/mcp; ready.`);
}
