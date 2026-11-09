/**
 * Self-hosted fork: the workflow MCP server. An MCP client of the user, such as Claude Code on their
 * Mac, builds and runs the workflows of this OpenBot host with the same tools that its agents use
 * (`src/backend/workflows/workflow-tools.ts`), so a new upstream tool or rule reaches it unchanged. It
 * also creates and changes the agents that the steps use, with the checks of the agents' own
 * create_agent and update_profile (`src/backend/agent/model-tools.ts`), and answers an approval step,
 * with a note to an agent's chat first when the person gives one:
 *
 *   MCP client -> `ssh openbotmcp@<VPS>` (a key that runs only connect.sh) -> connect.sh on the VPS
 *   -> 172.31.250.10:47778 in the host container (the token first) -> this server
 *
 * On the VPS it runs when OPENBOT_WORKFLOW_MCP_TOKEN_SHA256 is set. The container keeps only the hash
 * of the token, so its agents cannot use this server: an agent changes or runs a workflow only on a
 * person's message, and this server must not open a way around that. A delete, of a workflow or of
 * an agent, stays in the app. `selfhost/workflow-mcp/workflow-mcp.sh setup root@<VPS>` makes the key, the token and the VPS side.
 *
 * On a Mac it runs when ~/.config/openbot/workflow-mcp-local/token exists (`workflow-mcp.sh
 * setup-local`), on 127.0.0.1:47778, and the client runs connect.sh with that address and token file.
 * The agents of the Mac run as the user, so the file permissions keep out only other users.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { CreateAgentInput } from "@openbot/contracts/ipc";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import { advertisedJsonSchema } from "../../backend/agent/advertised-json-schema";
import { listModelsPayload, requestedRuntime, requestedToolModel } from "../../backend/agent/model-tools";
import {
  createAgentToolSchema,
  listModelsToolSchema,
  updateProfileToolSchema,
} from "../../backend/agent/profile-tools";
import { toolGuidance } from "../../backend/agent/tool-guidance";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import {
  handleWorkflowTool,
  WORKFLOW_TOOL_DEFINITIONS,
  type WorkflowTools,
} from "../../backend/workflows/workflow-tools";
import type { WorkflowsHandle } from "../../backend/workflows/workflows";

const logger = createOpenBotLogger("workflow-mcp");

const TOKEN_HASH_VARIABLE = "OPENBOT_WORKFLOW_MCP_TOKEN_SHA256";
const LISTEN_VARIABLE = "OPENBOT_WORKFLOW_MCP_LISTEN";
const DEFAULT_LISTEN = "127.0.0.1:47778";
const TOKEN_LINE_LIMIT = 512;
const TOKEN_WAIT_MS = 10_000;

/** What the server reads from the running app. */
export interface WorkflowMcpSources {
  workflows: () => WorkflowTools & Pick<WorkflowsHandle, "decide">;
  agents: AgentService;
}

/** The upstream workflow tools without the delete, which loses the run history: it stays on the page. */
const WORKFLOW_TOOLS = WORKFLOW_TOOL_DEFINITIONS.filter((tool) => tool.name !== "delete_workflow");
const WORKFLOW_TOOL_NAMES = new Set<string>(WORKFLOW_TOOLS.map((tool) => tool.name));

/**
 * The agents' own create_agent fields. With no caller to copy, a new agent starts where one the user
 * creates in the app does, and with no first task it waits for its first workflow step.
 */
const CREATE_AGENT_SCHEMA = z.strictObject({
  ...createAgentToolSchema.shape,
  initialMessage: createAgentToolSchema.shape.initialMessage
    .optional()
    .describe("A first message that the agent answers at once. Omit it for an agent that waits for its steps."),
  provider: createAgentToolSchema.shape.provider.describe(
    "Provider from list_models. Omit provider and model for the app's default, as a new agent in the app gets.",
  ),
});

/** The fields of update_profile that set up a step's agent. Access and Computer Use stay in the app. */
const UPDATE_AGENT_SCHEMA = updateProfileToolSchema.pick({
  agentId: true,
  name: true,
  title: true,
  description: true,
  provider: true,
  model: true,
  reasoningEffort: true,
});

const identifier = z.string().trim().min(1).max(INPUT_LIMITS.identifier);

