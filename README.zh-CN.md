# zotero-harness-bridge

**零依赖的 MCP 服务，把本机 Zotero 文献库接给 DeepSeek Harness（DSH），也能接给任何其他 MCP 客户端。**

[![CI](https://github.com/JARRY-DJH/zotero-harness-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/JARRY-DJH/zotero-harness-bridge/actions/workflows/ci.yml)
![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)

接好之后，模型可以检索文献库、读取条目元数据、浏览分类与标签、读取 PDF 的已索引全文、
导出 BibTeX 引用——都是普通工具调用，例如 `mcp__zotero__search_items`。

> English documentation: [README.md](README.md)

## 为什么另做一个

现成的 Zotero MCP 服务多是 Python 包，需要 `pip install` 和外网。这一个只 import
Node 自带的标准库：

- **零依赖。** 不需要 `npm install`、不需要 `pip`，没有构建步骤，没有 lockfile。
- **不含任何写死的路径。** 所有路径和 URL 都在运行时探测，或由环境变量给出，
  同一份代码在任何人的电脑上都能跑。
- **只读。** 不会写入你的文献库，不会下载附件，不会删除任何东西。
- **可离线使用。** 唯一会访问的地址是你自己配置的那个，默认就是本机 Zotero。

## 前提条件

| 组件 | 版本 |
|---|---|
| Node.js | 18 或更高（用到内置 `fetch`） |
| Zotero | 7.x 桌面版，保持运行，并已开启本地 API |
| DeepSeek Harness | 任意较新版本；自带 `@deepseek-ai/dsh-mcp-client` 就够 |

## 快速开始

### 1. 打开 Zotero 的本地 API

Zotero 菜单 **编辑 > 设置 > 高级**，勾选

> 允许此计算机上的其他应用程序与 Zotero 通讯

Zotero 必须保持运行：本地 API 只在程序开着的时候存在。

### 2. 取代码并自检

```bash
git clone https://github.com/JARRY-DJH/zotero-harness-bridge.git
cd zotero-harness-bridge
node src/server.mjs --check
```

不需要安装任何东西。通了会打印：

```
Zotero bridge self-check
  server            zotero-harness-bridge 0.1.0
  node              v22.x.x (C:\Program Files\nodejs\node.exe)
  platform          win32 x64
  apiBase           http://127.0.0.1:23119/api/users/0
  apiKeyConfigured  false
  timeoutMs         30000
  connected         yes
  sampleSize        1
```

如果是 `connected NO`，输出里的 error 会说明是三种常见原因里的哪一种。

### 3. 注册到 DSH

```bash
node scripts/setup.mjs --dsh
```

这条命令会探测你机器上 `node` 的位置和 `src/server.mjs` 的位置，
直接打印出填好的 patch 块。把它追加到你所用 DSH profile 的 patch 层：

| 操作系统 | 文件 |
|---|---|
| Windows | `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` |
| macOS / Linux | `~/.dsh/profiles/<profile>/cordis.patch.yml` |

想从模板改也行：`examples/dsh/cordis.patch.yml` 是同一个块，里面用
`<NODE_EXECUTABLE>` 和 `<SERVER_ENTRY>` 做占位符。

重启 DSH，工具就会以 `mcp__zotero__*` 的形式出现在模型面前。

### 4. 试一句

> 我的 Zotero 里有什么？

## 不装客户端也能验证

服务在 stdio 上说的是按行分隔的 JSON-RPC 2.0，可以直接手工喂：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/server.mjs
```

stdout 会返回两条 JSON-RPC 响应，诊断信息走 stderr。

## 配置项

每一项都是带可移植默认值的环境变量。DSH 会清洗子进程环境，所以需要的值必须写在
客户端配置的 `env:` 块里，指望从 shell 继承是拿不到的。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ZOTERO_API_BASE` | `http://127.0.0.1:23119/api/users/0` | 完整 API 基地址；需要时指向 Web API（`https://api.zotero.org/users/<id>`）或群组库 |
| `ZOTERO_LOCAL_HOST` | `127.0.0.1` | 未设置 `ZOTERO_API_BASE` 时使用的主机 |
| `ZOTERO_LOCAL_PORT` | `23119` | 未设置 `ZOTERO_API_BASE` 时使用的端口 |
| `ZOTERO_LIBRARY_TYPE` | `user` | `user` 或 `group` |
| `ZOTERO_LIBRARY_ID` | `0` | 库 ID；本地 API 只提供 `0`（我的文库） |
| `ZOTERO_API_KEY` | *（空）* | Web API 用；本地 API 不需要，日志里永不出现 |
| `ZOTERO_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |
| `ZOTERO_MCP_PROTOCOL` | `2025-11-25` | 应答使用的 MCP 协议版本 |

## 工具一览

| 工具 | 作用 |
|---|---|
| `zotero_status` | 连接自检：API 地址、是否配了 key、能否读取 |
| `zotero_search_items` | 按关键词/类型/标签/分类检索；`qmode=everything` 连全文一起搜 |
| `zotero_get_item` | 取单个条目的完整元数据 |
| `zotero_get_item_children` | 取条目的附件与笔记——定位 PDF 就靠它 |
| `zotero_get_fulltext` | 读附件已索引全文，支持 `offset` / `maxChars` 分段 |
| `zotero_list_collections` | 列出全部分类及其 key 与条目数 |
| `zotero_get_collection_items` | 列出某个分类下的条目 |
| `zotero_list_tags` | 列出标签及每个标签下的条目数 |
| `zotero_get_recent_items` | 最近添加的条目，倒序 |
| `zotero_get_bibtex` | 导出一个或多个 key 的 BibTeX / CSL-JSON |

另外提供两个 MCP resource：

- `zotero://library/recent-items`
- `zotero://collection/<collectionKey>`

## 命令行

| 命令 | 作用 |
|---|---|
| `node src/server.mjs` | 在 stdio 上跑 MCP 服务（客户端实际调用的就是它） |
| `node src/server.mjs --check` | 探测 Zotero 并打印报告；通=0，不通=1 |
| `node src/server.mjs --check --json` | 同样的报告，JSON 格式 |
| `node src/server.mjs --print-config` | 用本机真实路径打印 `mcpServers` JSON 块 |
| `node src/server.mjs --help` | 用法与环境变量参考 |
| `node scripts/setup.mjs` | 完整报告：探测到的路径、DSH 块、通用块 |
| `node scripts/setup.mjs --dsh` | 只输出 `cordis.patch.yml` 块 |
| `node scripts/setup.mjs --json` | 机器可读报告（写安装器时有用） |
| `node scripts/setup.mjs --out <file>` | 把 DSH 块写到文件 |
| `npm test` | 跑离线测试套件，不需要 Zotero、不需要联网 |

package.json 里也声明了 `bin`，所以
`npm install -g zotero-harness-bridge` 之后可以直接用 `zotero-harness-bridge`。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `connected NO`，错误是 `ECONNREFUSED` | Zotero 没开，或第 1 步的勾选没生效 |
| 工具 `mcp__zotero__*` 完全不出现 | patch 块不是合法 YAML，或者 DSH 没重启。看 DSH 日志里的 `mcp-client` 报错 |
| Zotero 明明在跑，却 `fetch failed` | 你把 Zotero 的 `extensions.zotero.httpServer.port` 改了；把 `ZOTERO_LOCAL_PORT` 设成一致 |
| `zotero_get_fulltext` 读不到内容 | Zotero 还没给这个 PDF 建索引；先在 Zotero 里打开一次 |
| 库很大时调用超时 | 调大 `ZOTERO_TIMEOUT_MS`，以及 DSH 条目里的 `toolCallTimeoutMs` |
| 工具返回 `isError` 而不是数据 | 这是有意设计：单个工具失败不会把 harness 一起拖垮 |

更多细节（含本地 API 与 Web API 的差异）见 [docs/limitations.md](docs/limitations.md)。

## 目录结构

```
src/server.mjs      MCP 服务本体：stdio 传输、JSON-RPC 分发、工具实现
src/config.mjs      无副作用的默认值，服务与安装脚本共用同一套
scripts/setup.mjs   按本机情况渲染客户端配置
examples/           用占位符写的客户端配置片段
docs/               限制与设计说明
test/               假 Zotero API + 离线 node:test 测试套件
```

## 开发

没有构建步骤，也不需要安装任何东西：

```bash
npm test                        # 完整测试套件，不需要 Zotero
node src/server.mjs --check     # 对着真实 Zotero 冒烟
node src/server.mjs --help      # 完整环境变量参考
node scripts/setup.mjs          # 配置生成器冒烟
```

测试会启动 `test/mock-zotero.mjs`——Zotero 本地 API 的替身——把服务指向它，
并以真实子进程、真实 stdio 传输来驱动。覆盖全部十个工具、resource 的列举与读取、
JSON-RPC 各条错误路径、全部 CLI 模式、配置默认值，以及几条卫生规则
（无运行时依赖、不提交临时文件、不含任何机器相关写死值）。

CI 在 Linux / Windows / macOS 上跑 Node 20、22、24，另外单独加一个 Node 18
的任务，保证 `engines` 里声明的下限不是空话。贡献规则见
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。
