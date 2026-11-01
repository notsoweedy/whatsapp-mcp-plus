import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSock } from "../../whatsapp/connection.ts";
import { getGroupChats, getPollVotes, getRawMessage } from "../../db.ts";
import { getCachedMessage } from "../../whatsapp/msgcache.ts";
import { sendLocation, sendPoll, sendContactCard } from "../../whatsapp/actions.ts";
import { guardedSend } from "../../safety/index.ts";
import { formatDbChatForJson, jsonResult, safeHandler } from "../format.ts";
import { normalizeRecipient } from "./send.ts";
import { READ_LOCAL, SEND_REMOTE } from "../annotations.ts";

export function registerExtraTools(server: McpServer): void {
  server.tool(
    "list_groups",
    { limit: z.number().int().positive().max(200).default(50), page: z.number().int().min(0).default(0) },
    { ...READ_LOCAL, title: "List groups" },
    safeHandler(async ({ limit, page }: any) => {
      return jsonResult(getGroupChats(limit, page).map(formatDbChatForJson));
    }),
  );

  server.tool(
    "send_location",
    {
      recipient: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
      confirm_token: z.string().optional(),
    },
    { ...SEND_REMOTE, title: "Send location" },
    safeHandler(async ({ recipient, latitude, longitude, name, address, confirm_token }: any) => {
      const jid = normalizeRecipient(recipient);
      const outcome = await guardedSend({
        action: "send_location",
        recipient: jid,
        description: `Send location (${latitude},${longitude}) to ${jid}`,
        confirmToken: confirm_token,
        run: () => sendLocation(getSock(), jid, latitude, longitude, name, address),
      });
      return jsonResult(outcome);
    }),
  );

  server.tool(
    "send_poll",
    {
      recipient: z.string(),
      question: z.string().min(1),
      options: z.array(z.string()).min(2).max(12),
      selectable_count: z.number().int().min(1).default(1),
      confirm_token: z.string().optional(),
    },
    { ...SEND_REMOTE, title: "Send poll" },
    safeHandler(async ({ recipient, question, options, selectable_count, confirm_token }: any) => {
      const jid = normalizeRecipient(recipient);
      const outcome = await guardedSend({
        action: "send_poll",
        recipient: jid,
        description: `Send poll "${question}" to ${jid}`,
        confirmToken: confirm_token,
        run: () => sendPoll(getSock(), jid, question, options, selectable_count),
      });
      return jsonResult(outcome);
    }),
  );

  server.tool(
    "get_poll_votes",
    { message_id: z.string().describe("Id of a poll message (e.g. the result of send_poll)") },
    { ...READ_LOCAL, title: "Get poll votes" },
    safeHandler(async ({ message_id }: any) => {
      const poll: any = getCachedMessage(message_id) ?? getRawMessage(message_id);
      const m = poll?.message ?? {};
      const p = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
      if (!p) throw new Error(`Message ${message_id} is not a poll I have.`);
      return jsonResult({
        question: p.name,
        options: (p.options ?? []).map((o: any) => o.optionName),
        multiple_choice: (p.selectableOptionsCount ?? 1) !== 1,
        votes: getPollVotes(message_id), // voter "me" = you
      });
    }),
  );

  server.tool(
    "send_contact",
    {
      recipient: z.string(),
      contact_name: z.string().min(1),
      contact_phone: z.string().min(1),
      confirm_token: z.string().optional(),
    },
    { ...SEND_REMOTE, title: "Send contact" },
    safeHandler(async ({ recipient, contact_name, contact_phone, confirm_token }: any) => {
      const jid = normalizeRecipient(recipient);
      const outcome = await guardedSend({
        action: "send_contact",
        recipient: jid,
        description: `Send contact card for ${contact_name} to ${jid}`,
        confirmToken: confirm_token,
        run: () => sendContactCard(getSock(), jid, contact_name, contact_phone),
      });
      return jsonResult(outcome);
    }),
  );
}