const SEND_AGENT_MESSAGE_SCHEMA = z.strictObject({
  agentId: identifier.describe("Stable id from list_agents."),
  text: z.string().trim().min(1).max(INPUT_LIMITS.messageText),
});

const DECIDE_STEP_SCHEMA = z.strictObject({
  workflowId: identifier,
  nodeId: identifier.describe("The node of the step whose status is approval in read_workflow_runs."),
  approved: z.boolean().describe("true approves the step. false rejects it, and that stops the whole run."),
  runId: identifier.describe("The run. Omit it for the newest run of the workflow.").optional(),
});

const AGENT_TOOLS = [
  {
    name: "list_agents",
    description:
      "List the agents of this OpenBot server: agentId, name, title, description, provider, model and reasoningEffort. An agent step needs an agentId.",
    schema: z.strictObject({}),
  },
  {
    name: "list_models",
    description:
      "List the models each provider of this server offers: id, name, reasoning efforts and the default model. With no query, each provider lists its default, the models in use and its first models; omittedModels counts the rest. Read-only.",
    schema: listModelsToolSchema,
  },
  {
    name: "create_agent",
    description:
      "Create an agent for workflow steps, such as one on a provider that makes images. Call list_models first for a provider or model. Returns the agent with its agentId. A new agent has the access and Computer Use that the app gives a new agent.",
    schema: CREATE_AGENT_SCHEMA,
  },
  {
    name: "update_agent",
    description:
      "Change an agent's name, title, description, provider, model or reasoning effort. Pass only the values to change; call list_models before a model change. A change while the agent works applies before its next turn.",
    schema: UPDATE_AGENT_SCHEMA,
  },
  {
    name: "send_agent_message",
    description:
      "Send a message from the person to an agent's own chat, as if they typed it there. The agent answers it after the work it already has. A workflow's agent steps run in that chat, so the next step of that agent reads it: give a choice or a note for the next step this way before you approve. Send only what the person asked to send.",
    schema: SEND_AGENT_MESSAGE_SCHEMA,
  },
  {
    name: "decide_workflow_step",
    description:
      "Approve or reject a workflow step that waits for approval, as its button in the app does. Only on the person's own decision in this conversation, never on your own. An approval passes the step's input on unchanged; for a choice or a note, call send_agent_message first. A rejection stops the run.",
    schema: DECIDE_STEP_SCHEMA,
  },
];
const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((tool) => tool.name));

const TOOLS = [
  ...AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...advertisedJsonSchema(tool.schema), type: "object" as const },
  })),
  ...WORKFLOW_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...advertisedJsonSchema(z.strictObject(tool.shape)), type: "object" as const },
  })),
];

const INSTRUCTIONS = [
  "These tools build, change and run the workflows of one OpenBot server, as its Workflows page does, and create the agents that its steps use; the app shows each change. The person who uses this client asks for the changes.",
  "In the guidance below, openbot.<name> is the tool <name> here. list_agents gives the agent ids for agent steps; create_agent makes a missing one. read_workflow_runs shows a step that waits with status approval; decide_workflow_step answers it when the person decides. Deleting a workflow or an agent is done in the app.",
  ...toolGuidance("openbot", "edit_workflow"),
].join("\n");

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/**
 * The workflow handle without the caller: the change event of an agent's build names that agent, and
 * this client is not one.
 */
function unattributed(workflows: WorkflowTools): WorkflowTools {
  return { ...workflows, create: (input) => workflows.create(input), saveGraph: (input) => workflows.saveGraph(input) };
}

/** The message of a failure: a tagged error of the service carries it in its cause. */
function failureText(error: unknown, depth = 0): string {
  if (error instanceof z.ZodError) return z.prettifyError(error);
  if (error instanceof Error && error.message) return error.message;
  if (depth < 4 && typeof error === "object" && error !== null && "cause" in error)
    return failureText(error.cause, depth + 1);
  return String(error);
}

/** The agent as list_agents shows it. */
function agentRow(agent: ReturnType<AgentService["listAgents"]>[number]) {
  const { id, name, title, description, provider, model, reasoningEffort } = agent;
  return { agentId: id, name, title, description, provider, model, reasoningEffort };
}

