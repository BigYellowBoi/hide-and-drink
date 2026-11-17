import type { SyncTransport } from './transport'

/** Error from a game action. code is the server's snake_case code, or a client one. */
export class ActionError extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.code = code
  }
}

export interface RetryOptions {
  retries?: number
  retryDelayMs?: number
  /** Stop retrying when this returns false (e.g. the device went offline). */
  canRetry?: () => boolean
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Call an action function, retrying only when the request may not have reached the
 * server. args must carry p_client_action_id, which stays the same across retries so
 * the server applies the action at most once.
 */
export async function callWithRetry(
  transport: SyncTransport,
  fn: string,
  args: Record<string, unknown>,
  { retries = 3, retryDelayMs = 300, canRetry = () => true }: RetryOptions = {},
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const result = await transport.call(fn, args)
    if (result.ok) return result.data
    if (!result.retryable || attempt >= retries || !canRetry()) throw new ActionError(result.code, result.message)
    await delay(retryDelayMs * 2 ** attempt)
  }
}

export interface JoinResult {
  game_id: string
  code: string
  seq: number
}

/** Lobby entry points: these run before there is a game to sync, so no freshness check. */
export async function createGame(transport: SyncTransport, name: string): Promise<JoinResult> {
  await transport.signIn()
  return (await callWithRetry(transport, 'create_game', {
    p_name: name,
    p_client_action_id: crypto.randomUUID(),
  })) as JoinResult
}

export async function joinGame(transport: SyncTransport, code: string, name: string): Promise<JoinResult> {
  await transport.signIn()
  return (await callWithRetry(transport, 'join_game', {
    p_code: code,
    p_name: name,
    p_client_action_id: crypto.randomUUID(),
  })) as JoinResult
}
