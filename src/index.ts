#!/usr/bin/env node
/**
 * filoo MCP server
 *
 * Exposes the filoo.app REST API as Model Context Protocol tools so that
 * LLM-driven agents (Claude Desktop, Cursor, generic MCP clients) can create
 * short links, manage them, and read click stats.
 *
 * Auth: set FILOO_API_KEY in the environment. Get a key at
 * https://filoo.app/dashboard/api (requires pro, agents, or lifetime tier).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const API_BASE = process.env.FILOO_API_BASE || "https://filoo.app/api/v1";
const PKG_NAME = "@filooapp/mcp-server";
const PKG_VERSION = "0.1.0";

// ---------- argv handling (so `--help` / `--version` work as a CLI) ----------

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${PKG_NAME} ${PKG_VERSION}\n`);
  process.exit(0);
}
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    `${PKG_NAME} v${PKG_VERSION}\n` +
      `\n` +
      `MCP server for filoo.app — URL shortener and click tracking for AI agents.\n` +
      `\n` +
      `Usage:\n` +
      `  mcp-server-filoo            Run as a stdio MCP server\n` +
      `  mcp-server-filoo --help     Show this help\n` +
      `  mcp-server-filoo --version  Print version\n` +
      `\n` +
      `Environment:\n` +
      `  FILOO_API_KEY   Required. Bearer token from https://filoo.app/dashboard/api\n` +
      `  FILOO_API_BASE  Optional. Defaults to ${API_BASE}\n` +
      `\n` +
      `Docs: https://filoo.app/api\n`,
  );
  process.exit(0);
}

// ---------- HTTP client ----------

function encodeCode(code: string): string {
  // The filoo API uses `{username}:{slug}` as the link code. The colon must be
  // percent-encoded in the URL path, but the slug itself may contain characters
  // that need encoding too — encodeURIComponent handles both.
  return encodeURIComponent(code);
}

interface ApiCallOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function filooFetch({ method, path, body, query }: ApiCallOptions): Promise<unknown> {
  const apiKey = process.env.FILOO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FILOO_API_KEY is not set. Get an API key at https://filoo.app/dashboard/api and add it to your MCP client config.",
    );
  }

  let url = `${API_BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": `${PKG_NAME}/${PKG_VERSION}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error calling filoo API: ${msg}`);
  }

  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as text
    }
  }

  if (!res.ok) {
    let apiMsg = "";
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      apiMsg = String(p.error ?? p.message ?? "");
    }
    if (!apiMsg) apiMsg = typeof parsed === "string" ? parsed : res.statusText;
    throw new Error(`filoo API ${res.status} ${res.statusText}: ${apiMsg}`);
  }

  return parsed;
}

// ---------- Tool schemas ----------

const SlugRe = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;
const CodeRe = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/i;

const CreateLinkInput = z.object({
  destination: z.string().url().describe("The long URL to shorten. Must be a fully-qualified http(s) URL."),
  slug: z
    .string()
    .regex(SlugRe, "slug must be 1–64 chars, alphanumeric and hyphens")
    .optional()
    .describe("Optional custom slug, e.g. 'spring-sale'. If omitted, filoo generates a short random slug."),
  username: z
    .string()
    .optional()
    .describe("Username to publish the link under. Defaults to your primary username if omitted. Use filoo_list_usernames to see what you own."),
  label: z
    .string()
    .max(255)
    .optional()
    .describe("Optional human label for your own dashboard, not shown publicly."),
});

const ListLinksInput = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("Number of links to return per page, max 100. Default 20."),
  cursor: z.string().optional().describe("Opaque pagination cursor returned by a previous filoo_list_links call."),
});

const CodeInput = z.object({
  code: z.string().regex(CodeRe, "code must be in the form username:slug").describe("Link code in the form 'username:slug', e.g. 'agency:campaign-1'."),
});

const UpdateLinkInput = z.object({
  code: z.string().regex(CodeRe).describe("Link code in the form 'username:slug'."),
  destination: z.string().url().optional().describe("New long URL to redirect to. Past destinations are kept in the audit trail."),
  label: z.string().max(255).optional().describe("New human label for your dashboard."),
  active: z.boolean().optional().describe("Set false to disable the link (returns 410 Gone on click) without deleting it."),
});

const EmptyInput = z.object({}).strict();

// ---------- Tool definitions ----------

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

function js(schema: z.ZodTypeAny, required: string[] = []): Record<string, unknown> {
  // Hand-crafted JSON schemas — zod-to-json-schema would work but we keep the
  // dependency footprint minimal. The MCP client only needs a structurally
  // valid JSON Schema describing inputs.
  return { type: "object", properties: (schema as any)._propsHint ?? {}, required };
}

const tools: ToolDef[] = [
  {
    name: "filoo_me",
    description:
      "Get the authenticated filoo user's account: tier (free/solo/pro/agents/lifetime), owned usernames, boost credits, and tier limits (active links cap, links-per-day quota, API rate limit). Call this first when an agent needs to know what username to publish under or how much headroom is left.",
    schema: EmptyInput,
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => filooFetch({ method: "GET", path: "/me" }),
  },
  {
    name: "filoo_usage",
    description:
      "Get today's filoo usage versus quotas: links created today, daily creation cap, API calls today, active link count, active link cap, remaining boost credits. Use before bulk-creating links to avoid hitting limits.",
    schema: EmptyInput,
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => filooFetch({ method: "GET", path: "/usage" }),
  },
  {
    name: "filoo_list_usernames",
    description:
      "List every username the authenticated user owns on filoo, along with which one is primary. Short links live under a username (filoo.app/{username}/{slug}), so this is the canonical way for an agent to discover what namespaces it can publish into.",
    schema: EmptyInput,
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => filooFetch({ method: "GET", path: "/usernames" }),
  },
  {
    name: "filoo_create_link",
    description:
      "Create a new short link on filoo. Returns the short_url (filoo.app/{username}/{slug}) and the link code. Use this whenever an agent needs to shorten a URL, hand a clean URL to a user, generate a QR-friendly link, or attach click tracking to an outbound URL. Counts against the daily creation quota and active link cap — call filoo_usage first if unsure.",
    schema: CreateLinkInput,
    jsonSchema: {
      type: "object",
      properties: {
        destination: { type: "string", format: "uri", description: "The long URL to shorten (http or https)." },
        slug: { type: "string", description: "Optional custom slug like 'spring-sale'. Alphanumeric + hyphens, 1–64 chars. Auto-generated if omitted." },
        username: { type: "string", description: "Username to publish under. Defaults to the user's primary username." },
        label: { type: "string", description: "Optional private label shown only in the dashboard." },
      },
      required: ["destination"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = CreateLinkInput.parse(args);
      return filooFetch({ method: "POST", path: "/links", body: input });
    },
  },
  {
    name: "filoo_list_links",
    description:
      "List the authenticated user's short links, newest first, cursor-paginated. Returns items[] with code, short_url, destination, created_at, plus a cursor to fetch the next page. Use to inventory existing links before creating a new one (avoid duplicates) or to find a link by destination.",
    schema: ListLinksInput,
    jsonSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size, max 100. Default 20." },
        cursor: { type: "string", description: "Pagination cursor from a previous call." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = ListLinksInput.parse(args ?? {});
      return filooFetch({ method: "GET", path: "/links", query: { limit: input.limit, cursor: input.cursor } });
    },
  },
  {
    name: "filoo_get_link",
    description:
      "Get full details for one filoo short link by code. The code format is 'username:slug' (the colon is URL-encoded automatically). Returns destination, label, active flag, created_at, and short_url.",
    schema: CodeInput,
    jsonSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Link code in the form 'username:slug', e.g. 'agency:campaign-1'." } },
      required: ["code"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { code } = CodeInput.parse(args);
      return filooFetch({ method: "GET", path: `/links/${encodeCode(code)}` });
    },
  },
  {
    name: "filoo_update_link",
    description:
      "Update a filoo short link in place: change its destination (the previous destination is kept in the audit history so the short URL is safe to repoint), edit its label, or disable/re-enable it with active. The short_url itself never changes. Useful for keeping a stable short URL while migrating the target.",
    schema: UpdateLinkInput,
    jsonSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Link code in the form 'username:slug'." },
        destination: { type: "string", format: "uri", description: "New long URL to redirect to." },
        label: { type: "string", description: "New private label." },
        active: { type: "boolean", description: "Set false to disable the link, true to re-enable." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { code, ...patch } = UpdateLinkInput.parse(args);
      return filooFetch({ method: "PATCH", path: `/links/${encodeCode(code)}`, body: patch });
    },
  },
  {
    name: "filoo_delete_link",
    description:
      "Permanently delete a filoo short link. The short_url stops resolving (returns 404). Click history is preserved on the filoo side for analytics. This action cannot be undone — confirm with the user before calling unless they explicitly asked to delete.",
    schema: CodeInput,
    jsonSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Link code in the form 'username:slug'." } },
      required: ["code"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { code } = CodeInput.parse(args);
      return filooFetch({ method: "DELETE", path: `/links/${encodeCode(code)}` });
    },
  },
  {
    name: "filoo_link_stats",
    description:
      "Get click/scan analytics for one filoo short link: total clicks, unique visitors, bot count, top countries, and top traffic sources (including QR-code sources). Use to answer questions like 'how is my campaign link doing?' or to compare performance across links.",
    schema: CodeInput,
    jsonSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Link code in the form 'username:slug'." } },
      required: ["code"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const { code } = CodeInput.parse(args);
      return filooFetch({ method: "GET", path: `/links/${encodeCode(code)}/stats` });
    },
  },
];

// ---------- MCP server wiring ----------

const server = new Server(
  { name: "filoo", version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(req.params.arguments ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: msg }],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't pollute the stdio JSON-RPC channel.
  process.stderr.write(`${PKG_NAME} v${PKG_VERSION} ready on stdio (API ${API_BASE})\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
