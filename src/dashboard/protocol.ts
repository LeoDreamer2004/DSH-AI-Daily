/** Shared Connection transport coordinates for the AI Daily dashboard. */

/** Harness's authenticated shared API channel. */
export const AI_DAILY_RPC_CHANNEL = '/api'

/** Namespace reserved for AI Daily endpoint methods on the shared channel. */
export const AI_DAILY_RPC_METHOD_PREFIX = 'ai-daily.'

/** Dashboard endpoints exposed by the Host plugin. */
export const AI_DAILY_RPC_ENDPOINTS = [
  'snapshot',
  'crawl',
  'summarize',
  'retry-failures',
  'operation-status',
  'reanalyze',
  'article',
] as const

export type AiDailyRpcEndpoint = (typeof AI_DAILY_RPC_ENDPOINTS)[number]

/** Convert one dashboard endpoint into its namespaced Connection method. */
export function aiDailyRpcMethod(endpoint: AiDailyRpcEndpoint): string {
  return `${AI_DAILY_RPC_METHOD_PREFIX}${endpoint}`
}

/** Convert one dashboard endpoint into its exact authenticated HTTP path. */
export function aiDailyRpcPath(endpoint: AiDailyRpcEndpoint): string {
  return `${AI_DAILY_RPC_CHANNEL}/${aiDailyRpcMethod(endpoint)}`
}
