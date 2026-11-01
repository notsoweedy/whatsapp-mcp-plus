// Tool-annotation + tool-inventory test.
//
// Boots the MCP server over stdio (WAMCP_NO_WA=1, no WhatsApp, network-free),
// lists every tool, and asserts:
//   1. the exact set of tools we ship is registered (no drift, no dupes);
//   2. every tool declares ALL FOUR behaviour hints as real booleans
//      (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) — OpenAI's
//      directory rejects a tool if any hint is missing or non-boolean;
//   3. each hint matches the tool's documented behaviour (a read tool is
//      read-only, a delete/leave/block tool is destructive, a send is not
//      idempotent, a WhatsApp-network tool is open-world, ...).
//
// Every tool is named as a literal below, so this file is also the per-tool
// test-coverage anchor: adding a tool without listing it here fails the suite.
import { spawn } from "node:child_process";

// name -> [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]
const EXPECTED = {
  // --- local, side-effect-free reads (SQLite cache; no network) ---
  search_contacts:        [true,  false, true,  false],
  list_chats:             [true,  false, true,  false],
  get_chat:               [true,  false, true,  false],
  list_messages:          [true,  false, true,  false],
  list_stickers:          [true,  false, true,  false],
  get_poll_votes:         [true,  false, true,  false],
  get_last_interaction:   [true,  false, true,  false],
  contact_info:           [true,  false, true,  false],
  chat_stats:             [true,  false, true,  false],
  export_chat:            [true,  false, true,  false],
  get_message_context:    [true,  false, true,  false],
  search_messages:        [true,  false, true,  false],
  top_words:              [true,  false, true,  false],
  response_leaderboard:   [true,  false, true,  false],
  whatsapp_wrapped:       [true,  false, true,  false],
  get_status:             [true,  false, true,  false],
  get_me:                 [true,  false, true,  false],
  allowlist_list:         [true,  false, true,  false],
  list_groups:            [true,  false, true,  false],

  // --- reads that query the live WhatsApp network ---
  group_info:               [true, false, true, true],
  group_invite_link:        [true, false, true, true],
  check_number_on_whatsapp: [true, false, true, true],
  get_profile_picture:      [true, false, true, true],

  // --- writes to local state only (config toggles / generated files) ---
  set_mode:          [false, false, true, false],
  allowlist_add:     [false, false, true, false],
  allowlist_remove:  [false, false, true, false],
  wrapped_card:      [false, false, true, false],
  whatsapp_rewind:   [false, false, true, false],

  // --- non-idempotent creates sent over WhatsApp ---
  send_message:    [false, false, false, true],
  send_file:       [false, false, false, true],
  send_voice_note: [false, false, false, true],
  send_sticker:    [false, false, false, true],
  forward_message: [false, false, false, true],
  create_group:    [false, false, false, true],
  send_location:   [false, false, false, true],
  send_poll:       [false, false, false, true],
  send_contact:    [false, false, false, true],

  // --- idempotent, non-destructive network state changes ---
  react_to_message:      [false, false, true, true],
  edit_message:          [false, false, true, true],
  mark_read:             [false, false, true, true],
  group_set_subject:     [false, false, true, true],
  group_set_description: [false, false, true, true],
  send_presence:         [false, false, true, true],
  pin_chat:              [false, false, true, true],
  mute_chat:             [false, false, true, true],
  star_message:          [false, false, true, true],
  set_profile_status:    [false, false, true, true],
  set_profile_name:      [false, false, true, true],

  // --- fetches media off the network into the local cache (a disk write) ---
  download_media:            [false, false, true, true],
  transcribe_voice_message:  [false, false, true, true],

  // --- destructive network actions (remove data / access) ---
  delete_message:            [false, true, true, true],
  group_update_participants: [false, true, true, true],
  group_leave:               [false, true, true, true],
  block_contact:             [false, true, true, true],

  // --- executes a staged action (may delete); single-use token, not idempotent ---
  confirm_action: [false, true, false, true],
};

const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WAMCP_MODE: "read-only", WAMCP_NO_WA: "1", WAMCP_SCOPES: "all" },
});

let buf = "";
const handlers = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && handlers.has(msg.id)) handlers.get(msg.id)(msg);
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

function fail(reason) {
  console.log("FAIL:", reason);
  child.kill();
  process.exit(1);
}
const guard = setTimeout(() => fail("Timed out waiting for MCP responses."), 15000);

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

handlers.set(1, () => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  handlers.set(2, (msg) => {
    clearTimeout(guard);
    const tools = msg.result?.tools ?? [];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const expectedNames = Object.keys(EXPECTED);
    const errors = [];

    // 1. Inventory matches exactly (no missing, no unexpected, no dupes).
    if (tools.length !== new Set(tools.map((t) => t.name)).size) {
      errors.push("duplicate tool names registered");
    }
    for (const name of expectedNames) {
      if (!byName.has(name)) errors.push(`missing tool: ${name}`);
    }
    for (const t of tools) {
      if (!(t.name in EXPECTED)) errors.push(`unexpected tool (add it to EXPECTED): ${t.name}`);
    }

    // 2 + 3. Every tool declares all four hints as booleans, matching behaviour.
    for (const name of expectedNames) {
      const t = byName.get(name);
      if (!t) continue;
      const a = t.annotations;
      if (!a || typeof a !== "object") { errors.push(`${name}: no annotations object`); continue; }
      for (const h of HINTS) {
        if (typeof a[h] !== "boolean") errors.push(`${name}: ${h} is ${JSON.stringify(a[h])}, expected a boolean`);
      }
      const [ro, de, id, ow] = EXPECTED[name];
      if (a.readOnlyHint !== ro) errors.push(`${name}: readOnlyHint=${a.readOnlyHint}, expected ${ro}`);
      if (a.destructiveHint !== de) errors.push(`${name}: destructiveHint=${a.destructiveHint}, expected ${de}`);
      if (a.idempotentHint !== id) errors.push(`${name}: idempotentHint=${a.idempotentHint}, expected ${id}`);
      if (a.openWorldHint !== ow) errors.push(`${name}: openWorldHint=${a.openWorldHint}, expected ${ow}`);
      if (typeof a.title !== "string" || !a.title) errors.push(`${name}: missing human-readable title`);
    }

    if (errors.length) {
      for (const e of errors) console.log("  -", e);
      fail(`${errors.length} annotation problem(s) across ${tools.length} tool(s)`);
    }

    console.log(`OK: ${tools.length} tools, all with complete, correct annotations.`);
    child.kill();
    process.exit(0);
  });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
});

setTimeout(() => send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "annotations-test", version: "0.0.0" } },
}), 300);