/** Answers the approval step of `nodeId` in the run, or the newest run of the workflow. */
async function decideStep(args: unknown, workflows: ReturnType<WorkflowMcpSources["workflows"]>) {
  const { workflowId, nodeId, approved, runId } = DECIDE_STEP_SCHEMA.parse(args);
  const detail =
    runId === undefined
      ? (await runCauseEffect(workflows.runs({ workflowId, limit: 1 }))).runs[0]
      : await runCauseEffect(workflows.run(runId));
  if (!detail || detail.run.workflowId !== workflowId)
    return text(runId === undefined ? "This workflow has no run yet." : `No run ${runId} in this workflow.`, true);
  const waiting = detail.steps.filter((step) => step.status === "approval");
  const step = waiting.find((candidate) => candidate.nodeId === nodeId);
  if (!step) {
    const nodes = waiting.map((candidate) => candidate.nodeId).join(", ") || "none";
    return text(`No step of node ${nodeId} waits for approval in run ${detail.run.number}. Waiting: ${nodes}.`, true);
  }
  await runCauseEffect(workflows.decide({ stepId: step.id, approved }));
  const after = await runCauseEffect(workflows.run(detail.run.id));
  return text(JSON.stringify({ runId: detail.run.id, nodeId, approved, runStatus: after.run.status }));
}

async function agentTool(name: string, args: unknown, service: AgentService): Promise<CallToolResult> {
  if (name === "send_agent_message") {
    const { agentId, text: message } = SEND_AGENT_MESSAGE_SCHEMA.parse(args);
    if (!service.listAgents().some((agent) => agent.id === agentId))
      return text(`No agent ${agentId}: list_agents gives the ids.`, true);
    await runCauseEffect(service.sendMessage({ agentId, text: message }));
    return text(JSON.stringify({ sent: true, agentId }));
  }
  if (name === "list_agents") return text(JSON.stringify(service.listAgents().map(agentRow)));
  if (name === "list_models") {
    const request = listModelsToolSchema.parse(args);
    const payload = listModelsPayload(
      service.listModels(),
      service.preferredProvider(),
      (provider) => service.getStatus().providers?.find((row) => row.id === provider)?.accounts,
      {
        ...request,
        inUse: service.listAgents().map((agent) => ({ provider: agent.provider, model: agent.model })),
      },
    );
    return text(redactText(JSON.stringify(payload)));
  }
  if (name === "create_agent") {
    const request = CREATE_AGENT_SCHEMA.parse(args);
    // An unknown model, or an effort that the model does not have, is refused before the agent exists.
    const model = requestedToolModel(request, service.listModels());
    if (!model && request.reasoningEffort)
      return text("Name a provider or a model from list_models with reasoningEffort.", true);
    const input: Omit<CreateAgentInput, "initialMessage"> = {
      name: request.name,
      description: request.description,
      avatarSeed: request.avatarSeed ?? randomUUID(),
      avatarHue: request.avatarHue ?? null,
      ...(model
        ? {
            provider: model.provider,
            model: model.id,
            ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          }
        : {}),
    };
    const { title, initialMessage } = request;
    const agent = initialMessage
      ? await runCauseEffect(
          service.createAgent(
            { ...input, initialMessage },
            title === undefined ? undefined : (created) => service.updateAgent({ agentId: created.id, title }),
          ),
        )
      : await runCauseEffect(service.createAgentProfile({ ...input, ...(title === undefined ? {} : { title }) }));
    return text(JSON.stringify(agentRow(agent)));
  }
  const { agentId, provider, model, reasoningEffort, ...profile } = UPDATE_AGENT_SCHEMA.parse(args);
  const target = service.listAgents().find((agent) => agent.id === agentId);
  if (!target) return text(`No agent ${agentId}: list_agents gives the ids.`, true);
  // JSON arguments leave a value out rather than pass undefined, so each key here is a change.
  const change = {
    ...profile,
    ...requestedRuntime(target, { provider, model, reasoningEffort }, service.listModels()),
  };
  if (Object.keys(change).length === 0) return text("Pass at least one value to change.", true);
  return text(JSON.stringify(agentRow(await runCauseEffect(service.updateAgent({ ...change, agentId })))));
}

