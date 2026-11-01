/**
 * Reading votes on polls.
 *
 * A vote arrives as an encrypted pollUpdateMessage. Decrypting it needs the
 * poll's own secret (messageContextInfo.messageSecret of the poll message,
 * which we keep in the message cache / raw store) and the exact JIDs of the
 * poll's creator and the voter. Baileys has this code but ships it disabled,
 * so it lives here. Each vote carries the voter's full current selection, so
 * the latest vote per voter replaces the previous one.
 */
import { decryptPollVote, jidNormalizedUser, type WASocket } from "baileys";
import { createHash } from "node:crypto";
import { getRawMessage, storePollVote } from "../db.ts";
import { logger } from "../logger.ts";
import { getCachedMessage } from "./msgcache.ts";

function pollOptions(pollMsg: any): string[] {
  const m = pollMsg?.message ?? {};
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  return (poll?.options ?? []).map((o: any) => o.optionName ?? "");
}

/** Every JID that might identify the author of `key` (our own phone and LID ids for our messages). */
function authorCandidates(key: any, me: string[]): string[] {
  if (key?.fromMe) return me;
  return [key?.participant, key?.participantPn, key?.participantLid, key?.remoteJid]
    .filter(Boolean)
    .map((j: string) => jidNormalizedUser(j));
}

/** Decrypt and store one vote (best effort: a vote we can't read is logged and skipped). */
export function handlePollVote(sock: WASocket | null, msg: any): void {
  const update = msg?.message?.pollUpdateMessage;
  const pollKey = update?.pollCreationMessageKey;
  if (!update?.vote || !pollKey?.id) return;
  const pollMsg: any = getCachedMessage(pollKey.id) ?? getRawMessage(pollKey.id);
  const secret = pollMsg?.message?.messageContextInfo?.messageSecret;
  if (!pollMsg || !secret) {
    logger.warn({ poll: pollKey.id }, "vote for a poll we don't have; skipped");
    return;
  }
  const creds: any = (sock as any)?.authState?.creds?.me ?? sock?.user ?? {};
  const me = [creds.id, creds.lid].filter(Boolean).map((j: string) => jidNormalizedUser(j));
  for (const creator of authorCandidates(pollKey, me)) {
    for (const voter of authorCandidates(msg.key, me)) {
      try {
        const vote = decryptPollVote(update.vote, {
          pollCreatorJid: creator,
          pollMsgId: pollKey.id,
          pollEncKey: secret,
          voterJid: voter,
        });
        const byHash = new Map(pollOptions(pollMsg).map((name) => [
          createHash("sha256").update(Buffer.from(name)).digest("hex"), name,
        ]));
        const selected = (vote.selectedOptions ?? []).map(
          (h: Uint8Array) => byHash.get(Buffer.from(h).toString("hex")) ?? "?",
        );
        const ts = Number(update.senderTimestampMs ?? Date.now());
        storePollVote(pollKey.id, msg.key.fromMe ? "me" : voter, selected, new Date(ts).toISOString());
        return;
      } catch {
        /* wrong creator/voter id combination; try the next */
      }
    }
  }
  logger.warn({ poll: pollKey.id }, "could not decrypt poll vote");
}
