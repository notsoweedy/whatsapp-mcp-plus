import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSock, getConnectionState } from "../../whatsapp/connection.ts";
import { config, describeSafety } from "../../config.ts";
import { cacheSize } from "../../whatsapp/msgcache.ts";
import {
  addToAllowlist,
  removeFromAllowlist,
  listAllowlist,
} from "../../db.ts";
import {
  getMode,
  setMode,
  confirmAction,
  listPending,
} from "../../safety/index.ts";
import { jsonResult, textResult, safeHandler } from "../format.ts";
import { normalizeRecipient } from "./send.ts";
import { READ_LOCAL, WRITE_LOCAL } from "../annotations.ts";

export function registerAdminTools(server: McpServer): void {
  server.tool(
    "get_status",
    {},
    { ...READ_LOCAL, title: "Get status" },
    safeHandler(async () => {
      const sock = getSock();
      return jsonResult({
        connected: Boolean(sock?.user),
        connection_state: getConnectionState(),
        me: sock?.user?.id ?? null,
        mode: getMode(),
        scopes: [...config.scopes],
        safety: describeSafety(),
        cached_messages: cacheSize(),
        pending_confirmations: listPending(),
      });
    }),
  );

  server.tool(
    "get_me",
    {},
    { ...READ_LOCAL, title: "Get my account" },
    safeHandler(async () => {
      const sock = getSock();
      return jsonResult({
        jid: sock?.user?.id ?? null,
        name: sock?.user?.name ?? null,
        connected: Boolean(sock?.user),
      });
    }),
  );

  server.tool(
    "set_mode",
    { mode: z.enum(["read-only", "assisted", "unrestricted"]) },
    { ...WRITE_LOCAL, title: "Set safety mode" },
    safeHandler(async ({ mode }: any) => {
      setMode(mode);
      return textResult(`Mode set to '${mode}'. ${describeSafety()}`);
    }),
  );

  server.tool(
    "confirm_action",
    { token: z.string().describe("Token from a staged send that needs confirmation") },
    // Executes whatever action was staged (which may be a send or a delete), so
    // it is potentially destructive; the token is single-use, so not idempotent.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, title: "Confirm staged action" },
    safeHandler(async ({ token }: any) => {
      const result = await confirmAction(token);
      return jsonResult({ status: "done", result });
    }),
  );

  server.tool(
    "allowlist_add",
    { recipient: z.string().describe("Phone number or JID to allow messaging") },
    { ...WRITE_LOCAL, title: "Allowlist: add" },
    safeHandler(async ({ recipient }: any) => {
      const jid = normalizeRecipient(recipient);
      addToAllowlist(jid);
      return textResult(`Added ${jid} to allowlist`);
    }),
  );

  server.tool(
    "allowlist_remove",
    { recipient: z.string() },
    { ...WRITE_LOCAL, title: "Allowlist: remove" },
    safeHandler(async ({ recipient }: any) => {
      const jid = normalizeRecipient(recipient);
      removeFromAllowlist(jid);
      return textResult(`Removed ${jid} from allowlist`);
    }),
  );

  server.tool(
    "allowlist_list",
    {},
    { ...READ_LOCAL, title: "Allowlist: list" },
    safeHandler(async () => jsonResult(listAllowlist())),
  );
}
