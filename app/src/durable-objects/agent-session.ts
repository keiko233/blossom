/**
 * Nitro builds do not deploy Durable Objects. `vite.config.ts` aliases this
 * specifier to `agent-session.cloudflare.ts` for the Cloudflare target.
 */
export class AgentSessionDO {}
