/**
 * MCP tool behaviour annotations (hints).
 *
 * Every registered tool declares ALL FOUR hints so an MCP host can decide,
 * before it invokes a tool, whether the call is safe to run automatically or
 * should be surfaced to the user for confirmation. The hints are advisory — a
 * host must never trust them for security, and this server enforces its own
 * safety rails (scopes, modes, confirmation, rate limits) regardless — but
 * hosts and directories (Claude, OpenAI) use them for UX, and OpenAI's tool
 * directory rejects tools where any of the four hints is missing or non-boolean.
 *
 *   readOnlyHint    - the tool only reads; it changes no state.
 *   destructiveHint - the tool may remove or irreversibly overwrite data.
 *                     Only meaningful when readOnlyHint is false.
 *   idempotentHint  - repeating the call with identical arguments has no effect
 *                     beyond the first. Only meaningful when readOnlyHint false.
 *   openWorldHint   - the tool reaches an external system (the WhatsApp network)
 *                     rather than only local state (the SQLite cache / disk).
 *
 * See: https://modelcontextprotocol.io/docs/concepts/tools#annotations
 */

/** Pure read of local, cached state (the SQLite DB). No network, no writes. */
export const READ_LOCAL = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;

/** Pure read that queries the live WhatsApp network. */
export const READ_REMOTE = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const;

/** Writes only local state — config toggles or generated files. Safe to repeat. */
export const WRITE_LOCAL = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;

/** Creates new, non-idempotent output on WhatsApp — each call sends one more. */
export const SEND_REMOTE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
} as const;

/** Idempotent, non-destructive state change on the WhatsApp network. */
export const UPDATE_REMOTE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const;

/** Destructive action on WhatsApp — removes data or access (delete, leave, block). */
export const DESTRUCTIVE_REMOTE = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
} as const;

/**
 * Fetches bytes off the WhatsApp network and caches them to the local media dir.
 * The disk write means it is not read-only, but re-fetching the same message id
 * just rewrites the same file, so it is idempotent and non-destructive.
 */
export const FETCH_REMOTE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const;
