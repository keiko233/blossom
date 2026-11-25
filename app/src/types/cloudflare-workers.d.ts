interface CloudflareEnv {
  HYPERDRIVE?: {
    connectionString: string;
  };
  HYPERDRIVE_FRESH?: {
    connectionString: string;
  };
  DATABASE_URL?: string;
  AGENT_SESSION_DO?: DurableObjectNamespace;
  SEND_EMAIL?: SendEmail;
}

interface EmailAddress {
  email: string;
  name?: string;
}

interface EmailSendResult {
  messageId: string;
}

/** Structured message accepted by the Email Service `send()` binding. */
interface EmailMessageBuilder {
  to?: string | EmailAddress | (string | EmailAddress)[];
  cc?: string | EmailAddress | (string | EmailAddress)[];
  bcc?: string | EmailAddress | (string | EmailAddress)[];
  from: string | EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | EmailAddress;
}

interface SendEmail {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}

interface DurableObjectId {}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  acceptWebSocket(webSocket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  readonly storage: DurableObjectStorage;
}

declare class WebSocketPair {
  readonly 0: WebSocket;
  readonly 1: WebSocket;
}

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

declare module "cloudflare:workers" {
  export const env: CloudflareEnv;

  export class DurableObject<Env = CloudflareEnv> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
