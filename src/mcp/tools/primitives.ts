import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSock } from "../../whatsapp/connection.ts";
import { getMessageById, getRawMessage } from "../../db.ts";
import { getCachedMessage } from "../../whatsapp/msgcache.ts";
import { reconstructKey } from "../../whatsapp/parse.ts";
import {
  reactToMessage,
  deleteMessage,
  deleteMessageForMe,
  editMessage,
  markRead,
  forwardText,
  forwardMessage,
} from "../../whatsapp/actions.ts";
import { assertMutationsAllowed, guardedSend, guardedMutation } from "../../safety/index.ts";
import { textResult, jsonResult, safeHandler, errorResult } from "../format.ts";
import { normalizeRecipient } from "./send.ts";
import { UPDATE_REMOTE, SEND_REMOTE, DESTRUCTIVE_REMOTE } from "../annotations.ts";

function keyForMessage(messageId: string) {
  const row = getMessageById(messageId);
  if (!row) return null;
  return reconstructKey({
    id: row.id,
    chat_jid: row.chat_jid,
    is_from_me: row.is_from_me,
    sender: row.sender,
  });
}

export function registerPrimitiveTools(server: McpServer): void {
  server.tool(
    "react_to_message",
    {
      message_id: z.string(),
      emoji: z.string().max(8).describe("Emoji to react with; empty string ('') removes the reaction"),
    },
    { ...UPDATE_REMOTE, title: "React to message" },
    safeHandler(async ({ message_id, emoji }: any) => {
      assertMutationsAllowed("react_to_message");
      const key = keyForMessage(message_id);
      if (!key) return errorResult(`Unknown message id ${message_id}`);
      await reactToMessage(getSock(), key, emoji);
      return textResult(`Reacted ${emoji} to ${message_id}`);
    }),
  );

  server.tool(
    "edit_message",
    {
      message_id: z.string().describe("Id of one of YOUR sent messages to edit"),
      new_text: z.string().min(1),
    },
    { ...UPDATE_REMOTE, title: "Edit message" },
    safeHandler(async ({ message_id, new_text }: any) => {
      assertMutationsAllowed("edit_message");
      const row = getMessageById(message_id);
      if (!row) return errorResult(`Unknown message id ${message_id}`);
      if (!row.is_from_me) return errorResult("You can only edit messages you sent.");
      const key = reconstructKey({ id: row.id, chat_jid: row.chat_jid, is_from_me: true, sender: row.sender });
      await editMessage(getSock(), key, new_text);
      return textResult(`Edited ${message_id}`);
    }),
  );

  server.tool(
    "delete_message",
    {
      message_id: z.string().describe("Delete for everyone; only works for your own recent messages"),
      for_me: z
        .boolean()
        .optional()
        .describe("Delete only from your own devices (\"Delete for me\"), leaving no placeholder"),
      confirm_token: z.string().optional().describe("Token from a prior staged delete, to confirm it"),
    },
    { ...DESTRUCTIVE_REMOTE, title: "Delete message" },
    safeHandler(async ({ message_id, for_me, confirm_token }: any) => {
      const row = getMessageById(message_id);
      if (!row) return errorResult(`Unknown message id ${message_id}`);
      if (!row.is_from_me) {
        return errorResult("delete_message removes a message for everyone, which only works for messages YOU sent.");
      }
      const key = reconstructKey({ id: row.id, chat_jid: row.chat_jid, is_from_me: true, sender: row.sender });
      const outcome = await guardedMutation({
        action: "delete_message",
        description: `Delete message ${message_id} ${for_me ? "for me" : "for everyone"}`,
        confirmToken: confirm_token,
        run: () =>
          for_me
            ? deleteMessageForMe(getSock(), key, Math.floor(new Date(row.timestamp).getTime() / 1000))
            : deleteMessage(getSock(), key),
      });
      return jsonResult(outcome);
    }),
  );

  server.tool(
    "mark_read",
    {
      message_ids: z.array(z.string()).min(1).describe("Message ids to mark as read"),
    },
    { ...UPDATE_REMOTE, title: "Mark as read" },
    safeHandler(async ({ message_ids }: any) => {
      assertMutationsAllowed("mark_read");
      const keys = message_ids.map(keyForMessage).filter(Boolean) as any[];
      if (keys.length === 0) return errorResult("None of the given message ids were found.");
      await markRead(getSock(), keys);
      return textResult(`Marked ${keys.length} message(s) as read`);
    }),
  );

  server.tool(
    "forward_message",
    {
      message_id: z.string().describe("Id of the message to forward"),
      recipient: z.string().describe("Phone number or chat JID to forward to"),
      confirm_token: z.string().optional(),
    },
    { ...SEND_REMOTE, title: "Forward message" },
    safeHandler(async ({ message_id, recipient, confirm_token }: any) => {
      const row = getMessageById(message_id);
      if (!row) return errorResult(`Unknown message id ${message_id}`);
      const jid = normalizeRecipient(recipient);
      // Prefer a true native forward (keeps media) when we still have the proto;
      // otherwise fall back to re-sending the stored text.
      const original = getCachedMessage(message_id) ?? getRawMessage(message_id);
      const outcome = await guardedSend({
        action: "forward_message",
        recipient: jid,
        description: `Forward message ${message_id} to ${jid}${original ? "" : " (text-only fallback)"}`,
        confirmToken: confirm_token,
        run: () => original
          ? forwardMessage(getSock(), jid, original)
          : forwardText(getSock(), jid, row.content),
      });
      return jsonResult(outcome);
    }),
  );
}
