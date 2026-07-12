import {
  agentHeartbeat,
  getAgentConfig,
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
    heartbeat: agentHeartbeat,
    reportTraffic: reportAgentTraffic,
  },
};
