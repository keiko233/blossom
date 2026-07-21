#!/usr/bin/env python3

import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class State:
    heartbeat = None
    certificate_event = None


def response_document(certificate_pem: str, private_key_pem: str) -> dict:
    certificate_id = "test-cert"
    return {
        "apiVersion": 2,
        "agent": {
            "configPollIntervalSeconds": 5,
            "heartbeatIntervalSeconds": 5,
        },
        "singbox": {
            "revision": "sha256:managed-tls-integration",
            "materializedNodeIds": ["node-test"],
            "config": {
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
                            "server_name": "edge.example.com",
                            # Reproduce the historical control-plane payload that
                            # caused sing-box to ignore the valid managed paths.
                            "certificate": ["stale-non-pem-certificate"],
                            "certificate_path": f"/var/lib/blossom-agent/certificates/{certificate_id}/current/fullchain.pem",
                            "key": ["stale-non-pem-key"],
                            "key_path": f"/var/lib/blossom-agent/certificates/{certificate_id}/current/private-key.pem",
                        },
                    }
                ],
                "outbounds": [{"type": "direct", "tag": "direct"}],
            },
        },
        "actions": [
            {
                "id": f"certificate:{certificate_id}:server-test:1:install",
                "type": "certificate.install",
                "certificateId": certificate_id,
                "generation": 1,
                "domains": ["edge.example.com"],
                "reportRequired": True,
                "material": {
                    "certificatePem": certificate_pem,
                    "privateKeyPem": private_key_pem,
                    "notBefore": "2026-01-01T00:00:00Z",
                    "notAfter": "2030-01-01T00:00:00Z",
                    "fingerprintSha256": hashlib.sha256(
                        certificate_pem.encode()
                    ).hexdigest(),
                },
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
            self.send_json(
                200,
                {
                    "heartbeat": State.heartbeat,
                    "certificateEvent": State.certificate_event,
                },
            )
        elif self.path == "/api/agent/config/v2":
            self.send_json(200, self.document)
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/api/agent/certificates/events":
            State.certificate_event = body
            self.send_json(200, {"ok": True})
        elif self.path == "/api/agent/heartbeat":
            State.heartbeat = body
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--certificate", type=Path, required=True)
    parser.add_argument("--private-key", type=Path, required=True)
    args = parser.parse_args()

    Handler.document = response_document(
        args.certificate.read_text(), args.private_key.read_text()
    )
    ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
