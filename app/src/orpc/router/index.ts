import { agentHeartbeat, getAgentConfig } from "../proxy/agent";
import { addTodo, listTodos } from "./todos";

export default {
  listTodos,
  addTodo,
  // Public agent surface (per-node token auth). Admin operations are server
  // functions in `@/lib/nodes`, deliberately not exposed here.
  agent: {
    getConfig: getAgentConfig,
    heartbeat: agentHeartbeat,
  },
};
