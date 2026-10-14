import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { ownIssuesKeyGuard } from "../middleware/own-issues-key-guard.js";

function createApp(keyScope: Record<string, unknown> | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key", ...(keyScope ? { keyScope } : {}) };
    next();
  });
  app.use(ownIssuesKeyGuard());
  app.all(/.*/, (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("ownIssuesKeyGuard", () => {
  const own = { kind: "own_issues", deniedLabelPrefixes: ["skill:"] };

  it("lets an own-issues key reach who it is, and an issue's record, comments and documents", async () => {
    const app = createApp(own);
    for (const [method, path] of [
      ["get", "/agents/me"],
      ["get", "/issues/CON-1"],
      ["patch", "/issues/11111111-1111-4111-8111-111111111111"],
      ["get", "/issues/CON-1/comments"],
      ["post", "/issues/CON-1/comments"],
      ["get", "/issues/CON-1/documents"],
      ["get", "/issues/CON-1/documents/report"],
      ["put", "/issues/CON-1/documents/report"],
    ] as const) {
      expect((await request(app)[method](path)).status, `${method} ${path}`).toBe(204);
    }
  });

  it("refuses it every other route, those that check only company access first", async () => {
    const app = createApp(own);
    for (const [method, path] of [
      ["post", "/companies/company-1/goals"],
      ["patch", "/goals/g-1"],
      ["post", "/companies/company-1/projects"],
      ["post", "/companies/company-1/labels"],
      ["delete", "/labels/l-1"],
      ["get", "/companies/company-1/issues"],
      ["post", "/companies/company-1/issues"],
      ["delete", "/issues/CON-1/documents/report"],
      ["post", "/issues/CON-1/checkout"],
      ["get", "/agents/agent-2"],
      ["get", "/agents/me/inbox-lite"],
    ] as const) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error).toBe("An own-issues key reaches only its agent's own issues");
    }
  });

  it("leaves every other key alone", async () => {
    for (const scope of [undefined, { kind: "standard" }, { kind: "skill_test", issueId: "i" }]) {
      expect((await request(createApp(scope)).post("/companies/company-1/goals")).status).toBe(204);
    }
  });
});
