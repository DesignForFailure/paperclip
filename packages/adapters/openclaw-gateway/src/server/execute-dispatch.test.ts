import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const websocketState = vi.hoisted(() => ({
  connectionAttempts: 0,
  failConnectAttempts: 0,
  failAgentRequests: 0,
  events: [] as string[],
  messages: [] as string[],
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    readonly attempt: number;

    constructor() {
      super();
      this.attempt = ++websocketState.connectionAttempts;
      websocketState.events.push(`construct:${this.attempt}`);
      queueMicrotask(() => {
        if (this.attempt <= websocketState.failConnectAttempts) {
          this.emit("error", new Error("ECONNREFUSED"));
          return;
        }
        this.emit("open");
        this.emit("message", JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }));
      });
    }

    send(payload: string) {
      const request = JSON.parse(payload) as { id: string; method: string; params?: { message?: string } };
      if (request.method === "agent") websocketState.messages.push(request.params?.message ?? "");
      websocketState.events.push(`send:${request.method}`);
      if (request.method === "agent" && websocketState.failAgentRequests > 0) {
        websocketState.failAgentRequests--;
        queueMicrotask(() => {
          this.emit("close", 1006, Buffer.from("ECONNRESET"));
        });
        return;
      }
      const responsePayload = request.method === "connect"
        ? { protocol: 3 }
        : { status: "ok", runId: "remote-run-1", summary: "done" };
      queueMicrotask(() => {
        this.emit("message", JSON.stringify({
          type: "res",
          id: request.id,
          ok: true,
          payload: responsePayload,
        }));
      });
    }

    close() {}
  }

  return { WebSocket: FakeWebSocket };
});

import { execute } from "./execute.js";

function createContext(input: {
  onDispatch?: () => void;
  onLog?: AdapterExecutionContext["onLog"];
} = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenClaw Agent",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "ws://127.0.0.1:18789",
      disableDeviceAuth: true,
      timeoutSec: 1,
    },
    context: {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "interaction_resolved",
    },
    onLog: input.onLog ?? (async () => {}),
    onDispatch: input.onDispatch,
  };
}

