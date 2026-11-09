// Self-hosted fork: checks the workflow MCP server (src/main/self-host/workflow-mcp.ts) on the real
// SQLite, the real agent service and the real workflow service, on a temporary profile, after a merge
// from upstream. A fake Codex app-server lists two models and answers each turn. An MCP client starts
// selfhost/workflow-mcp/connect.sh with the system bash (3.2 on macOS), as an MCP client starts
// `ssh openbotmcp@<VPS>` or the local connect.sh on a Mac. Workflow agent steps stay running in a
// stand-in mailbox.
//
// It checks that a wrong token gets no answer, that the tools are the upstream workflow tools without
// the delete plus the agent tools, that an agent is created with and without a first message and then
// changed, that a workflow is built on it, read, changed and run, that an approval step takes a note
// in the agent's chat and then the decision, that the model gets the failures it must correct, and
// that the change events name no agent. On macOS it also starts the server from the
// local token file (workflow-mcp.sh setup-local), with no variable.
//
// Run: bun selfhost/scripts/workflow-mcp-e2e.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../../src/backend/agent/turn-lifecycle";
import type { WorkflowsHandle } from "../../src/backend/workflows/workflows";

const EFFORTS = '[{"reasoningEffort":"low"},{"reasoningEffort":"medium"},{"reasoningEffort":"high"}]';

/** A Codex app-server with the methods that the service calls: two models, and "Done." for each turn. */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const models = [
  { model: "gpt-6-luna", displayName: "GPT-6 Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: ${EFFORTS} },
  { model: "gpt-6-image", displayName: "GPT-6 Image", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
];
let buffer = "";
let threads = 0;
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: models } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
      return setTimeout(() => {
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 20);
    }
    case "turn/interrupt": return write({ id: message.id, result: {} });
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

// The service and Bun read the home folder when they start, so the test runs again with a home, a
// Codex and a profile of its own. On a Mac, step 9 puts the local token file in that home.
if (process.env.WORKFLOW_MCP_E2E_ROOT === undefined) {
  const root = await mkdtemp(join(tmpdir(), "openbot-workflow-mcp-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(root, "codex"), FAKE_CODEX, { mode: 0o755 });
  const child = spawnSync(process.execPath, [import.meta.filename], {
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      OPENBOT_CODEX_PATH: join(root, "codex"),
      WORKFLOW_MCP_E2E_ROOT: root,
    },
  });
  await rm(root, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}

const { AgentService } = await import("../../src/backend/agent-service");
const { AgentStore } = await import("../../src/backend/agent-store");
const { runCauseEffect } = await import("../../src/backend/effect-boundary");
const { MailboxStore } = await import("../../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../../src/backend/openbot-database");
const { WorkflowGitHubStore } = await import("../../src/backend/workflows/workflow-github-store");
const { WorkflowRunStore } = await import("../../src/backend/workflows/workflow-run-store");
const { WorkflowStore } = await import("../../src/backend/workflows/workflow-store");
const { workflowScheduleDueAt } = await import("../../src/backend/workflows/workflow-triggers");
const { createWorkflows } = await import("../../src/backend/workflows/workflows");
const { startWorkflowMcp } = await import("../../src/main/self-host/workflow-mcp");

const root = process.env.WORKFLOW_MCP_E2E_ROOT;
const home = process.env.HOME;
assert.ok(root && home);

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** Sends a line and waits for the server to answer or to close; a refused token closes with nothing. */
function answerTo(port: number, line: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(line));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
  });
}

/** Waits for a state of the service. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const CONNECT = resolve(import.meta.dirname, "../workflow-mcp/connect.sh");

/** An MCP client that starts connect.sh for the server on `port`, with the system bash. */
async function connectClient(port: number, tokenFile: string): Promise<Client> {
  const mcp = new Client({ name: "workflow-mcp-e2e", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: "/bin/bash",
      args: [CONNECT, `127.0.0.1:${port}`, tokenFile],
      env: getDefaultEnvironment(),
    }),
  );
  return mcp;
}

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

const userData = join(root, "user-data");
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let workflows: WorkflowsHandle | null = null;
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  workflowTools: () => {
    assert.ok(workflows, "The workflow service is not ready.");
    return workflows;
  },
});
let agentChanges = 0;
agents.on("event", (event) => {
  if (event.type === "agents-changed") agentChanges += 1;
});
let client: Client | null = null;
let localClient: Client | null = null;
const changed: string[] = [];

