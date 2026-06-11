# Excalidraw MCP

【English | [简体中文](./zh-cn/README.md)】

MCP (Model Context Protocol) bridge for Obsidian Excalidraw — enable Claude Code to directly control Excalidraw drawings in Obsidian: read elements, create shapes, modify properties, delete elements, save files, all within the conversation.

## Architecture

```
Claude Code                     MCP Bridge Shim              Obsidian Excalidraw Plugin
(external process)              (external node process)       (inside Electron)

┌──────────┐   stdio    ┌──────────────────────┐   HTTP    ┌─────────────────────────┐
│  Claude   │ ────────→ │  McpBridgeShim        │ ────────→ │  McpBridgeServer          │
│           │ ←──────── │  + StdioTransport     │ ←──────── │  :27124 (embedded HTTP)   │
│           │           │  + PluginClient       │           │  ↓                        │
│           │           │    (auto port scan)    │           │  ExcalidrawPlugin          │
└──────────┘           └──────────────────────┘           │  → activeExcalidrawView   │
                                                           │  → excalidrawAPI          │
                                                           │  → getSceneElements()     │
                                                           └─────────────────────────┘
```

- **Plugin side** (`McpBridgeServer`): Embedded HTTP JSON-RPC server inside the Obsidian Excalidraw plugin. Binds to `127.0.0.1:27124` (auto-increment on conflict). Directly accesses `ExcalidrawView.excalidrawAPI`.
- **Shim side** (`McpBridgeShim`): Standalone process launched by Claude Code via stdio. Auto-discovers the plugin port, dynamically fetches tool definitions, proxies all MCP tool calls to the plugin.

Both are built from the same codebase — `npm run build` produces `dist/main.js` (plugin) and `dist/mcp-shim.js` (shim).

## Installation

### 1. Build

```bash
cd obsidian-excalidraw-plugin
npm install
npm run build
```

Copy four files to your Obsidian vault's plugin directory:

```bash
cp dist/main.js dist/manifest.json dist/styles.css dist/mcp-shim.js \
  "{vault}/.obsidian/plugins/obsidian-excalidraw-plugin/"
```

Enable the plugin in `{vault}/.obsidian/community-plugins.json`:

```json
["obsidian-excalidraw-plugin"]
```

### 2. Configure Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "excalidraw": {
      "type": "stdio",
      "command": "node",
      "args": ["{vault}/.obsidian/plugins/obsidian-excalidraw-plugin/mcp-shim.js"]
    }
  }
}
```

### 3. Restart

1. Restart Obsidian
2. Open any `.excalidraw.md` file
3. Start a new Claude Code session

## Tools

### Read Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `get_active_file` | none | `{ path, name }` | Currently active Excalidraw file path and name |
| `list_open_drawings` | none | `[{ path, name, active }]` | All open Excalidraw files |
| `get_scene_elements` | `filePath?` | `{ elements, count }` | All canvas elements (shapes, text, arrows, etc.) |
| `get_app_state` | none | AppState object | Current canvas state: zoom, scroll, theme, etc. |
| `get_files` | none | `{ files, count }` | Binary files referenced by the drawing (images, etc.) |
| `query_elements` | `type?`, `filter?` | `{ elements, count }` | Filter elements by type or properties |
| `get_resource` | `resource` | Resource summary | scene (viewport) / theme / elements (stats) / library |

### Write Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `create_element` | `type`, `x`, `y`, `width?`, `height?`, ... | `{ element, id }` | Create a new element |
| `update_element` | `id` + fields to update | `{ updated, id }` | Update element properties |
| `delete_element` | `id` | `{ deleted, id }` | Delete element (soft delete, recoverable) |
| `save_file` | none | `{ saved, path }` | Force save current file |
| `open_file` | `path` | `{ opened, path }` | Open an Excalidraw file by path |

### Supported `type` values for `create_element`

`rectangle`, `ellipse`, `diamond`, `arrow`, `text`, `line`, `image`, `frame`

Other optional fields: `backgroundColor`, `strokeColor`, `strokeWidth`, `roughness`, `opacity`, `fontSize`, `fontFamily`, `label` (auto-converts to bound text), `link`, `locked`, `roundness`, `points` (path points for arrows/lines), `startArrowhead`, `endArrowhead`, `startBinding`, `endBinding`, `containerId`, `groupIds`

## Usage Examples

### Inspect the current drawing

```
> What's in the current canvas?