describe("openclaw_gateway execute dispatch boundary", () => {
  beforeEach(() => {
    websocketState.connectionAttempts = 0;
    websocketState.failConnectAttempts = 0;
    websocketState.failAgentRequests = 0;
    websocketState.events = [];
    websocketState.messages = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])("sends conversation policy without the issue-completion workflow (resumed=%s)", async (resumed) => {
    const ctx = createContext();
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      ...ctx.context,
      conversationMode: true,
      paperclipTaskMarkdown: directive,
      paperclipTaskMarkdownCompact: directive,
      paperclipWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(websocketState.messages).toHaveLength(1);
    const prompt = websocketState.messages[0]!;
    expect(prompt).toContain(directive);
    expect(prompt).toContain("X-Paperclip-Run-Id");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
    expect(prompt).not.toContain('"status":"done"');
    expect(prompt).not.toContain("GET /api/issues/{issueId}/comments");
  });

  it("reports dispatch after transport setup and before the remote agent request", async () => {
    const onDispatch = vi.fn(() => {
      websocketState.events.push("dispatch");
    });

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({ exitCode: 0 });
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(websocketState.events).toEqual([
      "construct:1",
      "send:connect",
      "dispatch",
      "send:agent",
    ]);
  });

  it("retains the continuation gate through transient connection backoff", async () => {
    vi.useFakeTimers();
    websocketState.failConnectAttempts = 1;
    let resolveBackoff!: () => void;
    const backoffReached = new Promise<void>((resolve) => {
      resolveBackoff = resolve;
    });
    let resolveAuthorityChange!: () => void;
    const authorityChange = new Promise<void>((resolve) => {
      resolveAuthorityChange = resolve;
    });
    const onDispatch = vi.fn(resolveAuthorityChange);
    const resultPromise = execute(createContext({
      onDispatch,
      onLog: async (_stream, chunk) => {
        if (chunk.includes("transient error, retry")) resolveBackoff();
      },
    }));

    await backoffReached;
    expect(websocketState.connectionAttempts).toBe(1);
    expect(onDispatch).not.toHaveBeenCalled();

    let authorityChangeSettled = false;
    void authorityChange.then(() => {
      authorityChangeSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(authorityChangeSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;
    await authorityChange;

    expect(result).toMatchObject({ exitCode: 0 });
    expect(websocketState.connectionAttempts).toBe(2);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(authorityChangeSettled).toBe(true);
  });

  it("does not retry after the remote-work boundary has been crossed", async () => {
    websocketState.failAgentRequests = 1;
    const onDispatch = vi.fn();

    const result = await execute(createContext({ onDispatch }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "openclaw_gateway_request_failed",
    });
    expect(websocketState.connectionAttempts).toBe(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });
});

describe("openclaw_gateway wakePrompt", () => {
  const claimedApiKeyPath = "/srv/openclaw/workspace/paperclip-claimed-api-key.json";
  const paperclipApiUrl = "http://127.0.0.1:3100";

  beforeEach(() => {
    websocketState.connectionAttempts = 0;
    websocketState.failConnectAttempts = 0;
    websocketState.failAgentRequests = 0;
    websocketState.events = [];
    websocketState.messages = [];
  });

  function createWakeContext(config: Record<string, unknown> = {}): AdapterExecutionContext {
    const ctx = createContext();
    ctx.config = { ...ctx.config, paperclipApiUrl, claimedApiKeyPath, ...config };
    ctx.context = {
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "issue_assigned",
      paperclipTaskMarkdown: 'Paperclip task context:\n- Issue: "PAP-7"\n- Title: "Copy the figures"',
      paperclipWake: {
        reason: "issue_assigned",
        issue: {
          id: "issue-1",
          identifier: "PAP-7",
          title: "Copy the figures",
          description: "Copy 300, 4200 and 30F into a comment.",
          status: "todo",
        },
      },
    };
    return ctx;
  }

  async function sentMessage(ctx: AdapterExecutionContext): Promise<string> {
    websocketState.messages = [];
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(websocketState.messages).toHaveLength(1);
    return websocketState.messages[0]!;
  }

  it.each([false, true])(
    "sends the structured wake prompt without the API procedure or key (conversation=%s)",
    async (conversationMode) => {
      const ctx = createWakeContext({ wakePrompt: "paperclip" });
      if (conversationMode) ctx.context = { ...ctx.context, conversationMode: true };
      const message = await sentMessage(ctx);

      expect(message).toContain("- Agent ID: agent-1");
      expect(message).toContain("- Company ID: company-1");
      expect(message).toContain("- Run ID: run-1");
      expect(message).toContain("- Issue ID: issue-1");
      expect(message).toContain("## Paperclip Wake Payload");
      expect(message).toContain("- issue: PAP-7 Copy the figures");
      expect(message).toContain('- Issue: "PAP-7"');
      expect(message).toContain("Structured wake payload JSON:");
      expect(message).toContain('"identifier":"PAP-7"');
      for (const forbidden of [
        "PAPERCLIP_API_KEY",
        claimedApiKeyPath,
        paperclipApiUrl,
        "Authorization",
        "X-Paperclip-Run-Id",
        "/api/issues",
        "curl",
        "cloud adapter",
        "Execution contract",
      ]) {
        expect(message).not.toContain(forbidden);
      }
    },
  );

  it("keeps the payloadTemplate message and the communication guidance around the paperclip wake prompt", async () => {
    const ctx = createWakeContext({
      wakePrompt: "paperclip",
      payloadTemplate: { message: "Template preface." },
    });
    ctx.context = { ...ctx.context, paperclipTaskCommunicationGuidance: "## Communication in Slack" };
    const message = await sentMessage(ctx);

    expect(message.startsWith("## Communication in Slack\n\nTemplate preface.\n\nYou are OpenClaw Agent")).toBe(true);
    expect(message.match(/## Communication in Slack/g)).toHaveLength(1);
  });

  it("sends the cloud adapter procedure when wakePrompt is unset, cloud, or unrecognised", async () => {
    const unset = await sentMessage(createWakeContext());
    expect(unset.startsWith("Paperclip wake event for a cloud adapter.")).toBe(true);
    expect(unset).toContain(`Load PAPERCLIP_API_KEY from ${claimedApiKeyPath}`);
    expect(unset).toContain(`PAPERCLIP_API_URL=${paperclipApiUrl}/`);
    expect(unset).toContain("- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.");
    expect(unset).toContain("POST /api/issues/{issueId}/checkout");
    expect(unset).toContain("Execution contract:");

    expect(await sentMessage(createWakeContext({ wakePrompt: "cloud" }))).toBe(unset);
    expect(await sentMessage(createWakeContext({ wakePrompt: "something-else" }))).toBe(unset);
  });
});
