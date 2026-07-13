import {
  agentHeartbeat,
  getAgentConfig,
  getAgentConfigV2,
  reportAgentTraffic,
} from "../proxy/agent";
import { addTodo, listTodos } from "./todos";

export default {
  listTodos,
  addTodo,
  // Public agent surface (per-server token auth). Admin operations are server
  // functions, deliberately not exposed here.
  agent: {
    getConfig: getAgentConfig,
    getConfigV2: getAgentConfigV2,
    heartbeat: agentHeartbeat,
    reportTraffic: reportAgentTraffic,
  },
};
