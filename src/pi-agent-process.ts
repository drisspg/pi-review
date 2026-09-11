/** Own a headless Pi CLI so background reviews use the same runtime/auth as terminals. */
import type { AgentSessionEvent, RpcSessionState, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { piLaunch, piModelArgs } from "./pi-launch.js";
import { createPiToolBridge } from "./pi-tool-bridge.js";
import { REVIEW_WORKSPACE_ENV, reviewWorkspaceEnvironment, type PiReviewWorkspace } from "./pi-review-workspace.js";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_RECORD_CHARS = 16_000_000;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Model = NonNullable<RpcSessionState["model"]>;
type Options = { cwd: string; sessionDir: string; thinkingLevel: string; tools?: string[]; customTools: ToolDefinition[]; workspace?: PiReviewWorkspace };

type RpcData = {
  get_state: RpcSessionState;
  prompt: undefined;
  abort: undefined;
  get_available_models: { models: Model[] };
  get_available_thinking_levels: { levels: string[] };
  set_model: Model;
  set_thinking_level: undefined;
};

/** One launcher-owned process with bounded RPC commands and server-owned custom tools. */
export class PiAgentProcess {
  private child: ChildProcessWithoutNullStreams;
  private bridge: Awaited<ReturnType<typeof createPiToolBridge>>;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private nextId = 0;
  private output = "";
  private stderr = "";
  private failure: Error | null = null;
  private settled: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private exited: Promise<void>;
  private processExited = false;
  private disposal: Promise<void> | null = null;
  private state!: RpcSessionState;
  messages: unknown[] = [];
  isStreaming = false;

  private constructor(launch: ReturnType<typeof piLaunch>, cwd: string, bridge: PiAgentProcess["bridge"]) {
    this.bridge = bridge;
    this.child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: "pipe", detached: process.platform !== "win32" });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        // Reap any launcher children that outlive the group leader.
        this.signal("SIGKILL");
        this.processExited = true;
        this.fail(new Error(`Pi agent exited (${signal ?? code}). ${this.stderr}`));
        resolve();
        void this.dispose();
      });
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.setEncoding("utf8").on("data", (text: string) => { this.stderr = (this.stderr + text).slice(-8_000); });
    this.child.stdout.setEncoding("utf8").on("data", (text: string) => this.receive(text));
  }

  /** Start one isolated CLI, await actual RPC readiness, and clean up failed startups. */
  static async create(options: Options): Promise<PiAgentProcess> {
    const modelArgs = piModelArgs(options.cwd);
    const extension = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./pi-agent-extension.ts" : "./pi-agent-extension.js", import.meta.url));
    const args = ["--mode", "rpc", "--session-dir", options.sessionDir, ...modelArgs, "--thinking", options.thinkingLevel, "--extension", extension];
    if (options.tools?.length === 0) args.push("--no-tools");
    else if (options.tools) args.push("--tools", options.tools.join(","));
    const launch = piLaunch(args);
    delete launch.env[REVIEW_WORKSPACE_ENV];
    if (options.workspace) Object.assign(launch.env, reviewWorkspaceEnvironment(options.workspace));
    const bridge = await createPiToolBridge(options.customTools);
    let session: PiAgentProcess;
    try {
      session = new PiAgentProcess({ ...launch, env: { ...launch.env, ...bridge.env } }, options.cwd, bridge);
    } catch (error) {
      await bridge.close();
      throw error;
    }
    try {
      session.state = await session.request("get_state");
      if (!bridge.metadata.ready) throw new Error("Pi Review's tool extension did not initialize. Check Pi extension startup errors.");
      if (modelArgs.length && (session.model?.provider !== modelArgs[1] || session.model?.id !== modelArgs[3])) {
        throw new Error(`Pi did not select the configured model ${modelArgs[1]}/${modelArgs[3]}; refusing a fallback.`);
      }
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  get closed() { return this.failure != null; }
  get model() { return this.state.model; }
  get thinkingLevel() { return this.state.thinkingLevel; }
  get sessionFile() { return this.state.sessionFile; }
  get sessionId() { return this.state.sessionId; }
  get sessionName() { return this.state.sessionName; }
  getActiveToolNames() { return this.bridge.metadata.activeTools; }
  getAllTools() { return this.bridge.metadata.tools; }

  /** Subscribe before prompting so no early streaming events are lost. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Complete only at agent_settled, never at an intermediate retry's agent_end. */
  async prompt(message: string): Promise<void> {
    if (this.settled) throw new Error("Pi session is already prompting");
    this.messages = [];
    let finish!: () => void;
    const completion = new Promise<void>((resolve, reject) => {
      finish = resolve;
      this.settled = { resolve, reject };
    });
    // Observe early exit even while the acceptance response is still pending.
    void completion.catch(() => undefined);
    try {
      await this.request("prompt", { message });
      const accepted = await this.request("get_state");
      // An extension may handle input without starting an agent run, in which
      // case RPC acknowledges it but emits no agent_settled event.
      if (!accepted.isStreaming && !accepted.isCompacting && !accepted.pendingMessageCount) finish();
      await completion;
      this.state = await this.request("get_state");
    } finally {
      this.settled = null;
    }
  }

  async getAvailableModels(): Promise<Model[]> {
    return (await this.request("get_available_models")).models;
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return (await this.request("get_available_thinking_levels")).levels;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.request("set_model", { provider, modelId });
    this.state = await this.request("get_state");
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request("set_thinking_level", { level });
    this.state = await this.request("get_state");
  }

  async abort(): Promise<void> {
    if (!this.closed) await this.request("abort");
  }

  /** Stop the entire owned process group and wait for exit before releasing tools/checkouts. */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.fail(new Error("Pi session disposed"));
      this.signal("SIGTERM");
      const timer = setTimeout(() => this.signal("SIGKILL"), 1_000);
      try {
        await this.exited;
      } finally {
        clearTimeout(timer);
        await this.bridge.close();
      }
    })();
    return this.disposal;
  }

  /** Signal only the process group created by this instance. */
  private signal(signal: NodeJS.Signals): void {
    if (this.child.pid == null || this.processExited) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  /** Reject all outstanding work on transport failure, including accepted prompts. */
  private fail(error: Error): void {
    this.failure ??= error;
    this.isStreaming = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.settled?.reject(this.failure);
  }

  /** Bound command acceptance/state calls; model execution ends via agent_settled or abort. */
  private request<K extends keyof RpcData>(type: K, payload: Record<string, unknown> = {}): Promise<RpcData[K]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Pi ${type} timed out. ${this.stderr}`));
        void this.dispose();
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(value as RpcData[K]), reject, timer });
      this.child.stdin.write(`${JSON.stringify({ type, id, ...payload })}\n`);
    });
  }

  /** RPC records are LF-delimited; StringDecoder in setEncoding preserves split UTF-8. */
  private receive(text: string): void {
    this.output += text;
    let newline: number;
    while ((newline = this.output.indexOf("\n")) !== -1) {
      if (newline > MAX_RECORD_CHARS) {
        this.fail(new Error("Pi RPC record exceeded the size limit"));
        void this.dispose();
        return;
      }
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      let packet: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed == null || typeof parsed !== "object") continue;
        packet = parsed as Record<string, unknown>;
      } catch {
        // Shell startup/launcher banners are not protocol records.
        this.stderr = (this.stderr + line + "\n").slice(-8_000);
        continue;
      }
      if (packet?.type === "response") {
        const pending = this.pending.get(String(packet.id));
        if (!pending) continue;
        this.pending.delete(String(packet.id));
        clearTimeout(pending.timer);
        if (packet.success) pending.resolve(packet.data);
        else pending.reject(new Error(String(packet.error ?? "Pi command failed")));
      } else if (packet?.type === "extension_ui_request") {
        if (["select", "confirm", "input", "editor"].includes(String(packet.method))) {
          // Background reviews cannot approve interactive security/auth prompts.
          this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: packet.id, cancelled: true })}\n`);
        }
      } else if (typeof packet?.type === "string") {
        if (packet.type === "agent_start") this.isStreaming = true;
        if (packet.type === "message_end") this.messages.push(packet.message);
        for (const listener of this.listeners) listener(packet as unknown as AgentSessionEvent);
        if (packet.type === "agent_settled") {
          this.isStreaming = false;
          this.settled?.resolve();
        }
      }
    }
    if (this.output.length > MAX_RECORD_CHARS) {
      this.fail(new Error("Pi RPC record exceeded the size limit"));
      void this.dispose();
    }
  }
}
