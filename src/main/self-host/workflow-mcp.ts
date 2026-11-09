/**
 * Self-hosted fork: the workflow MCP server. An MCP client of the user, such as Claude Code on their
 * Mac, builds and runs the workflows of this OpenBot host with the same tools that its agents use
 * (`src/backend/workflows/workflow-tools.ts`), so a new upstream tool or rule reaches it unchanged:
 *
 *   MCP client -> `ssh openbotmcp@<VPS>` (a key that runs only connect.sh) -> connect.sh on the VPS
 *   -> 172.31.250.10:47778 in the host container (the token first) -> this server
 *
 * It runs only when OPENBOT_WORKFLOW_MCP_TOKEN_SHA256 is set. The container keeps only the hash of the
 * token, so its agents cannot use this server: an agent changes or runs a workflow only on a person's
 * message, and this server must not open a way around that. A delete stays on the Workflows page.
 * `selfhost/workflow-mcp/workflow-mcp.sh setup root@<VPS>` makes the key, the token and the VPS side.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import { advertisedJsonSchema } from "../../backend/agent/advertised-json-schema";
import { toolGuidance } from "../../backend/agent/tool-guidance";
import { runCauseEffect } from "../../backend/effect-boundary";
import {
  handleWorkflowTool,
  WORKFLOW_TOOL_DEFINITIONS,
  type WorkflowTools,
} from "../../backend/workflows/workflow-tools";

const logger = createOpenBotLogger("workflow-mcp");

const TOKEN_HASH_VARIABLE = "OPENBOT_WORKFLOW_MCP_TOKEN_SHA256";
const LISTEN_VARIABLE = "OPENBOT_WORKFLOW_MCP_LISTEN";
const DEFAULT_LISTEN = "127.0.0.1:47778";
const TOKEN_LINE_LIMIT = 512;
const TOKEN_WAIT_MS = 10_000;

/** What the server reads from the running app. */
export interface WorkflowMcpSources {
  workflows: () => WorkflowTools;
  agents: () => readonly Pick<AgentSummary, "id" | "name" | "title" | "description">[];
}

/** The upstream workflow tools without the delete, which loses the run history: it stays on the page. */
const WORKFLOW_TOOLS = WORKFLOW_TOOL_DEFINITIONS.filter((tool) => tool.name !== "delete_workflow");
const WORKFLOW_TOOL_NAMES = new Set<string>(WORKFLOW_TOOLS.map((tool) => tool.name));

const LIST_AGENTS = {
  name: "list_agents",
  description:
    "List the agents of this OpenBot server: agentId, name, title and description. An agent step needs an agentId.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

const TOOLS = [
  LIST_AGENTS,
  ...WORKFLOW_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...advertisedJsonSchema(z.strictObject(tool.shape)), type: "object" as const },
  })),
];

const INSTRUCTIONS = [
  "These tools build, change and run the workflows of one OpenBot server, as its Workflows page does; an open canvas shows each change. The person who uses this client asks for the changes.",
  "In the guidance below, openbot.<name> is the tool <name> here. list_agents gives the agent ids for agent steps. Deleting a workflow is done on the Workflows page.",
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

async function callTool(name: string, args: unknown, sources: WorkflowMcpSources): Promise<CallToolResult> {
  if (name === LIST_AGENTS.name) {
    const agents = sources
      .agents()
      .map(({ id, name, title, description }) => ({ agentId: id, name, title, description }));
    return text(JSON.stringify(agents));
  }
  if (!WORKFLOW_TOOL_NAMES.has(name)) return text(`Unknown tool ${name}.`, true);
  try {
    const response = await runCauseEffect(
      handleWorkflowTool(
        name,
        args,
        unattributed(sources.workflows()),
        "",
        // A run takes this as its request id.
        `workflow-mcp-${randomUUID()}`,
        new Set(sources.agents().map((agent) => agent.id)),
        () => Effect.succeed(false),
      ),
    );
    if (!response) return text(`Unknown tool ${name}.`, true);
    return {
      content: response.contentItems.map((item) => ({ type: "text" as const, text: item.text })),
      ...(response.success ? {} : { isError: true }),
    };
  } catch (error) {
    // Bad arguments are for the model to correct, as for an agent; the rest is a host fault.
    const message =
      error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
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
    if (!timingSafeEqual(createHash("sha256").update(token).digest(), tokenHash)) {
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

/** Starts the server when this host has a token hash. `application-services.ts` calls it once. */
export function startWorkflowMcp(sources: WorkflowMcpSources): void {
  const hash = process.env[TOKEN_HASH_VARIABLE]?.trim().toLowerCase();
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
