import {
  agentHeartbeat,
  getAgentConfigV3,
  reportAgentTraffic,
} from "../proxy/agent";

export default {
  // Public agent surface (per-server token auth). Admin operations are server
  // functions, deliberately not exposed here.
  agent: {
    getConfigV3: getAgentConfigV3,
    heartbeat: agentHeartbeat,
    reportTraffic: reportAgentTraffic,
  },
};
