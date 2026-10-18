/**
 * 冒烟测试：不启动 DSH，直接把插件装进一个假 ctx，验证
 *   1. 宿主入口能被加载、路由能被注册；
 *   2. 索引只收「提示词 + 每轮最终输出」，过程性消息与工具调用不进检索；
 *   3. 检索语义：中文子串、大小写不敏感、多关键词 AND、高亮区间、scope 过滤；
 *   4. HTTP 路由返回的 JSON 结构稳定；
 *   5. 会话长出新内容后能增量补进来；
 *   6. 卸载时路由与索引都被清理。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/* ── 造一份假的会话事件日志 ─────────────────────────────────────── */

const NOW = Date.UTC(2026, 9, 18, 8, 0, 0)

const EVENTS = {
  'session-a': [
    { type: 'session', version: 4, id: 'session-a', createdAt: NOW - 86_400_000, cwd: 'D:\\work\\alpha', isSeeded: false },
    { type: 'session/title', seq: 0, time: NOW - 86_400_000, data: { title: '重构登录流程' } },
    { type: 'turn/start', seq: 1, time: NOW - 86_400_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: NOW - 86_400_000,
      data: { content: [{ type: 'text', text: '帮我把登录流程重构成 魔法链接 登录，并补测试' }] },
    },
    // 过程性输出：带工具调用的助手消息，不应进索引。
    {
      type: 'assistant/message',
      seq: 3,
      time: NOW - 86_300_000,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先看看 session 表' },
            { type: 'text', text: '我先把 session 表拆出 magic_link 列' },
            { type: 'tool-call', name: 'pwsh', arguments: '{"command":"pnpm test login"}' },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 4, time: NOW - 86_200_000, data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"pnpm test login"}' } },
    {
      type: 'tool/result',
      seq: 5,
      time: NOW - 86_100_000,
      data: { message: { role: 'tool', content: [{ type: 'text', text: '测试通过：12 passed' }] }, isError: false },
    },
    // 最终输出：这一轮最后一条不带工具调用的助手消息。
    {
      type: 'assistant/message',
      seq: 6,
      time: NOW - 86_000_000,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '改完了：登录流程已换成 魔法链接，测试 12 passed' }] } },
    },
    { type: 'turn/end', seq: 7, time: NOW - 85_900_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  'session-b': [
    { type: 'session', version: 4, id: 'session-b', createdAt: NOW - 3_600_000, cwd: 'D:\\work\\beta', isSeeded: false },
    { type: 'turn/start', seq: 0, time: NOW - 3_600_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: NOW - 3_600_000,
      data: { content: [{ type: 'text', text: 'Magic Link 的邮件模板在哪？' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: NOW - 3_500_000,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '在 templates/magic-link.html' }] } },
    },
    { type: 'turn/end', seq: 3, time: NOW - 3_400_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  'session-broken': [
    { type: 'session', version: 4, id: 'session-broken', createdAt: NOW - 7_200_000, cwd: 'D:\\work\\gamma', isSeeded: false },
  ],
}

/** 只坏一个会话：readSession 抛错，其余照常。 */
const BROKEN = new Set(['session-broken'])

/* ── 假宿主 ─────────────────────────────────────────────────────── */

function createFakeHost() {
  const routes = []
  const live = new Map()

  const sessionQuery = {
    async listSessions() {
      return Object.keys(EVENTS).map((id) => ({
        header: { id, createdAt: EVENTS[id][0].createdAt, cwd: EVENTS[id][0].cwd, isSeeded: false },
        live: live.has(id),
        persisted: true,
      }))
    },
    async readSession(id) {
      if (BROKEN.has(id)) throw new Error('corrupt session log')
      return { session: { id }, inheritedEventCount: 0, events: EVENTS[id] }
    },
  }

  const ctx = {
    sessionQuery,
    sessions: { get: (id) => live.get(id) },
    effects: [],
    effect(factory, label) {
      this.effects.push({ factory, label, dispose: factory() })
    },
    get(key) {
      return key === 'sessionQuery' ? sessionQuery : undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
  }

  return { ctx, routes, live }
}

/** 造一对假 req/res，直接调用已注册的路由处理器（path 不含前缀，这里补上）。 */
function call(handler, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = { method, url: `/api/session-explorer${path}` }
    const chunks = []
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status
        Object.assign(this.headers, headers ?? {})
      },
      end(body) {
        chunks.push(body)
        try {
          resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(chunks.join('')) })
        } catch (error) {
          reject(error)
        }
      },
    }
    void handler(req, res)
  })
}

