/**
 * MCP Bridge Server — Embedded HTTP/JSON-RPC server inside the Obsidian Excalidraw plugin.
 *
 * Architecture:
 *   Claude Code → (stdio) → MCP Bridge Shim → (HTTP) → McpBridgeServer → ExcalidrawPlugin
 *
 * This server binds to a localhost port and translates JSON-RPC tool calls into
 * direct ExcalidrawPlugin/ExcalidrawView/ExcalidrawAutomate API calls.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type ExcalidrawPlugin from "../core/main";
import type ExcalidrawView from "../view/ExcalidrawView";
import type { ExcalidrawElement } from "@zsviczian/excalidraw/types/element/src/types";
import type { AppState, BinaryFiles } from "@zsviczian/excalidraw/types/excalidraw/types";
import { t } from "../lang/helpers";
import { getExcalidrawViews } from "../utils/obsidianUtils";

// ============================================================================
// Types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

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

// ============================================================================
// Tool registry
// ============================================================================

function buildToolDefinitions(): ToolDefinition[] {
  return [
    // ── Read tools ──────────────────────────────────────────────
    {
      name: "get_active_file",
      description:
        "Get the path of the currently active Excalidraw drawing file. Returns null if no drawing is open.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_open_drawings",
      description:
        "List all currently open Excalidraw drawings across all Obsidian leaves.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_scene_elements",
      description:
        "Get all elements (shapes, text, arrows, images, etc.) from the currently active Excalidraw drawing. Returns the full Excalidraw element array.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Optional: specific drawing file path. Defaults to the currently active drawing.",
          },
        },
      },
    },
    {
      name: "get_app_state",
      description:
        "Get the current app state (zoom, scroll position, theme, view mode, etc.) of the active Excalidraw view.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_files",
      description:
        "Get the binary files (images, etc.) referenced by the current Excalidraw drawing. Keys are file IDs, values contain mimeType and dataURL.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "query_elements",
      description:
        "Query elements from the active drawing with optional type and property filters. Returns matching elements.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Filter by element type: rectangle, ellipse, diamond, arrow, text, line, image, frame, etc.",
          },
          filter: {
            type: "object",
            description:
              "Arbitrary key/value filter applied to matching elements (e.g. { backgroundColor: '#a5d8ff' }).",
          },
        },
      },
    },
    {
      name: "get_resource",
      description:
        "Get high-level resource summaries. 'scene' returns viewport info; 'elements' returns element count summary; 'theme' returns theme mode.",
      inputSchema: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            enum: ["scene", "library", "theme", "elements"],
          },
        },
        required: ["resource"],
      },
    },

    // ── Write tools ─────────────────────────────────────────────
    {
      name: "create_element",
      description:
        "Create a new element in the active Excalidraw drawing. Returns the created element with its assigned id.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "rectangle",
              "ellipse",
              "diamond",
              "arrow",
              "text",
              "label",
              "freedraw",
              "line",
              "image",
              "frame",
            ],
          },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          backgroundColor: { type: "string" },
          strokeColor: { type: "string" },
          strokeWidth: { type: "number" },
          roughness: { type: "number" },
          opacity: { type: "number" },
          text: { type: "string" },
          fontSize: { type: "number" },
          fontFamily: { type: "string" },
          roundness: {
            type: "object",
            description: 'Shape roundness, e.g. { type: 3 }. For rounded corners.',
          },
          points: {
            type: "array",
            description: "Point array for arrows and lines: [[x1,y1],[x2,y2],...]",
          },
          startArrowhead: { type: "string" },
          endArrowhead: { type: "string" },
          startBinding: { type: "object" },
          endBinding: { type: "object" },
          containerId: { type: "string" },
          groupIds: { type: "array" },
          label: {
            type: "object",
            description:
              'Label configuration: { text: "hello", fontSize: 16, textAlign: "center" }',
          },
          link: { type: "string" },
          locked: { type: "boolean" },
        },
        required: ["type", "x", "y"],
      },
    },
    {
      name: "update_element",
      description:
        "Update an existing element's properties in the active drawing. Only provided fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The element ID to update." },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          backgroundColor: { type: "string" },
          strokeColor: { type: "string" },
          strokeWidth: { type: "number" },
          roughness: { type: "number" },
          opacity: { type: "number" },
          text: { type: "string" },
          fontSize: { type: "number" },
          fontFamily: { type: "string" },
          points: { type: "array" },
          startArrowhead: { type: "string" },
          endArrowhead: { type: "string" },
          startBinding: { type: "object" },
          endBinding: { type: "object" },
          containerId: { type: "string" },
          groupIds: { type: "array" },
          label: { type: "object" },
          link: { type: "string" },
          locked: { type: "boolean" },
          roundness: { type: "object" },
          angle: { type: "number" },
          isDeleted: { type: "boolean" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_element",
      description:
        "Delete an element (by marking isDeleted=true) from the active drawing. The element is soft-deleted and can be restored via update_element.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The element ID to delete." },
        },
        required: ["id"],
      },
    },
    {
      name: "save_file",
      description:
        "Force save the currently active Excalidraw drawing to disk.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "open_file",
      description:
        "Open an Excalidraw drawing file by path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The vault-relative path of the drawing to open." },
        },
        required: ["path"],
      },
    },
  ];
}

// ============================================================================
// MCP Bridge Server
// ============================================================================

const DEFAULT_PORT = 27124;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export class McpBridgeServer {
  private server: http.Server | null = null;
  private port: number;
  private plugin: ExcalidrawPlugin;
  private tools = buildToolDefinitions();

  constructor(plugin: ExcalidrawPlugin, port: number = DEFAULT_PORT) {
    this.plugin = plugin;
    this.port = port;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        resolve();
        return;
      }

      const log = (msg: string) =>
        console.log(`[Excalidraw MCP] ${msg}`);

      log(`Attempting to start HTTP server on port ${this.port}...`);

      try {
        this.server = http.createServer((req, res) => {
          void this.handleRequest(req, res);
        });
      } catch (err) {
        log(`ERROR: Failed to create HTTP server: ${err}`);
        // Try writing diagnostic info for the shim
        this.writeDiagnosticFile(`http.createServer failed: ${err}`);
        resolve(); // Don't block plugin init
        return;
      }

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        log(`Server error: ${err.code} ${err.message}`);
        if (err.code === "EADDRINUSE") {
          this.server?.close();
          this.server = null;
          this.port++;
          log(`Port in use, trying ${this.port}...`);
          this.start().then(resolve);
        } else {
          this.writeDiagnosticFile(`Server error: ${err.code} ${err.message}`);
          resolve();
        }
      });

      try {
        this.server.listen(this.port, "127.0.0.1", () => {
          log(`✓ Bridge server listening on http://127.0.0.1:${this.port}`);
          this.writePortFile();
          resolve();
        });
      } catch (err) {
        log(`ERROR: listen() threw: ${err}`);
        this.writeDiagnosticFile(`listen() failed: ${err}`);
        resolve();
      }
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      // Clean up port file
      try {
        fs.unlinkSync(McpBridgeServer.getPortFilePath());
      } catch { /* ignore */ }
      console.log("[Excalidraw MCP] Bridge server stopped");
    }
  }

  getPort(): number {
    return this.port;
  }

  /** Returns the path where the port file is written. Shim reads this to discover the server. */
  static getPortFilePath(): string {
    return path.join(os.tmpdir(), "obsidian-excalidraw-mcp-port");
  }

  /** Fallback diagnostic file path — written even if the HTTP server fails to start. */
  private getDiagnosticFilePath(): string {
    return path.join(os.tmpdir(), "obsidian-excalidraw-mcp-diag.txt");
  }

  private writePortFile(): void {
    try {
      fs.writeFileSync(McpBridgeServer.getPortFilePath(), String(this.port), "utf-8");
      console.log(
        `[Excalidraw MCP] Port file written: ${McpBridgeServer.getPortFilePath()} → ${this.port}`,
      );
    } catch (err) {
      console.warn("[Excalidraw MCP] Failed to write port file:", err);
    }
  }

  private writeDiagnosticFile(message: string): void {
    try {
      const diagPath = this.getDiagnosticFilePath();
      fs.writeFileSync(
        diagPath,
        `timestamp: ${new Date().toISOString()}\nport: ${this.port}\nmessage: ${message}\nosTmpdir: ${os.tmpdir()}\ncwd: ${process.cwd?.() ?? "N/A"}\n`,
        "utf-8",
      );
      console.log(`[Excalidraw MCP] Diagnostic file written: ${diagPath}`);
    } catch {
      // Can't even write diagnostic — nothing more we can do
      console.warn("[Excalidraw MCP] ALL file writes failed");
    }
  }

  // ── Request handling ──────────────────────────────────────────

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // CORS for local-only access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Only POST is supported" },
        }),
      );
      return;
    }

    try {
      const body = await this.readBody(req);
      const request: JsonRpcRequest = JSON.parse(body);

      if (request.method === "tools/list") {
        this.sendResponse(res, request.id, { tools: this.tools });
        return;
      }

      if (request.method === "tools/call") {
        const result = await this.callTool(request.params);
        this.sendResponse(res, request.id, result);
        return;
      }

      this.sendError(res, request.id, -32601, `Unknown method: ${request.method}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Excalidraw MCP] Request error:", message);
      this.sendError(res, null, -32700, `Parse error: ${message}`);
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private sendResponse(
    res: http.ServerResponse,
    id: number | string | null,
    result: unknown,
  ): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private sendError(
    res: http.ServerResponse,
    id: number | string | null,
    code: number,
    message: string,
  ): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  // ── Tool dispatcher ───────────────────────────────────────────

  private async callTool(
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const { name, arguments: args = {} } = params ?? {};
    if (!name || typeof name !== "string") {
      throw new Error("Missing tool name");
    }

    switch (name) {
      // ── Read tools ──────────────────────────────
      case "get_active_file":
        return this.getActiveFile();
      case "list_open_drawings":
        return this.listOpenDrawings();
      case "get_scene_elements":
        return this.getSceneElements(args as Record<string, unknown>);
      case "get_app_state":
        return this.getAppState();
      case "get_files":
        return this.getFiles();
      case "query_elements":
        return this.queryElements(args as Record<string, unknown>);
      case "get_resource":
        return this.getResource(args as Record<string, unknown>);

      // ── Write tools ─────────────────────────────
      case "create_element":
        return this.createElement(args as Record<string, unknown>);
      case "update_element":
        return this.updateElement(args as Record<string, unknown>);
      case "delete_element":
        return this.deleteElement(args as Record<string, unknown>);
      case "save_file":
        return this.saveFile();
      case "open_file":
        return this.openFile(args as Record<string, unknown>);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ── View resolution helpers ───────────────────────────────────

  private getActiveView(): ExcalidrawView | null {
    return this.plugin.activeExcalidrawView;
  }

  private resolveView(
    filePath?: string,
  ): ExcalidrawView | null {
    if (filePath) {
      const views = getExcalidrawViews(this.plugin.app);
      const found = views.find((v) => v.file?.path === filePath);
      return found ?? null;
    }
    return this.getActiveView();
  }

  private requireView(view: ExcalidrawView | null): ExcalidrawView {
    if (!view || !view.excalidrawAPI) {
      throw new Error(
        "No active Excalidraw drawing. Please open an Excalidraw file in Obsidian first.",
      );
    }
    return view;
  }

  // ── Tool implementations: Read ────────────────────────────────

  private getActiveFile(): { path: string | null; name: string | null } {
    const view = this.getActiveView();
    if (!view?.file) {
      return { path: null, name: null };
    }
    return { path: view.file.path, name: view.file.name };
  }

  private listOpenDrawings(): Array<{ path: string; name: string; active: boolean }> {
    const activePath = this.plugin.activeExcalidrawView?.file?.path ?? null;
    const views = getExcalidrawViews(this.plugin.app);
    return views.map((v) => ({
      path: v.file?.path ?? "",
      name: v.file?.name ?? "",
      active: v.file?.path === activePath,
    }));
  }

  private getSceneElements(args: Record<string, unknown>): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: any[];
    count: number;
  } {
    const view = this.resolveView(args.filePath as string | undefined);
    this.requireView(view);
    const elements = [...view!.excalidrawAPI.getSceneElements()];
    return { elements, count: elements.length };
  }

  private getAppState(): AppState | null {
    const view = this.getActiveView();
    this.requireView(view);
    return view!.excalidrawAPI.getAppState();
  }

  private getFiles(): { files: BinaryFiles; count: number } {
    const view = this.getActiveView();
    this.requireView(view);
    const files = view!.excalidrawAPI.getFiles();
    const count = Object.keys(files).length;
    return { files, count };
  }

  private queryElements(args: Record<string, unknown>): {
    elements: unknown[];
    count: number;
  } {
    const view = this.getActiveView();
    this.requireView(view);
    let elements = view!.excalidrawAPI.getSceneElements() as ExcalidrawElement[];

    const elType = args.type as string | undefined;
    if (elType) {
      elements = elements.filter((el) => el.type === elType);
    }

    const filter = args.filter as Record<string, unknown> | undefined;
    if (filter) {
      elements = elements.filter((el) => {
        const elObj = el as unknown as Record<string, unknown>;
        return Object.entries(filter).every(
          ([key, val]) => elObj[key] === val,
        );
      });
    }

    return { elements, count: elements.length };
  }

  private getResource(args: Record<string, unknown>): Record<string, unknown> {
    const view = this.getActiveView();
    this.requireView(view);
    const api = view!.excalidrawAPI;
    const resource = args.resource as string;

    switch (resource) {
      case "scene": {
        const st = api.getAppState();
        return {
          theme: st.theme ?? "light",
          viewport: {
            x: st.scrollX ?? 0,
            y: st.scrollY ?? 0,
            zoom: st.zoom?.value ?? 1,
            width: st.width ?? 800,
            height: st.height ?? 600,
          },
          selectedElementIds: st.selectedElementIds ?? {},
        };
      }
      case "elements": {
        const els = api.getSceneElements() as ExcalidrawElement[];
        const byType: Record<string, number> = {};
        els.forEach((el) => {
          byType[el.type] = (byType[el.type] || 0) + 1;
        });
        return { totalCount: els.length, byType };
      }
      case "theme": {
        const st = api.getAppState();
        return { theme: st.theme ?? "light" };
      }
      case "library": {
        return { library: this.plugin.getStencilLibrary() };
      }
      default:
        throw new Error(`Unknown resource: ${resource}`);
    }
  }

  // ── Tool implementations: Write ───────────────────────────────

  private async createElement(
    args: Record<string, unknown>,
  ): Promise<{ element: unknown; id: string }> {
    const view = this.getActiveView();
    this.requireView(view);
    const api = view!.excalidrawAPI;

    // Generate a unique ID using nanoid
    const { nanoid } = await import("../constants/constants");
    const id = nanoid();

    // Build a minimal Excalidraw element
    const elements = api.getSceneElements() as ExcalidrawElement[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newElement: Record<string, any> = {
      ...args,
      id,
      version: 1,
      versionNonce: Math.floor(Math.random() * 1000000),
      isDeleted: false,
    };

    // Set defaults based on type
    if (!newElement.width) {
      if (args.type === "text") newElement.width = 200;
      else if (args.type === "arrow" || args.type === "line") newElement.width = 0;
      else newElement.width = 100;
    }
    if (!newElement.height) {
      if (args.type === "text") newElement.height = 40;
      else if (args.type === "arrow" || args.type === "line") newElement.height = 0;
      else newElement.height = 100;
    }
    if (!newElement.strokeColor) newElement.strokeColor = "#1e1e1e";
    if (!newElement.strokeWidth) newElement.strokeWidth = 2;
    if (!newElement.roughness) newElement.roughness = 1;
    if (!newElement.opacity) newElement.opacity = 100;
    if (newElement.fillStyle === undefined) newElement.fillStyle = "solid";

    // Handle label → convert to bound text container pattern
    if (newElement.label && typeof newElement.label === "object") {
      const labelObj = newElement.label as Record<string, unknown>;
      if (labelObj.text && typeof labelObj.text === "string") {
        const labelId = nanoid();
        // Create a bound text element
        const textEl = {
          id: labelId,
          type: "text",
          x: newElement.x,
          y: newElement.y,
          width: newElement.width,
          height: newElement.height,
          text: labelObj.text,
          fontSize: (labelObj.fontSize as number) || 20,
          fontFamily: (labelObj.fontFamily as number) || 1,
          strokeColor: "#1e1e1e",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 2,
          roughness: 1,
          opacity: 100,
          containerId: id,
          version: 1,
          versionNonce: Math.floor(Math.random() * 1000000),
          isDeleted: false,
          textAlign: (labelObj.textAlign as string) || "center",
          verticalAlign: (labelObj.verticalAlign as string) || "middle",
        };
        newElement.boundElements = [{ id: labelId, type: "text" }];
        delete newElement.label;
        // Add the bound text element
        api.updateScene({
          elements: [...elements, newElement as unknown as ExcalidrawElement, textEl as unknown as ExcalidrawElement],
        });
        return { element: newElement, id };
      }
      delete newElement.label;
    }

    api.updateScene({
      elements: [...elements, newElement as unknown as ExcalidrawElement],
    });
    return { element: newElement, id };
  }

  private updateElement(
    args: Record<string, unknown>,
  ): { updated: boolean; id: string } {
    const view = this.getActiveView();
    this.requireView(view);
    const api = view!.excalidrawAPI;

    const { id, ...updates } = args;
    if (!id || typeof id !== "string") {
      throw new Error("Element id is required");
    }

    const elements = api.getSceneElements() as ExcalidrawElement[];
    const idx = elements.findIndex((el) => el.id === id);
    if (idx === -1) {
      throw new Error(`Element not found: ${id}`);
    }

    const updated = {
      ...elements[idx],
      ...updates,
      id, // prevent id override
    } as unknown as ExcalidrawElement;

    const newElements = [...elements];
    newElements[idx] = updated;
    api.updateScene({ elements: newElements });

    return { updated: true, id };
  }

  private deleteElement(
    args: Record<string, unknown>,
  ): { deleted: boolean; id: string } {
    const view = this.getActiveView();
    this.requireView(view);
    const api = view!.excalidrawAPI;

    const id = args.id as string;
    if (!id) {
      throw new Error("Element id is required");
    }

    const elements = api.getSceneElements() as ExcalidrawElement[];
    const idx = elements.findIndex((el) => el.id === id);
    if (idx === -1) {
      throw new Error(`Element not found: ${id}`);
    }

    const deleted = { ...elements[idx], isDeleted: true } as ExcalidrawElement;
    const newElements = [...elements];
    newElements[idx] = deleted;
    api.updateScene({ elements: newElements });

    return { deleted: true, id };
  }

  private async saveFile(): Promise<{ saved: boolean; path: string | null }> {
    const view = this.getActiveView();
    this.requireView(view);
    await view!.forceSave();
    return { saved: true, path: view!.file?.path ?? null };
  }

  private async openFile(
    args: Record<string, unknown>,
  ): Promise<{ opened: boolean; path: string }> {
    const path = args.path as string;
    if (!path) {
      throw new Error("File path is required");
    }

    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    this.plugin.openDrawing(file, "tab" as never, true);
    return { opened: true, path };
  }
}
