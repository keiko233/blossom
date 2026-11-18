#!/usr/bin/env python3
"""Minimal mock control plane for the managed-TLS lifecycle test.

Besides the HTTP agent surface (`config/v3`, `heartbeat`, `traffic`), the mock
can serve the agent WebSocket at `/api/agent/ws` so the lifecycle test
exercises `hello`/`welcome`, a pushed `config.notify`, the resulting
`config.ack`, and a reconnect. The WS server is a small RFC 6455
implementation over the standard library so the test image needs no extra
Python packages; it is enabled with `--ws` (or `MOCK_WS=1`).
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class State:
    lock = threading.Lock()
    heartbeats = []
    traffic = []
    ws_connections = 0
    ws_hellos = []
    ws_acks = []
    ws_enabled = False
    mode = "valid"


def v3_document(
    certificate_pem: str, private_key_pem: str, revision: str, mode: str
) -> dict:
    runtime_failure = mode == "runtime-failure"
    return {
        "apiVersion": 3,
        "agent": {
            "configPollIntervalSeconds": 5,
            "heartbeatIntervalSeconds": 5,
        },
        "desiredRevision": (
            "sha256:managed-tls-runtime-failure" if runtime_failure else revision
        ),
        "materializedNodeIds": ["node-test"],
        "singboxConfig": {
            "log": {"level": "info", "timestamp": True},
            "inbounds": [
                {
                    "type": "vless",
                    "tag": "node-node-test",
                    # This TEST-NET address passes `sing-box check` but is not
                    # assigned inside the container, so the replacement
                    # process fails at runtime and exercises LKG rollback.
                    "listen": "192.0.2.123" if runtime_failure else "0.0.0.0",
                    "listen_port": 18443,
                    "users": [
                        {
                            "name": "integration-test",
                            "uuid": "550e8400-e29b-41d4-a716-446655440000",
                        }
                    ],
                    "tls": {
                        "enabled": True,
                        # Reproduce the historical control-plane payload that
                        # caused sing-box to ignore valid managed paths: stale
                        # inline material and control-plane paths the agent must
                        # never trust. The V3 agent strips and replaces these.
                        "server_name": "edge.example.com",
                        "certificate": ["stale-non-pem-certificate"],
                        "certificate_path": "/data/state/certificates/test-cert/current/fullchain.pem",
                        "key": ["stale-non-pem-key"],
                        "key_path": "/data/state/certificates/test-cert/current/private-key.pem",
                    },
                }
            ],
            "outbounds": [{"type": "direct", "tag": "direct"}],
        },
        "managedTlsBindings": [
            {
                "nodeId": "node-test",
                "inboundTag": "node-node-test",
                "certificateId": "test-cert",
                "generation": 1,
                "serverName": "edge.example.com",
            }
        ],
        "certificateArtifacts": [
            {
                "certificateId": "test-cert",
                "generation": 1,
                "domains": ["edge.example.com"],
                "fingerprintSha256": hashlib.sha256(
                    certificate_pem.encode()
                ).hexdigest(),
                "notBefore": "2020-01-01T00:00:00Z",
                "notAfter": "2040-01-01T00:00:00Z",
                "certificatePem": certificate_pem,
                "privateKeyPem": private_key_pem,
            }
        ],
    }


class Handler(BaseHTTPRequestHandler):
    # Real control planes answer HTTP/1.1; the agent classifies an upgrade
    # refused with 404/426/501 as "WebSockets unavailable" only when it can
    # read the status, which needs a 1.1 response.
    protocol_version = "HTTP/1.1"
    document = None
    hijacked = False

    def send_json(self, status: int, value: object) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def finish(self) -> None:
        if self.hijacked:
            return
        super().finish()

    def do_GET(self) -> None:
        if self.path == "/api/agent/ws":
            self.handle_upgrade()
        elif self.path == "/health":
            self.send_json(200, {"ok": True})
        elif self.path == "/state":
            with State.lock:
                heartbeats = list(State.heartbeats)
                traffic = list(State.traffic)
                ws_connections = State.ws_connections
                ws_hellos = list(State.ws_hellos)
                ws_acks = list(State.ws_acks)
                ws_enabled = State.ws_enabled
                mode = State.mode
            self.send_json(
                200,
                {
                    "heartbeats": heartbeats,
                    "lastHeartbeat": heartbeats[-1] if heartbeats else None,
                    "traffic": traffic,
                    "mode": mode,
                    "wsEnabled": ws_enabled,
                    "wsConnections": ws_connections,
                    "wsHellos": ws_hellos,
                    "wsAcks": ws_acks,
                },
            )
        elif self.path == "/api/agent/config/v3":
            with State.lock:
                mode = State.mode
            self.send_json(
                200,
                v3_document(
                    self.certificate_pem,
                    self.private_key_pem,
                    self.revision,
                    mode,
                ),
            )
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/api/agent/heartbeat":
            with State.lock:
                State.heartbeats.append(body)
            self.send_json(200, {"ok": True})
        elif self.path == "/api/agent/traffic":
            with State.lock:
                State.traffic.append(body)
            self.send_json(200, {"accepted": len(body.get("entries", [])), "dropped": 0})
        elif self.path == "/control":
            mode = body.get("mode")
            if mode not in {"valid", "runtime-failure"}:
                self.send_json(400, {"error": "unsupported mode"})
                return
            with State.lock:
                State.mode = mode
            self.send_json(200, {"mode": mode})
        elif self.path == "/control/notify":
            revision = body.get("desiredRevision", self.revision)
            seq = body.get("desiredRevisionSeq", 1)
            delivered = notify_agents(
                {
                    "v": 1,
                    "type": "config.notify",
                    "ts": utc_now(),
                    "payload": {
                        "desiredRevisionSeq": seq,
                        "desiredRevision": revision,
                        "reason": "mock push",
                    },
                }
            )
            self.send_json(200, {"delivered": delivered})
        elif self.path == "/control/ws-close":
            for client in list(WS_CLIENTS):
                client.close()
            WS_CLIENTS.clear()
            self.send_json(200, {"closed": True})
        else:
            self.send_json(404, {"error": "not found"})

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def handle_upgrade(self) -> None:
        if not State.ws_enabled:
            self.send_json(404, {"error": "websocket disabled"})
            return
        if not self.headers.get("Authorization", "").startswith("Bearer "):
            self.send_json(401, {"error": "missing agent token"})
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode()
        )
        self.wfile.flush()
        self.hijacked = True
        self.close_connection = True
        client = WsClient(self.connection)
        WS_CLIENTS.append(client)
        with State.lock:
            State.ws_connections += 1
        client.serve()
        if client in WS_CLIENTS:
            WS_CLIENTS.remove(client)


WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WS_CLIENTS: list["WsClient"] = []


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ws_frame(opcode: int, payload: bytes) -> bytes:
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < (1 << 16):
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload


class WsClient:
    """One upgraded agent connection."""

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.lock = threading.Lock()
        self.alive = True

    def send_json(self, value: dict) -> bool:
        data = json.dumps(value).encode()
        try:
            with self.lock:
                self.sock.sendall(ws_frame(0x1, data))
            return True
        except OSError:
            self.alive = False
            return False

    def close(self) -> None:
        self.alive = False
        try:
            with self.lock:
                self.sock.sendall(ws_frame(0x8, b""))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def read_exact(self, count: int) -> bytes | None:
        buffer = bytearray()
        while len(buffer) < count:
            chunk = self.sock.recv(count - len(buffer))
            if not chunk:
                return None
            buffer.extend(chunk)
        return bytes(buffer)

    def read_frame(self) -> tuple[int, bytes] | None:
        header = self.read_exact(2)
        if header is None:
            return None
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            extended = self.read_exact(2)
            if extended is None:
                return None
            length = struct.unpack("!H", extended)[0]
        elif length == 127:
            extended = self.read_exact(8)
            if extended is None:
                return None
            length = struct.unpack("!Q", extended)[0]
        mask = self.read_exact(4) if masked else None
        if masked and mask is None:
            return None
        payload = self.read_exact(length) if length else b""
        if payload is None:
            return None
        if mask:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload

    def serve(self) -> None:
        first = self.read_frame()
        if first is None or first[0] != 0x1:
            self.close()
            return
        try:
            hello = json.loads(first[1])
        except ValueError:
            self.close()
            return
        if hello.get("type") != "hello":
            self.close()
            return
        with State.lock:
            State.ws_hellos.append(hello)
        self.send_json(AgentHello.welcome())
        while self.alive:
            frame = self.read_frame()
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:
                break
            if opcode == 0x9:
                with self.lock:
                    self.sock.sendall(ws_frame(0xA, payload))
                continue
            if opcode != 0x1:
                continue
            try:
                message = json.loads(payload)
            except ValueError:
                continue
            with State.lock:
                if message.get("type") == "config.ack":
                    State.ws_acks.append(message)
        self.close()


class AgentHello:
    """The `welcome` the mock sends after each `hello`."""

    @classmethod
    def welcome(cls) -> dict:
        return {
            "v": 1,
            "type": "welcome",
            "ts": utc_now(),
            "payload": {
                "serverId": "mock-server",
                "serverName": "mock-edge",
                "protocolVersion": 1,
                "desiredRevisionSeq": 1,
                "desiredRevision": "sha256:managed-tls-integration",
                "pollIntervalSeconds": 5,
                "heartbeatIntervalSeconds": 5,
                "reconnectBeforeSeconds": 30,
            },
        }


def notify_agents(frame: dict) -> int:
    delivered = 0
    for client in list(WS_CLIENTS):
        if client.alive and client.send_json(frame):
            delivered += 1
    return delivered


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    parser.add_argument("--private-key", type=Path, required=True)
    parser.add_argument("--revision", default="sha256:managed-tls-integration")
    parser.add_argument("--ws", action="store_true", default=os.environ.get("MOCK_WS") == "1")
    args = parser.parse_args()

    Handler.certificate_pem = args.certificate.read_text()
    Handler.private_key_pem = args.private_key.read_text()
    Handler.revision = args.revision
    State.ws_enabled = args.ws
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
