# Excalidraw MCP

【[English](../README.md) | 简体中文】

通过 MCP (Model Context Protocol) 让 Claude Code 直接操控 Obsidian 中的 Excalidraw 画布——读取元素、创建图形、修改属性、删除元素、保存文件，一切在对话中完成。

## 架构

```
Claude Code                     MCP Bridge Shim              Obsidian Excalidraw Plugin
(外部进程)                        (外部 node 进程)               (Electron 内)

┌──────────┐   stdio    ┌──────────────────────┐   HTTP    ┌─────────────────────────┐
│  Claude   │ ────────→ │  McpBridgeShim        │ ────────→ │  McpBridgeServer          │
│           │ ←──────── │  + StdioTransport     │ ←──────── │  :27124 (内嵌 HTTP)       │
│           │           │  + PluginClient       │           │  ↓                        │
│           │           │    (自动端口扫描)       │           │  ExcalidrawPlugin          │
└──────────┘           └──────────────────────┘           │  → activeExcalidrawView   │
                                                           │  → excalidrawAPI          │
                                                           │  → getSceneElements()     │
                                                           └─────────────────────────┘
```

- **插件侧** (`McpBridgeServer`): 嵌入在 Obsidian Excalidraw 插件中的 HTTP JSON-RPC 服务器。绑定 `127.0.0.1:27124`（端口冲突自动递增）。直接访问 `ExcalidrawView.excalidrawAPI`。
- **Shim 侧** (`McpBridgeShim`): Claude Code 通过 stdio 启动的独立进程。自动发现插件端口，动态拉取工具列表，将所有 MCP 调用代理到插件。

两者从同一工程构建 —— `npm run build` 同时产出 `dist/main.js`（插件）和 `dist/mcp-shim.js`（shim）。

## 安装

### 1. 构建

```bash
cd obsidian-excalidraw-plugin
npm install
npm run build
```

将 **四个文件** 复制到 Obsidian vault 的插件目录：

```bash
cp dist/main.js dist/manifest.json dist/styles.css dist/mcp-shim.js \
  "{你的Vault路径}/.obsidian/plugins/obsidian-excalidraw-plugin/"
```

在 `{Vault}/.obsidian/community-plugins.json` 中启用插件：

```json
["obsidian-excalidraw-plugin"]
```

### 2. 配置 Claude Code

在 `~/.claude.json` 的 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "excalidraw": {
      "type": "stdio",
      "command": "node",
      "args": ["{你的Vault路径}/.obsidian/plugins/obsidian-excalidraw-plugin/mcp-shim.js"]
    }
  }
}
```

### 3. 重启

1. 重启 Obsidian
2. 打开任意 `.excalidraw.md` 文件
3. 新开 Claude Code session

## 支持的工具

### 读取工具

| 工具 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `get_active_file` | 无 | `{ path, name }` | 当前活跃的 Excalidraw 文件路径和名称 |
| `list_open_drawings` | 无 | `[{ path, name, active }]` | 所有打开的 Excalidraw 文件列表 |
| `get_scene_elements` | `filePath?` | `{ elements, count }` | 获取画布所有元素（矩形、文字、箭头等） |
| `get_app_state` | 无 | AppState 对象 | 当前画布状态：缩放、滚动位置、主题等 |
| `get_files` | 无 | `{ files, count }` | 画布引用的二进制文件（图片等） |
| `query_elements` | `type?`, `filter?` | `{ elements, count }` | 按类型或属性过滤元素 |
| `get_resource` | `resource` | 资源摘要 | scene（视口）/ theme（主题）/ elements（统计）/ library（模具库） |

### 写入工具

| 工具 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `create_element` | `type`, `x`, `y`, `width?`, `height?`, ... | `{ element, id }` | 创建新元素 |
| `update_element` | `id` + 要修改的字段 | `{ updated, id }` | 更新已有元素属性 |
| `delete_element` | `id` | `{ deleted, id }` | 删除元素（软删除，可恢复） |
| `save_file` | 无 | `{ saved, path }` | 强制保存当前文件 |
| `open_file` | `path` | `{ opened, path }` | 打开指定路径的 Excalidraw 文件 |

### create_element 支持的 type

`rectangle`, `ellipse`, `diamond`, `arrow`, `text`, `line`, `image`, `frame`

其他可选字段：`backgroundColor`, `strokeColor`, `strokeWidth`, `roughness`, `opacity`, `fontSize`, `fontFamily`, `label`（自动转绑定文本）, `link`, `locked`, `roundness`, `points`（箭头/线条的路径点）, `startArrowhead`, `endArrowhead`, `startBinding`, `endBinding`, `containerId`, `groupIds`

## 使用示例

### 读取当前画布信息

```
> 当前画布里有什么元素？

