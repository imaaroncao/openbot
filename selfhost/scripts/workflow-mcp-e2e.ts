// Self-hosted fork: checks the workflow MCP server (src/main/self-host/workflow-mcp.ts) on the real
// SQLite and the real workflow service, on a temporary profile, after a merge from upstream. An MCP
// client starts selfhost/workflow-mcp/connect.sh with the system bash (3.2 on macOS), as an MCP client
// starts `ssh openbotmcp@<VPS>` or the local connect.sh on a Mac. Agent steps stay running in a
// stand-in mailbox, so no provider starts.
//
// It checks that a wrong token gets no answer, that the tools are the upstream workflow tools without
// the delete plus list_agents, that a workflow is built, read, changed and run, that the model gets
// the failures it must correct, and that the change events name no agent. On macOS it also starts the
// server from the local token file (workflow-mcp.sh setup-local), with no variable.
//
// Run: bun selfhost/scripts/workflow-mcp-e2e.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { OpenBotDatabase } from "../../src/backend/openbot-database";
import { WorkflowGitHubStore } from "../../src/backend/workflows/workflow-github-store";
import { WorkflowRunStore } from "../../src/backend/workflows/workflow-run-store";
import { WorkflowStore } from "../../src/backend/workflows/workflow-store";
import { workflowScheduleDueAt } from "../../src/backend/workflows/workflow-triggers";
import { createWorkflows, type WorkflowsHandle } from "../../src/backend/workflows/workflows";
import { startWorkflowMcp } from "../../src/main/self-host/workflow-mcp";

const AGENT = { id: "agent-research", name: "Research", title: "Researcher", description: "Reads the web." };

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

// Bun reads HOME only when it starts, so on a Mac the test runs again with a home of its own, where
// step 7 puts the local token file.
if (process.platform === "darwin" && process.env.WORKFLOW_MCP_E2E_HOME === undefined) {
  const home = await mkdtemp(join(tmpdir(), "openbot-workflow-mcp-home-"));
  const child = spawnSync(process.execPath, [import.meta.filename], {
    stdio: "inherit",
    env: { ...process.env, HOME: home, WORKFLOW_MCP_E2E_HOME: home },
  });
  await rm(home, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}

const directory = await mkdtemp(join(tmpdir(), "openbot-workflow-mcp-"));
const database = new OpenBotDatabase(directory);
let workflows: WorkflowsHandle | null = null;
let client: Client | null = null;
let localClient: Client | null = null;
const changed: string[] = [];

try {
  await Effect.runPromise(database.initialize());
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

  const token = randomBytes(32).toString("hex");
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const port = await freePort();
  process.env.OPENBOT_WORKFLOW_MCP_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
  process.env.OPENBOT_WORKFLOW_MCP_LISTEN = `127.0.0.1:${port}`;
  startWorkflowMcp({ workflows: () => handle, agents: () => [AGENT] });
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
    "edit_workflow",
    "list_agents",
    "list_workflows",
    "read_workflow",
    "read_workflow_runs",
    "run_workflow",
  ]);
  console.log("✓ tools:", names.join(", "));

  const call = async (name: string, args: Parameters<Client["callTool"]>[0]["arguments"]) => {
    const result = await client?.callTool({ name, arguments: args });
    assert.ok(result && Array.isArray(result.content));
    const first = result.content[0];
    assert.ok(first && first.type === "text");
    return { ok: result.isError !== true, text: first.text };
  };

  const agents = await call("list_agents", {});
  assert.ok(agents.ok && JSON.parse(agents.text)[0].agentId === AGENT.id);

  // 3. Build a workflow in one call: a weekday trigger, an agent step, a condition and two outputs.
  const built = await call("edit_workflow", {
    title: "MCP e2e",
    ops: [
      { op: "add", ref: "t", kind: "trigger", schedule: { kind: "weekdays", time: "09:00" } },
      { op: "add", ref: "a", kind: "agent", from: "t", fields: { agentId: AGENT.id, task: "Summarize the news." } },
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

  // 4. The failures that the model reads and corrects.
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
  console.log("✓ refusals:", [unknownAgent.text, noBranch.text].join(" | "));

  // 5. A change, the list, a run and its read.
  const renamed = await call("edit_workflow", {
    workflowId,
    title: "MCP e2e renamed",
    ops: [{ op: "add", kind: "output", from: ids.c, branch: "no", fields: { target: "notify" } }],
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

  // 6. The canvas hears each change, with no agent named.
  assert.ok(changed.length > 0 && changed.every((event) => !event.includes(" by ")), changed.join(", "));
  console.log("✓ change events:", changed.length, "with no agent");

  // 7. On a Mac: the server of the desktop app, from the local token file and with no variable.
  if (process.platform === "darwin") {
    const localDirectory = join(homedir(), ".config", "openbot", "workflow-mcp-local");
    await mkdir(localDirectory, { recursive: true });
    const localToken = join(localDirectory, "token");
    await writeFile(localToken, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    const localPort = await freePort();
    delete process.env.OPENBOT_WORKFLOW_MCP_TOKEN_SHA256;
    process.env.OPENBOT_WORKFLOW_MCP_LISTEN = `127.0.0.1:${localPort}`;
    startWorkflowMcp({ workflows: () => handle, agents: () => [AGENT] });
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
  database.close();
  await rm(directory, { recursive: true, force: true });
}
process.exit(0);
