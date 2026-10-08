// Static imports exactly as janitor's Worker bundle would pull them in:
// `clanka/Agent` statically imports `clanka/AgentExecutor`, which statically
// imports node:vm / node:os / node:stream / node:console.
import * as Agent from "clanka/Agent"
import * as AgentExecutor from "clanka/AgentExecutor"
import * as AgentOutput from "clanka/AgentOutput"

export default {
  async fetch(_request: Request): Promise<Response> {
    return Response.json({
      ok: true,
      agentExports: Object.keys(Agent),
      executorExports: Object.keys(AgentExecutor),
      outputExports: Object.keys(AgentOutput).length,
    })
  },
}
