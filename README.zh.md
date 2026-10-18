# dsh-session-explorer · 会话检索

> 仓库名是 `dsh-plugin-session-search`，里面装的是 DSH bundle **`dsh-session-explorer`**——插件管理器按 `package.json` 里的包名安装，`dsh.profile.bundles` 里列的也是包名。

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的插件：把**这台机器上所有对话记录**变成一个可检索、会实时更新的面板。

按关键词搜索全部历史（中文子串也能搜），命中的每个词都高亮；同时用图表看清自己的工作在往哪儿走——近 14 天活动柱状图、工具调用排行、工作区分布。全部在本机计算，不外传任何数据。

> English: [README.md](README.md)

## 能做什么

- **全库检索**：空格分隔多个关键词＝同时命中（AND）；`"引号"` 包住一个短语。大小写不敏感、按原始子串匹配，所以 `魔法链接`、`pnpm test` 这种夹在句子中间的内容也能搜到——不依赖分词，也不需要 FTS 后端。
- **只收提示词和最终输出**：索引里刻意不收过程——中间那些带工具调用的助手消息、工具调用、工具结果、todo、压缩摘要都不可检索。顶部分段开关还能再收窄到「提示词」（你发出去的消息）或「最终输出」（每一轮里最后那段纯文字回答）。
- **命中高亮**：每条结果都带精确的 `[start, end)` 区间，前端直接画 `<mark>`，不用再扫一遍文本。
- **可视化**：会话数 / 可检索内容 / 工具调用 / 工作区四张卡片，近 14 天堆叠柱状图，工具调用 Top 10，工作区分布。工具活动只进图表计数，绝不进检索索引。
- **实时**：面板轮询宿主侧的派生索引；只有当会话日志长度（活跃会话）或持久化 revision（冷会话）变化时才重读那个会话。你正在聊的这一段，几秒内就能被搜到。
- **下钻**：点开任意命中，抽屉里能读这一串「提问 + 最终回答」，再一键「打开会话」跳回 DSH 里的那个会话。

## 安装

这就是一个标准的 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch`。

**用插件管理器**（推荐）：

```text
plugin_manager  action: install_bundle  target: <本仓库的绝对路径>
```

或者直接从 GitHub 装：

```text
dsh plugin add github:fuguoqiang-bnu/dsh-plugin-session-search
```

**手动装**：把本目录拷到 `$DSH_PROFILE_DIR/node_modules/dsh-session-explorer`，在 profile 的 `package.json` 里把 `"dsh-session-explorer"` 加进 `dsh.profile.bundles`，重启 DSH。bundle 的 `cordis.patch.yml` 会把插件行插进去。

装好后点左侧栏的**会话检索**（放大镜＋柱状图图标）。

## 实现要点

```text
┌──────────────── 浏览器（lib/client.js）────────────────┐
│ main 面板 + sidebar.panellist 图标                      │
│ 轮询 GET /api/session-explorer/state?q=&scope=…         │
└──────────────────────────┬──────────────────────────────┘
                           │ 同源 fetch（JSON）
┌──────────────────────────┴──────────────────────────────┐
│ 宿主（lib/index.js）                                     │
│  • ctx.sessionQuery.listSessions() / readSession()       │
│  • 只留提示词 + 每轮的最终回答                            │
│  • 增量内存索引 + 字面量关键词检索                        │
│  • ctx.webServer.register({ kind: 'prefix', … })         │
└──────────────────────────────────────────────────────────┘
```

### 索引里到底有什么

每个会话的日志只走一遍：

| 事件 | 进不进索引 |
|---|---|
| `user/message` | 进 —— 作为**提示词** |
| `assistant/message` | 只有**一轮里最后那条纯文字消息**进；带 `tool-call` 块的助手消息属于过程，丢掉 |
| `tool/call`、`tool/result` | 不进 —— 只计入工具排行 |
| `todo/write`、`compaction/summary`、`turn/end` | 不进 |

所以一轮「思考 → 调五次工具 → 最后回答」只贡献一条可检索的输出。搜 `pwsh` 命中的是**聊到** pwsh 的对话，而不是那次工具调用本身。

两个刻意的取舍：

1. **只读接口，不用 FTS。** `dsh-base` 把 `dsh-session-query-sqlite` 配成 `openAt: never`，默认没有全文检索后端；本插件只用任何部署都有的精确读取（`listSessions` / `readSession`）自建派生索引。对中文来说这点尤其重要：`unicode61` 分词器无法命中「魔法链接」内部的子串，而关键词框本来就该按子串找。
2. **走 HTTP 路由，不走生成的 RPC。** DSH 的 Typert Remote 通道需要生成好的描述符与编解码器；纯 JS 插件更稳的做法是在 `ctx.webServer` 上注册一条**同源**路由（同一个端口、不另开监听），浏览器直接 `fetch`。于是本包零依赖，装到哪儿都能跑。

### HTTP 接口

| 方法 | 路径 | 含义 |
|---|---|---|
| `GET` | `/api/session-explorer/state?q=&scope=` | 索引状态、统计、会话摘要，以及 `q` 的命中；`scope` 取 `all`（默认）/ `user`（提示词）/ `assistant`（最终输出） |
| `GET` | `/api/session-explorer/session?id=` | 单个会话的可读线索：它的提示词与最终输出（最近 200 条文档） |
| `POST` | `/api/session-explorer/refresh` | 强制全量重建索引 |
| `GET` | `/api/session-explorer/health` | 存活探针 |

响应统一 JSON，带 `cache-control: no-store`。

## 隐私

- 数据只来自本机 DSH 会话库，只存在宿主进程内存里。
- 不联网、不上报、不往会话库以外写任何文件。
- 路由挂在给你提供 Web 界面的同一个服务器上：界面能访问到的地方它才在。

## 兼容性

- 依赖 `webServer` 服务（Web 界面部署）。没有它的 headless/CLI profile 不会加载本插件。
- 依赖 `ctx.sessionQuery`（`dsh-base` 自带）。若某个部署把它去掉了，面板会显示原因而不是崩掉。
- Node `^22.19.0 || >=24.0.0`，与 DSH 自身 engines 一致。
- 已在 DSH `0.2.1-rc.2` 的 desktop profile 上验证。

## 开发

```bash
node test/smoke.mjs
```

冒烟测试把插件装进一个假 Cordis 上下文，直接驱动真实的 HTTP 处理器，覆盖：文本抽取、检索语义（中文子串 / 大小写 / 多词 AND / 高亮区间）、详情接口、增量重建、以及卸载清理。

没有构建步骤：`lib/index.js` 与 `lib/client.js` 分别是纯 ESM 和浏览器模块 JS。

## 许可

MIT，见 [LICENSE](LICENSE)。