/** 等到索引至少覆盖 n 个会话（重建是后台异步的）。 */
async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for index')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/* ── 用例 ───────────────────────────────────────────────────────── */

const { ctx, routes } = createFakeHost()
apply(ctx)

assert.equal(routes.length, 1, '应当注册一条路由')
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/api/session-explorer')

const route = routes[0].handler

// 首次请求触发后台建索引；等它把三个会话都扫过。
const first = await call(route, '/state')
assert.equal(first.status, 200)
assert.equal(first.body.ok, true)

const ready = await waitFor(async () => {
  const response = await call(route, '/state')
  return response.body.index.sessions > 0 && response.body.index.building === false ? response.body : null
})
assert.ok(ready.sessions.length >= 2, '应当索引到可用会话')

// 坏会话不该让整轮失败，而是作为带 error 的行存在。
const broken = ready.sessions.find((item) => item.id === 'session-broken')
assert.ok(broken, '损坏的会话也要留一行')
assert.ok(broken.error.length > 0, '损坏的会话要带原因')

// 标题：从 session/title 事件来。
assert.equal(ready.sessions.find((item) => item.id === 'session-a').title, '重构登录流程')

/* ── 索引内容：只收提示词 + 最终输出 ────────────────────────────── */

const sessionA = ready.sessions.find((item) => item.id === 'session-a')
// 1 条提示词 + 1 条最终输出；过程性的助手消息与工具事件都不算。
assert.equal(sessionA.counts.user, 1, 'session-a 应当只有 1 条提示词')
assert.equal(sessionA.counts.assistant, 1, 'session-a 应当只有 1 条最终输出')
assert.equal(sessionA.messages, 2, 'session-a 的可检索内容只有 2 条')

// 统计里仍然保留工具调用（只用于图表）。
assert.equal(ready.stats.totals.tool, 1, '工具调用次数照旧统计')
assert.ok(ready.stats.tools.some((tool) => tool.name === 'pwsh'), '工具排行应包含 pwsh')
assert.ok(ready.stats.workspaces.some((item) => item.cwd === 'D:\\work\\alpha'))

// 时间线 14 天，且今天的柱子里有内容。
assert.equal(ready.stats.timeline.length, 14)
assert.ok(ready.stats.timeline.at(-1).user + ready.stats.timeline.at(-1).assistant > 0, '今天应当有活动')

/* ── 过程性内容不参与检索 ──────────────────────────────────────── */

// 「拆出」只出现在那条带工具调用的助手消息里。
const processOnly = await call(route, `/state?q=${encodeURIComponent('拆出')}`)
assert.equal(processOnly.body.totalHits, 0, '过程性助手消息不该被搜到')

// 工具名与工具输出也不该被搜到。
const toolWord = await call(route, '/state?q=pwsh')
assert.equal(toolWord.body.totalHits, 0, '工具调用不该进检索')
const toolOutput = await call(route, `/state?q=${encodeURIComponent('测试通过')}`)
assert.equal(toolOutput.body.totalHits, 0, '工具结果不该进检索')

/* ── 检索语义 ──────────────────────────────────────────────────── */

const zh = await call(route, `/state?q=${encodeURIComponent('魔法链接')}&scope=user`)
assert.equal(zh.body.totalHits, 1, '提示词里应当命中一次')
assert.equal(zh.body.groups[0].id, 'session-a')
const hit = zh.body.hits[0]
assert.ok(hit.excerpt.marks.length > 0, '命中片段要带高亮区间')
const highlighted = hit.excerpt.text.slice(hit.excerpt.marks[0][0], hit.excerpt.marks[0][1])
assert.equal(highlighted, '魔法链接')

