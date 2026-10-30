import { describe, expect, it } from "vitest";

import {
  classifyNodeCertificateUsage,
  describeNodeCertificateDeployment,
  isDeploymentWaitingOnAgent,
  nodesUsingCertificate,
  summarizeCertificateChoices,
} from "./node-certificate-context";

describe("classifyNodeCertificateUsage", () => {
  const base = {
    protocolSupportsTls: true,
    tlsEnabled: true,
    realityEnabled: false,
    certificateId: "",
  };

  it("handles protocols without TLS and TLS turned off honestly", () => {
    expect(
      classifyNodeCertificateUsage({
        ...base,
        protocolSupportsTls: false,
        tlsEnabled: true,
        certificateId: "cert",
      }),
    ).toBe("protocol_without_tls");
    expect(classifyNodeCertificateUsage({ ...base, tlsEnabled: false })).toBe(
      "tls_disabled",
    );
  });

  it("never reports a managed certificate for Reality", () => {
    expect(
      classifyNodeCertificateUsage({
        ...base,
        realityEnabled: true,
        certificateId: "cert",
      }),
    ).toBe("reality");
  });

  it("distinguishes a missing from a selected certificate", () => {
    expect(classifyNodeCertificateUsage(base)).toBe("none_selected");
    expect(
      classifyNodeCertificateUsage({ ...base, certificateId: "cert" }),
    ).toBe("managed");
  });
});

describe("describeNodeCertificateDeployment", () => {
  const saved = { certificateId: "cert", serverId: "srv" };
  const input = {
    selectedCertificateId: "cert",
    selectedServerId: "srv",
    saved,
    binding: { status: "pending" as const, phase: null, message: null },
    agentReachable: true,
  };

  it("reports nothing without a selection", () => {
    expect(
      describeNodeCertificateDeployment({
        ...input,
        selectedCertificateId: "",
      }),
    ).toEqual({ kind: "none" });
  });

  it("treats an unsaved selection or server change as applied on save", () => {
    expect(
      describeNodeCertificateDeployment({ ...input, saved: undefined }),
    ).toEqual({ kind: "on_save" });
    expect(
      describeNodeCertificateDeployment({
        ...input,
        selectedCertificateId: "other",
      }),
    ).toEqual({ kind: "on_save" });
    expect(
      describeNodeCertificateDeployment({
        ...input,
        selectedServerId: "other-srv",
      }),
    ).toEqual({ kind: "on_save" });
  });

  it("does not borrow a status when the binding is not reported", () => {
    expect(
      describeNodeCertificateDeployment({ ...input, binding: undefined }),
    ).toEqual({ kind: "unreported" });
  });

  it("passes through the agent-acknowledged status and error detail", () => {
    expect(
      describeNodeCertificateDeployment({
        ...input,
        binding: { status: "error", phase: "write", message: "disk full" },
      }),
    ).toEqual({
      kind: "error",
      phase: "write",
      message: "disk full",
      agentReachable: true,
    });
    expect(
      describeNodeCertificateDeployment({
        ...input,
        binding: { status: "in_use", phase: null, message: null },
      }).kind,
    ).toBe("in_use");
  });

  it("flags a pending install only when the agent stopped reporting", () => {
    const pending = (agentReachable: boolean | undefined) =>
      describeNodeCertificateDeployment({ ...input, agentReachable });
    expect(isDeploymentWaitingOnAgent(pending(false))).toBe(true);
    expect(isDeploymentWaitingOnAgent(pending(true))).toBe(false);
    expect(isDeploymentWaitingOnAgent(pending(undefined))).toBe(false);
    expect(
      isDeploymentWaitingOnAgent(
        describeNodeCertificateDeployment({
          ...input,
          agentReachable: false,
          binding: { status: "in_use", phase: null, message: null },
        }),
      ),
    ).toBe(false);
  });
});

describe("summarizeCertificateChoices", () => {
  it("counts certificates that exist but cannot be selected", () => {
    const certs = [
      { id: "a", ok: true },
      { id: "b", ok: false },
      { id: "c", ok: false },
    ];
    const result = summarizeCertificateChoices(certs, (c) => c.ok);
    expect(result.usable.map((c) => c.id)).toEqual(["a"]);
    expect(result.unusableCount).toBe(2);
  });
});

describe("nodesUsingCertificate", () => {
  const nodes = [
    {
      id: "n1",
      name: "one",
      serverId: "s1",
      certificateId: "cert",
      serverSummary: { name: "Server 1" },
    },
    {
      id: "n2",
      name: "two",
      serverId: "s2",
      certificateId: null,
      serverSummary: { name: "Server 2" },
    },
    {
      id: "n3",
      name: "three",
      serverId: "s2",
      certificateId: "cert",
      serverSummary: { name: "Server 2" },
    },
  ];

  it("lists only referencing nodes with their server", () => {
    expect(nodesUsingCertificate("cert", nodes)).toEqual([
      {
        nodeId: "n1",
        nodeName: "one",
        serverId: "s1",
        serverName: "Server 1",
      },
      {
        nodeId: "n3",
        nodeName: "three",
        serverId: "s2",
        serverName: "Server 2",
      },
    ]);
    expect(nodesUsingCertificate("unused", nodes)).toEqual([]);
  });
});