→ get_active_file → "产品路线图.excalidraw.md"
→ get_scene_elements → { elements: [...], count: 47 }
→ query_elements type="text" → 12 个文字标签
```

### 查询特定类型的元素

```
> 画布里有哪些矩形框？

→ query_elements type="rectangle"
  → 15 个矩形元素，包含坐标、颜色、绑定文字等完整属性
```

### 添加一个新矩形

```
> 在 (200, 300) 位置加一个蓝色圆角框，标签写"新功能"

→ create_element {
    type: "rectangle",
    x: 200, y: 300,
    width: 180, height: 80,
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeColor: "#4a9eed",
    roundness: { type: 3 },
    label: { text: "新功能", fontSize: 18 }
  }
  → 元素立刻出现在 Obsidian 画布中
```

### 修改元素

```
> 把刚才那个框改成绿色，文字改成"已完成"

→ update_element {
    id: "abc123...",
    backgroundColor: "#b2f2bb",
    label: { text: "已完成" }
  }
```

### 删除元素

```
> 删除 id 为 xyz789 的元素

→ delete_element { id: "xyz789" }
```

### 查看画布状态

```
> 当前画布什么主题？缩放多少？

→ get_app_state
  → { theme: "dark", zoom: { value: 1.5 }, scrollX: 120, scrollY: 80, ... }
```

### 获取画布概览

```
> 画布里各种类型的元素分别有多少？

→ get_resource resource="elements"
  → { totalCount: 79, byType: { text: 28, arrow: 22, rectangle: 15, ... } }
```

## 完整对话示例

```
用户: 帮我在「AI时代一人公司架构」画布里加一个"新模块"框

Claude: (通过 MCP 自动执行)
  1. list_open_drawings → 确认文件已打开
  2. get_scene_elements → 了解现有布局
  3. query_elements type="rectangle" → 找到最右下角框的位置
  4. create_element type="rectangle" x=... y=... label="新模块"
  5. save_file → 保存

  ✓ 已在右下角添加蓝色"新模块"框，并保存文件。
```

## 故障排除

### 连接不上 (Connection refused)

```bash
# 确认 Obsidian 已启动且 Excalidraw 文件已打开
# 手动测试 HTTP 接口
curl -X POST http://127.0.0.1:27124 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 端口冲突

如果 27124 被占用，插件会自动尝试 27125、27126...Shim 会自动扫描端口范围。

### 返回 "No active Excalidraw drawing"

确保 Obsidian 中有一个 `.excalidraw.md` 文件正在 **Excalidraw 视图**中打开（而非 Markdown 源码视图）。

### 元素未出现

`create_element` 后新元素立即出现在画布中。如果没看到，检查坐标是否在可见区域内，或调用 `get_app_state` 查看当前视口位置。

### macOS 沙箱

macOS 可能阻止插件将端口文件写入 `/tmp`，这不影响功能——shim 会先尝试硬编码的默认端口 27124。

## 开发

### 目录结构

```
obsidian-excalidraw-plugin/
├── src/mcp/
│   ├── McpBridgeServer.ts    # 插件内嵌 HTTP JSON-RPC 服务器
│   ├── McpBridgeShim.ts      # MCP Shim 入口（Claude Code 启动）
│   └── zh-cn/
│       └── README.md          # 中文文档
├── dist/
│   ├── main.js               # 插件构建产物
│   ├── mcp-shim.js           # Shim 构建产物
│   └── ...
└── rollup.config.mjs         # 一次构建同时产出两个目标
```

### 添加新工具

1. 在 `McpBridgeServer.ts` 的 `buildToolDefinitions()` 中添加工具定义
2. 在 `callTool()` 的 switch 中添加 case
3. 实现对应的 private 方法
4. 运行 `npm run build`
5. 复制 `dist/main.js` + `dist/mcp-shim.js` 到 vault 插件目录
6. 重启 Obsidian

Shim 会自动从插件拉取最新的工具列表并注册代理——无需修改 shim 代码。
