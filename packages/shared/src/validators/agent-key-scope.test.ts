import { describe, expect, it } from "vitest";
import { normalizeAgentApiKeyScope, readAgentApiKeyScope } from "./agent.js";

describe("readAgentApiKeyScope", () => {
  const ownIssues = { kind: "own_issues", deniedLabelPrefixes: ["skill:"] };

  it("reads no scope at all as a standard key, as keys made before scopes are stored", () => {
    expect(readAgentApiKeyScope(null)).toEqual({ kind: "standard" });
    expect(readAgentApiKeyScope(undefined)).toEqual({ kind: "standard" });
  });

  it("keeps a readable scope as it is stored", () => {
    expect(readAgentApiKeyScope(ownIssues)).toEqual(ownIssues);
    expect(readAgentApiKeyScope({ kind: "standard" })).toEqual({ kind: "standard" });
  });

  it("reads a scope it cannot parse as no scope it may use, never a standard one", () => {
    expect(readAgentApiKeyScope({ ...ownIssues, allowedProjectIds: [] })).toBeNull();
    expect(readAgentApiKeyScope({ kind: "own_issues", deniedLabelPrefixes: Array.from({ length: 21 }, (_, i) => `p${i}:`) }))
      .toBeNull();
    expect(readAgentApiKeyScope({ kind: "a_later_kind" })).toBeNull();
    expect(readAgentApiKeyScope({})).toBeNull();
    expect(readAgentApiKeyScope("own_issues")).toBeNull();
  });

  it("leaves normalizeAgentApiKeyScope, the display form, as it was", () => {
    expect(normalizeAgentApiKeyScope(ownIssues)).toEqual(ownIssues);
    expect(normalizeAgentApiKeyScope(null)).toEqual({ kind: "standard" });
  });
});