// 大小写不敏感 + 多关键词 AND。
const multi = await call(route, '/state?q=magic%20link')
assert.ok(multi.body.matchedSessions >= 1, '两个关键词应同时要求命中')
for (const group of multi.body.groups) {
  const text = group.hits.map((item) => item.excerpt.text.toLowerCase()).join(' ')
  assert.ok(text.includes('magic') && text.includes('link'))
}

// 只命中一个词的会话不该出现。
const onlyMagic = await call(route, `/state?q=${encodeURIComponent('magic 不存在的词')}`)
assert.equal(onlyMagic.body.totalHits, 0)
assert.equal(onlyMagic.body.groups.length, 0)

/* ── 检索范围：只看提示词 / 只看最终输出 ───────────────────────── */

const userOnly = await call(route, '/state?q=magic&scope=user')
assert.equal(userOnly.body.scope, 'user')
assert.equal(userOnly.body.totalHits, 1, '只看提示词时应该只命中用户消息')
assert.equal(userOnly.body.hits[0].role, 'user')
assert.equal(userOnly.body.groups[0].id, 'session-b')

const assistantOnly = await call(route, '/state?q=magic&scope=assistant')
assert.equal(assistantOnly.body.scope, 'assistant')
assert.equal(assistantOnly.body.totalHits, 1, '只看最终输出时应该只命中助手消息')
assert.equal(assistantOnly.body.hits[0].role, 'assistant')
assert.equal(assistantOnly.body.groups[0].id, 'session-b')

// 「魔法链接」在提示词和最终输出里各有一条。
const zhAll = await call(route, `/state?q=${encodeURIComponent('魔法链接')}`)
assert.equal(zhAll.body.totalHits, 2, '提示词与最终输出各一条')
const zhAssistant = await call(route, `/state?q=${encodeURIComponent('魔法链接')}&scope=assistant`)
assert.equal(zhAssistant.body.totalHits, 1)
assert.equal(zhAssistant.body.hits[0].role, 'assistant')

// 认不出来的 scope 退回 all，不报错。
const bogus = await call(route, '/state?q=magic&scope=whatever')
assert.equal(bogus.body.scope, 'all')
assert.ok(bogus.body.totalHits >= 1)

/* ── 详情接口 ──────────────────────────────────────────────────── */

const detail = await call(route, '/session?id=session-a')
assert.equal(detail.status, 200)
assert.equal(detail.body.events.length, 2, '详情只返回可读的提示词与最终输出')
assert.ok(detail.body.events.some((event) => event.role === 'user'))
assert.ok(detail.body.events.some((event) => event.role === 'assistant'))

/* ── 路由边界 ──────────────────────────────────────────────────── */

assert.equal((await call(route, '/nope')).status, 404)
assert.equal((await call(route, '/session')).status, 400)
assert.equal((await call(route, '/health')).body.ok, true)

/* ── 增量：会话长出新内容后能搜到 ─────────────────────────────── */

EVENTS['session-b'].push(
  { type: 'turn/start', seq: 4, time: NOW + 500, data: { turn: 2 } },
  {
    type: 'user/message',
    seq: 5,
    time: NOW + 1000,
    data: { content: [{ type: 'text', text: '顺便检查一下 邮件 发送失败的重试' }] },
  },
  { type: 'turn/end', seq: 6, time: NOW + 1500, data: { turn: 2, reason: { kind: 'completed' } } },
)
await call(route, '/refresh', 'POST')
const grown = await waitFor(async () => {
  const response = await call(route, `/state?q=${encodeURIComponent('重试')}`)
  return response.body.totalHits > 0 ? response.body : null
})
assert.equal(grown.groups[0].id, 'session-b')

/* ── 卸载：路由与索引都清掉 ───────────────────────────────────── */

for (const item of ctx.effects.reverse()) item.dispose()
assert.equal(routes.length, 0, '卸载后路由应被摘掉')

console.log('smoke: all checks passed')
