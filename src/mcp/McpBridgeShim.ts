/**
 * Obsidian Excalidraw MCP Shim
 *
 * This is the process that Claude Code launches via stdio.
 * It reads the port file written by the Obsidian Excalidraw plugin,
 * connects via HTTP to the plugin's embedded MCP bridge,
 * and proxies all tool calls.
 *
 * Architecture:
 *   Claude Code → (stdio) → THIS PROCESS → (HTTP) → Obsidian Excalidraw Plugin
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_PORT = 27124;
const PORT_FILE = path.join(os.tmpdir(), "obsidian-excalidraw-mcp-port");

// ============================================================================
// Plugin HTTP Client
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

class PluginClient {
  private port: number | null = null;
  private baseUrl: string | null = null;

  async discover(): Promise<void> {
    // Strategy 1: Try hardcoded default port first (most reliable — macOS sandbox
    // may prevent the port file from being written to /tmp)
    console.error(`[shim] Trying default port ${DEFAULT_PORT}...`);
    if (await this.tryPort(DEFAULT_PORT)) {
      return;
    }

    // Strategy 2: Check the port file
    try {
      if (fs.existsSync(PORT_FILE)) {
        const portStr = fs.readFileSync(PORT_FILE, "utf-8").trim();
        const port = parseInt(portStr, 10);
        if (!isNaN(port) && port >= 1 && port <= 65535) {
          if (await this.tryPort(port)) {
            return;
          }
        }
      }
    } catch {
      // Port file may not exist or be unreadable (macOS sandbox)
    }

    // Strategy 3: Scan a range of ports near the default
    for (let port = DEFAULT_PORT + 1; port <= DEFAULT_PORT + 10; port++) {
      if (await this.tryPort(port)) {
        return;
      }
    }

    throw new Error(
      `Could not connect to Obsidian Excalidraw MCP bridge.\n` +
        `Tried ports ${DEFAULT_PORT}-${DEFAULT_PORT + 10} and checked ${PORT_FILE}.\n` +
        `Please make sure:\n` +
        `  1. Obsidian is running\n` +
        `  2. The Excalidraw plugin is enabled\n` +
        `  3. An Excalidraw file is open in Obsidian\n` +
        `  4. The plugin was built with MCP bridge support`,
    );
  }

  private async tryPort(port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        this.port = port;
        this.baseUrl = url;
        console.error(`[shim] Connected to plugin at ${url}`);
        return true;
      }
    } catch {
      // Port not responding
    }
    return false;
  }

  async callRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl) {
      throw new Error("Plugin not discovered yet. Call discover() first.");
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as JsonRpcResponse;
    if (data.error) {
      throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
    }
    return data.result;
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = (await this.callRpc("tools/list", {})) as {
      tools: ToolDefinition[];
    };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callRpc("tools/call", { name, arguments: args });
  }
}

// ============================================================================
// MCP Server Setup
// ============================================================================

async function main() {
  const client = new PluginClient();

  console.error("[shim] Obsidian Excalidraw MCP Bridge starting...");

  // Connect to the plugin
  await client.discover();

  // Fetch available tools from the plugin
  console.error("[shim] Fetching tool list from plugin...");
  let pluginTools: ToolDefinition[];
  try {
    pluginTools = await client.listTools();
    console.error(`[shim] Got ${pluginTools.length} tools: ${pluginTools.map((t) => t.name).join(", ")}`);
  } catch (err) {
    console.error("[shim] Failed to fetch tools, using fallback set:", err);
    // Fallback: hardcoded tools matching the plugin
    pluginTools = getFallbackTools();
  }

  // Create MCP server
  const server = new McpServer({
    name: "obsidian-excalidraw",
    version: "1.0.0",
  });

  // Dynamically register each tool as a pass-through proxy
  for (const tool of pluginTools) {
    registerProxyTool(server, client, tool);
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[shim] MCP server connected via stdio. Ready.");
}

// ============================================================================
// Dynamic tool registration
// ============================================================================

function registerProxyTool(
  server: McpServer,
  client: PluginClient,
  tool: ToolDefinition,
): void {
  // Accept all args as a passthrough object — validation is done by the plugin
  const passthroughSchema = z.object({}).passthrough();

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: passthroughSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await client.callTool(tool.name, args);
        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

// ============================================================================
// Fallback tools (in case dynamic discovery fails)
// ============================================================================

function getFallbackTools(): ToolDefinition[] {
  return [
    {
      name: "get_active_file",
      description: "Get the path of the currently active Excalidraw drawing file.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_open_drawings",
      description: "List all currently open Excalidraw drawings.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_scene_elements",
      description: "Get all elements from the currently active Excalidraw drawing.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Optional specific file path." },
        },
      },
    },
    {
      name: "get_app_state",
      description: "Get the current app state of the active Excalidraw view.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_files",
      description: "Get binary files referenced by the current drawing.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "query_elements",
      description: "Query elements with optional type and property filters.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          filter: { type: "object" },
        },
      },
    },
    {
      name: "get_resource",
      description: "Get resource summaries: scene, elements, theme, library.",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", enum: ["scene", "library", "theme", "elements"] },
        },
        required: ["resource"],
      },
    },
    {
      name: "create_element",
      description: "Create a new element in the active Excalidraw drawing.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "arrow", "text", "line", "image", "frame"] },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          backgroundColor: { type: "string" },
          strokeColor: { type: "string" },
          strokeWidth: { type: "number" },
          text: { type: "string" },
          fontSize: { type: "number" },
          label: { type: "object" },
          points: { type: "array" },
          endArrowhead: { type: "string" },
          roundness: { type: "object" },
          containerId: { type: "string" },
          link: { type: "string" },
        },
        required: ["type", "x", "y"],
      },
    },
    {
      name: "update_element",
      description: "Update an existing element's properties.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          backgroundColor: { type: "string" },
          strokeColor: { type: "string" },
          text: { type: "string" },
          fontSize: { type: "number" },
          isDeleted: { type: "boolean" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_element",
      description: "Delete an element from the active drawing.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "save_file",
      description: "Force save the currently active Excalidraw drawing.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "open_file",
      description: "Open an Excalidraw drawing file by path.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];
}

// ============================================================================
// Entry point
// ============================================================================

main().catch((err) => {
  console.error("[shim] Fatal error:", err);
  process.exit(1);
});
