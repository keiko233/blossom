import { describe, expect, it } from "vitest";

import template from "@/lib/agent-bootstrap-template.sh?raw";

import {
  assertBootstrapOrigin,
  buildBootstrapCommands,
  normalizeBootstrapVersion,
  renderAgentBootstrapScript,
} from "./agent-bootstrap";
import {
  generateEnrollmentGrant,
  hashEnrollmentGrantSecret,
} from "./agent-enrollment";

describe("assertBootstrapOrigin", () => {
  it("accepts HTTPS and loopback HTTP origins", () => {
    expect(assertBootstrapOrigin("https://blossom.example.test")).toBe(
      "https://blossom.example.test",
    );
    expect(assertBootstrapOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(assertBootstrapOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("refuses plain HTTP on a public host and non-origin URLs", () => {
    expect(() =>
      assertBootstrapOrigin("http://blossom.example.test"),
    ).toThrow();
    expect(() =>
      assertBootstrapOrigin("https://blossom.example.test/path"),
    ).toThrow();
  });
});

describe("normalizeBootstrapVersion", () => {
  it("maps latest and v-prefixed versions to an image tag", () => {
    expect(normalizeBootstrapVersion("latest")).toEqual({
      version: "latest",
      image: "ghcr.io/keiko233/blossom/server-agent:latest",
    });
    expect(normalizeBootstrapVersion("v1.4.2")).toEqual({
      version: "1.4.2",
      image: "ghcr.io/keiko233/blossom/server-agent:1.4.2",
    });
  });

  it("refuses malformed versions", () => {
    expect(() => normalizeBootstrapVersion("main")).toThrow();
    expect(() => normalizeBootstrapVersion("1.4")).toThrow();
  });
});

describe("renderAgentBootstrapScript", () => {
  const grant = generateEnrollmentGrant().secret;

  it("substitutes every placeholder and never enables shell tracing", () => {
    const script = renderAgentBootstrapScript({
      publicOrigin: "http://localhost:3000",
      enrollmentGrant: grant,
      release: "1.4.2",
    });
    expect(script).not.toContain("@@");
    expect(script).not.toMatch(/\n\s*set -x/);
    expect(script).toContain(grant);
    expect(script).toContain("--host");
    expect(script).toContain("ghcr.io/keiko233/blossom/server-agent:1.4.2");
    expect(template).toContain("@@ENROLLMENT_GRANT@@");
  });

  it("quotes the grant and origin", () => {
    const script = renderAgentBootstrapScript({
      publicOrigin: "https://blossom.example.test",
      enrollmentGrant: grant,
      release: "latest",
    });
    expect(script).toContain(`ORIGIN='https://blossom.example.test'`);
    expect(script).toContain(`ENROLLMENT_GRANT='${grant}'`);
  });

  it("refuses a malformed grant", () => {
    expect(() =>
      renderAgentBootstrapScript({
        publicOrigin: "https://blossom.example.test",
        enrollmentGrant: "egr_short",
        release: "latest",
      }),
    ).toThrow();
  });
});

describe("buildBootstrapCommands", () => {
  it("builds both install commands from one URL", () => {
    const { secret, tokenHash } = generateEnrollmentGrant();
    expect(tokenHash).toBe(hashEnrollmentGrantSecret(secret));
    const commands = buildBootstrapCommands({
      publicOrigin: "http://localhost:3000",
      enrollmentGrant: secret,
    });
    expect(commands.installUrl).toBe(
      `http://localhost:3000/api/agent/install/${secret}.sh`,
    );
    expect(commands.dockerCommand).toBe(
      `curl -fsSL ${commands.installUrl} | sh`,
    );
    expect(commands.hostCommand).toBe(
      `curl -fsSL ${commands.installUrl} | sh -s -- --host`,
    );
  });
});