async function callTool(name: string, args: unknown, sources: WorkflowMcpSources): Promise<CallToolResult> {
  if (!AGENT_TOOL_NAMES.has(name) && !WORKFLOW_TOOL_NAMES.has(name)) return text(`Unknown tool ${name}.`, true);
  try {
    if (name === "decide_workflow_step") return await decideStep(args, sources.workflows());
    if (AGENT_TOOL_NAMES.has(name)) return await agentTool(name, args, sources.agents);
    const response = await runCauseEffect(
      handleWorkflowTool(
        name,
        args,
        unattributed(sources.workflows()),
        "",
        // A run takes this as its request id.
        `workflow-mcp-${randomUUID()}`,
        new Set(sources.agents.listAgents().map((agent) => agent.id)),
        () => Effect.succeed(false),
      ),
    );
    if (!response) return text(`Unknown tool ${name}.`, true);
    return {
      content: response.contentItems.map((item) => ({ type: "text" as const, text: item.text })),
      ...(response.success ? {} : { isError: true }),
    };
  } catch (error) {
    // Bad arguments are for the model to correct, as for an agent; the rest is logged too.
    const message = redactText(failureText(error));
    if (!(error instanceof z.ZodError)) logger.warn("A workflow MCP call failed.", { tool: name, message });
    return text(message, true);
  }
}

/** One client: the token line, then MCP messages on the same socket, one JSON-RPC message a line. */
function serve(socket: Socket, tokenHash: Buffer, sources: WorkflowMcpSources): void {
  socket.on("error", () => socket.destroy());
  socket.setTimeout(TOKEN_WAIT_MS, () => socket.destroy());
  let received = Buffer.alloc(0);
  const readToken = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    const newline = received.indexOf(10);
    if (newline === -1) {
      if (received.length > TOKEN_LINE_LIMIT) socket.destroy();
      return;
    }
    socket.off("data", readToken);
    socket.pause();
    socket.setTimeout(0);
    const token = received.subarray(0, newline).toString("utf8").trim();
    if (!timingSafeEqual(Buffer.from(sha256(token), "hex"), tokenHash)) {
      logger.warn("Refused a workflow MCP connection without the token.");
      socket.destroy();
      return;
    }
    const rest = received.subarray(newline + 1);
    if (rest.length > 0) socket.unshift(rest);
    const server = new Server(
      { name: "openbot-workflows", version: "1.0.0" },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
      callTool(params.name, params.arguments ?? {}, sources),
    );
    server.onclose = () => socket.destroy();
    socket.on("close", () => void server.close());
    server
      .connect(new StdioServerTransport(socket, socket))
      .then(() => {
        socket.resume();
        logger.info("A workflow MCP client connected.");
      })
      .catch((error: unknown) => {
        logger.warn("A workflow MCP client could not start.", { message: String(error) });
        socket.destroy();
      });
  };
  socket.on("data", readToken);
}

function listenAddress(value: string): { host: string; port: number } | null {
  const match = /^(.+):(\d{1,5})$/u.exec(value.trim());
  const port = Number(match?.[2]);
  return match?.[1] && port > 0 && port < 65_536 ? { host: match[1], port } : null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The hash of the token: the variable on the VPS, else the hash of the local token file on a Mac. Only a
 * Mac reads the file: on the VPS an agent can write in the home folder of the container.
 */
function expectedTokenHash(): string | null {
  const variable = process.env[TOKEN_HASH_VARIABLE]?.trim().toLowerCase();
  if (variable) return variable;
  if (process.platform !== "darwin") return null;
  const file = join(homedir(), ".config", "openbot", "workflow-mcp-local", "token");
  if (!existsSync(file)) return null;
  const token = readFileSync(file, "utf8").trim();
  return token ? sha256(token) : null;
}

/** Starts the server when this host has a token. `application-services.ts` calls it once. */
export function startWorkflowMcp(sources: WorkflowMcpSources): void {
  const hash = expectedTokenHash();
  if (!hash) return;
  const address = listenAddress(process.env[LISTEN_VARIABLE] || DEFAULT_LISTEN);
  if (!/^[0-9a-f]{64}$/u.test(hash) || !address) {
    logger.warn(`The workflow MCP server is off: ${TOKEN_HASH_VARIABLE} or ${LISTEN_VARIABLE} is not valid.`);
    return;
  }
  const tokenHash = Buffer.from(hash, "hex");
  const listener = createServer((socket) => serve(socket, tokenHash, sources));
  listener.on("error", (error) =>
    logger.error("The workflow MCP server could not listen.", { message: error.message }),
  );
  listener.listen(address.port, address.host, () =>
    logger.info(`The workflow MCP server listens on ${address.host}:${address.port}.`),
  );
  // A listening socket must not keep a quitting app alive.
  listener.unref();
}
