import { downloadMediaMessage, type WASocket } from "baileys";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "../config.ts";
import { logger } from "../logger.ts";
import { getCachedMessage } from "./msgcache.ts";
import { getRawMessage } from "../db.ts";
import { detectMediaType } from "./parse.ts";
import { waCall } from "./guard.ts";
import { sanitizeFilename } from "../security.ts";

/**
 * Stickers are kept in data/stickers/, named by their file hash, the moment we
 * first get them. WhatsApp media links expire, so without this a sticker you
 * sent months ago could no longer be re-sent. The same sticker sent twice has
 * the same hash, so it is stored once.
 */
export function stickerKey(msg: any): string | null {
  const sha = msg?.message?.stickerMessage?.fileSha256;
  return sha ? Buffer.from(sha).toString("base64url") : null;
}

export function cachedStickerPath(key: string): string {
  return path.join(config.dataDir, "stickers", `${sanitizeFilename(key)}.webp`);
}

function cacheSticker(key: string, buffer: Buffer): void {
  const file = cachedStickerPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
}

/** Save a newly seen sticker message to the sticker cache (best effort, never throws). */
export async function rememberSticker(sock: WASocket | null, msg: any): Promise<void> {
  const key = stickerKey(msg);
  if (!key || fs.existsSync(cachedStickerPath(key)) || !msg?.key?.id) return;
  try {
    await downloadMessageMedia(sock, msg.key.id);
  } catch (err) {
    logger.debug({ err, id: msg.key.id }, "could not cache sticker");
  }
}

/**
 * Download the media of a (recently seen) message to disk and return the path.
 * Requires the original message to still be in the in-memory cache.
 */
export async function downloadMessageMedia(
  sock: WASocket | null,
  messageId: string,
): Promise<{ path: string; mediaType: string }> {
  // Prefer the in-memory cache; fall back to the persisted proto so downloads
  // work for any synced message, not just recent ones.
  const msg = getCachedMessage(messageId) ?? getRawMessage(messageId) ?? undefined;
  if (!msg) {
    throw new Error(
      "Message not found. It may predate history sync, or raw storage is disabled (WAMCP_STORE_RAW=0).",
    );
  }
  const mediaType = detectMediaType(msg) ?? "file";

  const key = mediaType === "sticker" ? stickerKey(msg) : null;
  if (key && fs.existsSync(cachedStickerPath(key))) {
    return { path: cachedStickerPath(key), mediaType };
  }

  // Anti-DoS: reject oversized media. Fail fast on the sender-declared length
  // before spending bandwidth, then hard-check the actual bytes.
  const mm: any = msg.message ?? {};
  const declared = Number(
    (mm.imageMessage ?? mm.videoMessage ?? mm.audioMessage ?? mm.documentMessage ?? mm.stickerMessage)
      ?.fileLength ?? 0,
  );
  const capMb = Math.round(config.maxMediaBytes / (1024 * 1024));
  if (declared && declared > config.maxMediaBytes) {
    throw new Error(`Media is ~${Math.round(declared / 1048576)}MB, over the ${capMb}MB limit (WAMCP_MAX_MEDIA_MB).`);
  }

  const download = (m: any) => waCall("download_media", () => downloadMediaMessage(
    m,
    "buffer",
    {},
    { logger: logger as any, reuploadRequest: (sock as any)?.updateMediaMessage },
  ), 90_000) as Promise<Buffer>;
  let buffer: Buffer;
  try {
    buffer = await download(msg);
  } catch (err: any) {
    // Baileys only asks the phone to re-upload on 404/410, but expired media
    // links answer 403. Ask for a fresh copy ourselves and try once more.
    const status = err?.response?.status ?? err?.status ?? /status code (\d+)/.exec(String(err?.message))?.[1];
    if (Number(status) !== 403 || !(sock as any)?.updateMediaMessage) throw err;
    const refreshed = await waCall("download_media", () => (sock as any).updateMediaMessage(msg), 60_000);
    buffer = await download(refreshed);
  }

  if (buffer.length > config.maxMediaBytes) {
    throw new Error(`Media is ${(buffer.length / 1048576).toFixed(1)}MB, over the ${capMb}MB limit (WAMCP_MAX_MEDIA_MB).`);
  }

  const mediaDir = path.join(config.dataDir, "media");
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  const extByType: Record<string, string> = {
    image: ".jpg", video: ".mp4", audio: ".ogg", document: ".bin", sticker: ".webp", file: ".bin",
  };
  // Message ids come from WhatsApp/senders; sanitize before using in a path so
  // a crafted id cannot traverse out of the media directory.
  const outPath = path.join(mediaDir, `${sanitizeFilename(messageId)}${extByType[mediaType] ?? ".bin"}`);
  fs.writeFileSync(outPath, buffer);
  if (key) cacheSticker(key, buffer);
  return { path: outPath, mediaType };
}

/**
 * Transcribe a voice message. Pluggable: set WAMCP_TRANSCRIPTION_CMD to a shell
 * command template containing {input}; it should print the transcript to stdout.
 * Example: WAMCP_TRANSCRIPTION_CMD="whisper {input} --model base --output_format txt --output_dir - "
 * If no command is configured we return a clear, non-fatal message.
 */
export async function transcribeVoiceMessage(
  sock: WASocket | null,
  messageId: string,
): Promise<{ transcript: string; configured: boolean }> {
  const { path: audioPath } = await downloadMessageMedia(sock, messageId);

  if (!config.transcriptionCmd) {
    return {
      configured: false,
      transcript:
        `Audio downloaded to ${audioPath}, but transcription is not configured. ` +
        `Set WAMCP_TRANSCRIPTION_CMD (a command containing {input}) to enable STT.`,
    };
  }

  // The command template is operator-configured (WAMCP_TRANSCRIPTION_CMD, read
  // from the server's OWN environment) and is never derived from message content,
  // so this is not a prompt-injection surface. It is still hardened two ways:
  //   1. shell:false (the spawnSync default, set explicitly here) — no shell ever
  //      parses the string, so metacharacters cannot chain or redirect commands.
  //   2. The TEMPLATE is split into argv parts BEFORE {input} is substituted, so
  //      the audio path is always a single argument even when it contains spaces
  //      (e.g. a data dir under "C:\Users\John Doe\..."). Substituting first and
  //      splitting after would break such paths into multiple bogus arguments.
  const parts = config.transcriptionCmd.split(" ").filter(Boolean);
  const bin = parts[0]!;
  const args = parts.slice(1).map((p) => p.replaceAll("{input}", audioPath));
  const res = spawnSync(bin, args, { encoding: "utf-8", timeout: 120_000, shell: false });
  if (res.status !== 0) {
    throw new Error(`Transcription command failed: ${res.stderr || res.error?.message || "unknown"}`);
  }
  return { configured: true, transcript: (res.stdout || "").trim() };
}