→ get_active_file → "Product Roadmap.excalidraw.md"
→ get_scene_elements → { elements: [...], count: 47 }
→ query_elements type="text" → 12 text labels
```

### Query specific element types

```
> How many rectangles are there?

→ query_elements type="rectangle"
  → 15 rectangles with full coordinates, colors, and bound text
```

### Add a new rectangle

```
> Add a blue rounded box at (200, 300) labeled "New Feature"

→ create_element {
    type: "rectangle",
    x: 200, y: 300,
    width: 180, height: 80,
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeColor: "#4a9eed",
    roundness: { type: 3 },
    label: { text: "New Feature", fontSize: 18 }
  }
  → Element appears instantly on the Obsidian canvas
```

### Update an element

```
> Change that box to green and rename to "Done"

→ update_element {
    id: "abc123...",
    backgroundColor: "#b2f2bb",
    label: { text: "Done" }
  }
```

### Delete an element

```
> Delete element xyz789

→ delete_element { id: "xyz789" }
```

### Check canvas state

```
> What theme and zoom level?

→ get_app_state
  → { theme: "dark", zoom: { value: 1.5 }, scrollX: 120, scrollY: 80, ... }
```

### Get element overview

```
> What types of elements are in the drawing and how many of each?

→ get_resource resource="elements"
  → { totalCount: 79, byType: { text: 28, arrow: 22, rectangle: 15, ... } }
```

## Full Conversation Example

```
User: Add a "New Module" box to the One-Person Company Architecture drawing

Claude: (automatically via MCP)
  1. list_open_drawings → confirm file is open
  2. get_scene_elements → understand current layout
  3. query_elements type="rectangle" → find position of bottom-right box
  4. create_element type="rectangle" x=... y=... label="New Module"
  5. save_file → persist

  ✓ Added blue "New Module" box at bottom-right. File saved.
```

## Troubleshooting

### Connection refused

```bash
# Verify Obsidian is running and an Excalidraw file is open
# Test the HTTP endpoint manually
curl -X POST http://127.0.0.1:27124 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Port conflict

If port 27124 is in use, the plugin automatically tries 27125, 27126... The shim scans a port range automatically.

### "No active Excalidraw drawing"

Make sure an `.excalidraw.md` file is open in **Excalidraw view** (not Markdown source view) in Obsidian.

### Elements not appearing

After `create_element`, the element appears instantly. If you don't see it, check whether the coordinates are within the visible area, or call `get_app_state` to view the current viewport position.

### macOS sandbox

macOS may prevent the plugin from writing a port file to `/tmp`. This does not affect functionality — the shim tries the hardcoded default port 27124 first.

## Development

### Directory Structure

```
obsidian-excalidraw-plugin/
├── src/mcp/
│   ├── McpBridgeServer.ts    # Plugin-embedded HTTP JSON-RPC server
│   ├── McpBridgeShim.ts      # MCP Shim entry (launched by Claude Code)
│   └── zh-cn/
│       └── README.md          # Chinese documentation
├── dist/
│   ├── main.js               # Plugin build output
│   ├── mcp-shim.js           # Shim build output
│   └── ...
└── rollup.config.mjs         # Single build produces both outputs
```

### Adding New Tools

1. Add tool definition in `McpBridgeServer.ts` → `buildToolDefinitions()`
2. Add case in `callTool()` switch
3. Implement the corresponding private method
4. Run `npm run build`
5. Copy `dist/main.js` + `dist/mcp-shim.js` to vault plugin directory
6. Restart Obsidian

The shim automatically fetches the latest tool list from the plugin and registers proxies — no shim changes needed.
