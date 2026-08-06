#!/usr/bin/env python3

import argparse
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class State:
    lock = threading.Lock()
    heartbeats = []
    traffic = []


def v3_document(certificate_pem: str, private_key_pem: str, revision: str) -> dict:
    return {
        "apiVersion": 3,
        "agent": {
            "configPollIntervalSeconds": 5,
            "heartbeatIntervalSeconds": 5,
        },
        "desiredRevision": revision,
        "materializedNodeIds": ["node-test"],
        "singboxConfig": {
            "log": {"level": "info", "timestamp": True},
            "inbounds": [
                {
                    "type": "vless",
                    "tag": "node-node-test",
                    "listen": "0.0.0.0",
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
                        "certificate_path": "/var/lib/blossom-agent/certificates/test-cert/current/fullchain.pem",
                        "key": ["stale-non-pem-key"],
                        "key_path": "/var/lib/blossom-agent/certificates/test-cert/current/private-key.pem",
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
    document = None

    def send_json(self, status: int, value: object) -> None:
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        elif self.path == "/state":
            with State.lock:
                heartbeats = list(State.heartbeats)
                traffic = list(State.traffic)
            self.send_json(
                200,
                {
                    "heartbeats": heartbeats,
                    "lastHeartbeat": heartbeats[-1] if heartbeats else None,
                    "traffic": traffic,
                },
            )
        elif self.path == "/api/agent/config/v3":
            self.send_json(200, self.document)
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
        else:
            self.send_json(404, {"error": "not found"})

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    parser.add_argument("--private-key", type=Path, required=True)
    parser.add_argument("--revision", default="sha256:managed-tls-integration")
    args = parser.parse_args()

    Handler.document = v3_document(
        args.certificate.read_text(), args.private_key.read_text(), args.revision
    )
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
