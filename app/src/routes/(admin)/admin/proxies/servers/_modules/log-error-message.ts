import { m } from "@/paraglide/messages";

/** Maps relay and agent error codes to operator-facing text. */
export function logErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "timeout":
      return m.agent_logs_error_timeout();
    case "busy":
      return m.agent_logs_error_busy();
    case "offline":
    case "unavailable":
      return m.agent_logs_error_offline();
    case "forbidden":
      return m.agent_logs_error_forbidden();
    case "server_disabled":
      return m.agent_logs_error_server_disabled();
    case "session_replaced":
      return m.agent_logs_error_session_replaced();
    case "unsupported":
    case "unsupported_capability":
      return m.agent_logs_error_unsupported();
    case "overwritten":
      return m.agent_logs_error_overwritten();
    case "restarted":
      return m.agent_logs_error_restarted();
    case "not_found":
      return m.agent_logs_error_not_found();
    case "invalid_request":
      return m.agent_logs_error_invalid_request();
    default:
      return m.agent_logs_error_generic();
  }
}