try {
  await runCauseEffect(agents.initialize());
  workflows = await Effect.runPromise(
    createWorkflows({
      store: new WorkflowStore({ database, nextDueAt: workflowScheduleDueAt(() => "UTC") }),
      runs: new WorkflowRunStore({ database }),
      github: new WorkflowGitHubStore({ database }),
      githubApp: () => null,
      delivery: () => ({ status: "running", turnId: null, error: null }),
      turnAnswer: () => null,
      sendHandoff: () => Effect.succeed(`delivery-${crypto.randomUUID()}`),
      stopDelivery: () => Effect.void,
      generateText: () => Effect.fail({ message: "No model step runs in this test." }),
      notify: () => {},
      connectionOn: () => false,
      post: () => Effect.die(new Error("No output step runs in this test.")),
      changed: (workflowId, agentId) =>
        changed.push(agentId === undefined ? workflowId : `${workflowId} by ${agentId}`),
      rearm: () => {},
      timezone: () => "UTC",
    }),
  );
  const handle = workflows;
  await waitFor("the Codex models", () => agents.listModels().some((model) => model.id === "gpt-6-image"));

  const token = randomBytes(32).toString("hex");
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const port = await freePort();
  process.env.OPENBOT_WORKFLOW_MCP_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
  process.env.OPENBOT_WORKFLOW_MCP_LISTEN = `127.0.0.1:${port}`;
  startWorkflowMcp({ workflows: () => handle, agents });
  await new Promise((resolve) => setTimeout(resolve, 200));

  // 1. Without the token, the server answers nothing and closes.
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
  });
  assert.equal(await answerTo(port, `wrong-token\n${initialize}\n`), "", "a wrong token got an answer");
  console.log("✓ a wrong token gets no answer");

  // 2. With the token, through connect.sh, as on the VPS.
  client = await connectClient(port, tokenFile);
  assert.match(client.getInstructions() ?? "", /Fields by kind/u);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "create_agent",
    "decide_workflow_step",
    "edit_workflow",
    "list_agents",
    "list_models",
    "list_workflows",
    "read_workflow",
    "read_workflow_runs",
    "run_workflow",
    "send_agent_message",
    "update_agent",
  ]);
  console.log("✓ tools:", names.join(", "));

  const call = async (name: string, args: Parameters<Client["callTool"]>[0]["arguments"]) => {
    const result = await client?.callTool({ name, arguments: args });
    assert.ok(result && Array.isArray(result.content));
    const first = result.content[0];
    assert.ok(first && first.type === "text");
    return { ok: result.isError !== true, text: first.text };
  };

  // 3. The models, and the agents that the steps use.
  const models = await call("list_models", { provider: "codex" });
  assert.ok(models.ok && models.text.includes("gpt-6-image") && models.text.includes("gpt-6-luna"), models.text);
  const changesBefore = agentChanges;
  const research = await call("create_agent", {
    name: "Research",
    title: "Researcher",
    description: "Reads the web.",
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "high",
  });
  assert.ok(research.ok, research.text);
  const researchRow = JSON.parse(research.text);
  assert.deepEqual(
    [researchRow.title, researchRow.provider, researchRow.model, researchRow.reasoningEffort],
    ["Researcher", "codex", "gpt-6-luna", "high"],
  );
  assert.equal(agents.listQueue(researchRow.agentId).deliveries.length, 0, "an agent with no first message ran");
  const images = await call("create_agent", {
    name: "Images",
    title: "Image maker",
    description: "Makes pictures.",
    model: "gpt-6-image",
    initialMessage: "Say that you are ready.",
  });
  assert.ok(images.ok, images.text);
  const imagesRow = JSON.parse(images.text);
  assert.deepEqual([imagesRow.title, imagesRow.model], ["Image maker", "gpt-6-image"]);
  await waitFor("the first message to be answered", () => {
    const deliveries = agents.listQueue(imagesRow.agentId).deliveries;
    return deliveries.length > 0 && deliveries.every((delivery) => delivery.status === "completed");
  });
  assert.ok(agentChanges > changesBefore, "the app did not hear of the new agents");
  console.log("✓ created", researchRow.agentId, "and", imagesRow.agentId, "which answered its first message");

  const updated = await call("update_agent", {
    agentId: imagesRow.agentId,
    description: "Makes pictures and posters.",
    model: "gpt-6-luna",
  });
  assert.ok(updated.ok, updated.text);
  const updatedRow = JSON.parse(updated.text);
  assert.deepEqual(
    [updatedRow.description, updatedRow.model, updatedRow.title],
    ["Makes pictures and posters.", "gpt-6-luna", "Image maker"],
  );
  const listed = JSON.parse((await call("list_agents", {})).text);
  assert.ok(
    listed.some(
      (row: { agentId: string; model: string }) => row.agentId === imagesRow.agentId && row.model === "gpt-6-luna",
    ),
    JSON.stringify(listed),
  );

  const unknownModel = await call("create_agent", { name: "X", description: "", model: "gpt-nobody" });
  assert.ok(!unknownModel.ok && unknownModel.text.includes("gpt-nobody"), unknownModel.text);
  const badEffort = await call("create_agent", {
    name: "X",
    description: "",
    model: "gpt-6-image",
    reasoningEffort: "high",
  });
  assert.ok(!badEffort.ok && badEffort.text.includes("high"), badEffort.text);
  const effortAlone = await call("create_agent", { name: "X", description: "", reasoningEffort: "high" });
  assert.ok(!effortAlone.ok, effortAlone.text);
  const noAgent = await call("update_agent", { agentId: "agent-nobody", name: "Y" });
  assert.ok(!noAgent.ok && noAgent.text.includes("agent-nobody"), noAgent.text);
  const noChange = await call("update_agent", { agentId: imagesRow.agentId });
  assert.ok(!noChange.ok, noChange.text);
  const widen = await call("update_agent", { agentId: imagesRow.agentId, access: "full" });
  assert.ok(!widen.ok, widen.text);
  assert.equal(agents.listAgents().length, 2, "a refused create made an agent");
  console.log("✓ agent refusals:", [unknownModel.text, badEffort.text].join(" | "));

  // 4. Build a workflow in one call: a weekday trigger, an agent step, a condition and an output.
  const built = await call("edit_workflow", {
    title: "MCP e2e",
    ops: [
      { op: "add", ref: "t", kind: "trigger", schedule: { kind: "weekdays", time: "09:00" } },
      {
        op: "add",
        ref: "a",
        kind: "agent",
        from: "t",
        fields: { agentId: researchRow.agentId, task: "Summarize the news." },
      },
      { op: "add", ref: "c", kind: "condition", from: "a", fields: { rule: "Is there something urgent?" } },
      { op: "add", ref: "yes", kind: "output", from: "c", branch: "yes", fields: { target: "notify" } },
    ],
  });
  assert.ok(built.ok, built.text);
  const { workflowId, ids } = JSON.parse(built.text);
  assert.ok(typeof workflowId === "string" && ids.t && ids.a && ids.c && ids.yes);
  console.log("✓ built", workflowId);

  const read = JSON.parse((await call("read_workflow", { workflowId })).text);
  assert.equal(read.nodes.length, 4);
  assert.equal(read.edges.length, 3);
  assert.equal(read.triggers[0].type, "schedule");
  assert.ok(read.triggers[0].nextDueAt);
  console.log("✓ read back: 4 nodes, 3 edges, next run", read.triggers[0].nextDueAt);

  // 5. The failures that the model reads and corrects.
  const unknownAgent = await call("edit_workflow", {
    workflowId,
    ops: [{ op: "update", node: ids.a, fields: { agentId: "agent-nobody" } }],
  });
  assert.ok(!unknownAgent.ok && unknownAgent.text.includes("unknown agent"), unknownAgent.text);
  const badArguments = await call("edit_workflow", { workflowId, ops: [{ op: "explode" }] });
  assert.ok(!badArguments.ok, badArguments.text);
  const noBranch = await call("edit_workflow", {
    workflowId,
    ops: [{ op: "add", kind: "output", from: ids.c, fields: { target: "notify" } }],
  });
  assert.ok(!noBranch.ok && noBranch.text.includes("branch"), noBranch.text);
  const deleted = await call("delete_workflow", { workflowId });
  assert.ok(!deleted.ok, "delete_workflow answered");
  console.log("✓ workflow refusals:", [unknownAgent.text, noBranch.text].join(" | "));

  // 6. A change to the new image agent, the list, a run and its read.
  const renamed = await call("edit_workflow", {
    workflowId,
    title: "MCP e2e renamed",
    ops: [
      {
        op: "add",
        kind: "agent",
        from: ids.c,
        branch: "no",
        fields: { agentId: imagesRow.agentId, task: "Draw the summary." },
      },
    ],
  });
  assert.ok(renamed.ok, renamed.text);
  const list = JSON.parse((await call("list_workflows", {})).text);
  assert.ok(list.some((item: { title: string; steps: number }) => item.title === "MCP e2e renamed"));
  const run = await call("run_workflow", { workflowId });
  assert.ok(run.ok, run.text);
  const runs = JSON.parse((await call("read_workflow_runs", { workflowId })).text);
  assert.ok(
    runs.runs[0].steps.some((step: { kind?: string }) => step.kind === "agent"),
    JSON.stringify(runs),
  );
  console.log("✓ renamed, listed, run", JSON.parse(run.text).runId, "with steps", runs.runs[0].steps.length);

  // 7. An approval step: the person's note goes to the agent's chat, then the person's decision.
  const gated = await call("edit_workflow", {
    title: "MCP approval",
    ops: [
      { op: "add", ref: "t", kind: "trigger" },
      { op: "add", ref: "ok", kind: "approval", from: "t", fields: { question: "Use option 2?" } },
      { op: "add", ref: "a", kind: "agent", from: "ok", fields: { agentId: imagesRow.agentId, task: "Draw it." } },
    ],
  });
  assert.ok(gated.ok, gated.text);
  const gate = JSON.parse(gated.text);
  /** The status of the node's step in the newest run. */
  const stepStatus = async (nodeId: string) => {
    const newest = JSON.parse((await call("read_workflow_runs", { workflowId: gate.workflowId })).text).runs[0];
    return newest.steps.find((step: { nodeId: string }) => step.nodeId === nodeId)?.status;
  };
  assert.ok((await call("run_workflow", { workflowId: gate.workflowId })).ok);
  assert.equal(await stepStatus(gate.ids.ok), "approval");
  const wrongNode = await call("decide_workflow_step", {
    workflowId: gate.workflowId,
    nodeId: gate.ids.a,
    approved: true,
  });
  assert.ok(!wrongNode.ok && wrongNode.text.includes(gate.ids.ok), wrongNode.text);
  const noRecipient = await call("send_agent_message", { agentId: "agent-nobody", text: "Option 2." });
  assert.ok(!noRecipient.ok && noRecipient.text.includes("agent-nobody"), noRecipient.text);
  const answered = agents.listQueue(imagesRow.agentId).deliveries.length;
  const note = await call("send_agent_message", { agentId: imagesRow.agentId, text: "Option 2, please." });
  assert.ok(note.ok, note.text);
  await waitFor("the note to be answered", () => {
    const deliveries = agents.listQueue(imagesRow.agentId).deliveries;
    return deliveries.length > answered && deliveries.every((delivery) => delivery.status === "completed");
  });
  const approved = await call("decide_workflow_step", {
    workflowId: gate.workflowId,
    nodeId: gate.ids.ok,
    approved: true,
  });
  assert.ok(approved.ok, approved.text);
  assert.deepEqual([await stepStatus(gate.ids.ok), await stepStatus(gate.ids.a)], ["done", "running"]);
  const again = await call("decide_workflow_step", {
    workflowId: gate.workflowId,
    nodeId: gate.ids.ok,
    approved: true,
  });
  assert.ok(!again.ok, again.text);
  assert.ok((await call("run_workflow", { workflowId: gate.workflowId })).ok);
  const rejected = await call("decide_workflow_step", {
    workflowId: gate.workflowId,
    nodeId: gate.ids.ok,
    approved: false,
  });
  assert.ok(rejected.ok, rejected.text);
  assert.notEqual(await stepStatus(gate.ids.a), "running", "a rejected run went on");
  console.log(
    "✓ approval: note sent, approved",
    JSON.parse(approved.text).runStatus,
    "| rejected",
    JSON.parse(rejected.text).runStatus,
  );

  // 8. The canvas hears each change, with no agent named.
  assert.ok(changed.length > 0 && changed.every((event) => !event.includes(" by ")), changed.join(", "));
  console.log("✓ change events:", changed.length, "with no agent");

  // 9. On a Mac: the server of the desktop app, from the local token file and with no variable.
  if (process.platform === "darwin") {
    const localDirectory = join(home, ".config", "openbot", "workflow-mcp-local");
    await mkdir(localDirectory, { recursive: true });
    const localToken = join(localDirectory, "token");
    await writeFile(localToken, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    const localPort = await freePort();
    delete process.env.OPENBOT_WORKFLOW_MCP_TOKEN_SHA256;
    process.env.OPENBOT_WORKFLOW_MCP_LISTEN = `127.0.0.1:${localPort}`;
    startWorkflowMcp({ workflows: () => handle, agents });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await answerTo(localPort, `${token}\n${initialize}\n`), "", "the VPS token opened the Mac server");
    localClient = await connectClient(localPort, localToken);
    const result = await localClient.callTool({ name: "list_workflows", arguments: {} });
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    assert.ok(first && first.type === "text" && first.text.includes("MCP e2e renamed"), JSON.stringify(result));
    console.log("✓ Mac: the server starts from ~/.config/openbot/workflow-mcp-local/token");
  }
  console.log("✓ workflow MCP e2e passed");
} finally {
  await client?.close().catch(() => {});
  await localClient?.close().catch(() => {});
  if (workflows) await Effect.runPromise(workflows.close()).catch(() => {});
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
}
process.exit(0);
