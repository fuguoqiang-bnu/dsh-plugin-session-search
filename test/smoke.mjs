/**
 * 冒烟测试：不启动 DSH，直接把插件装进一个假 ctx，验证
 *   1. 宿主入口能被加载、路由能被注册；
 *   2. 从会话事件抽文本、统计、检索（含中文子串、多关键词 AND）都对；
 *   3. HTTP 路由返回的 JSON 结构稳定；
 *   4. 卸载时路由与索引都被清理。
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
    {
      type: 'user/message',
      seq: 1,
      time: NOW - 86_400_000,
      data: { content: [{ type: 'text', text: '帮我把登录流程重构成 魔法链接 登录，并补测试' }] },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: NOW - 86_300_000,
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }, { type: 'text', text: '先把 session 表拆出 magic_link 列' }] } },
    },
    {
      type: 'tool/call',
      seq: 3,
      time: NOW - 86_200_000,
      data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"pnpm test login"}' },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: NOW - 86_100_000,
      data: { message: { role: 'tool', content: [{ type: 'text', text: '测试通过：12 passed' }] }, isError: false },
    },
  ],
  'session-b': [
    { type: 'session', version: 4, id: 'session-b', createdAt: NOW - 3_600_000, cwd: 'D:\\work\\beta', isSeeded: false },
    {
      type: 'user/message',
      seq: 0,
      time: NOW - 3_600_000,
      data: { content: [{ type: 'text', text: 'Magic Link 的邮件模板在哪？' }] },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: NOW - 3_500_000,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '在 templates/magic-link.html' }] } },
    },
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

// 统计：时间线 14 天、工具排行里有 pwsh。
assert.equal(ready.stats.timeline.length, 14)
assert.ok(ready.stats.tools.some((tool) => tool.name === 'pwsh'), '工具排行应包含 pwsh')
assert.ok(ready.stats.workspaces.some((item) => item.cwd === 'D:\\work\\alpha'))

// 中文子串检索。
const zh = await call(route, `/state?q=${encodeURIComponent('魔法链接')}`)
assert.equal(zh.body.totalHits, 1, '中文子串应当命中一次')
assert.equal(zh.body.groups[0].id, 'session-a')
const hit = zh.body.hits[0]
assert.ok(hit.excerpt.marks.length > 0, '命中片段要带高亮区间')
const highlighted = hit.excerpt.text.slice(hit.excerpt.marks[0][0], hit.excerpt.marks[0][1])
assert.equal(highlighted, '魔法链接')

// 大小写不敏感 + 多关键词 AND（magic link 同时命中 session-a 与 session-b）。
const multi = await call(route, '/state?q=magic%20link')
assert.ok(multi.body.matchedSessions >= 2, '两个关键词应同时要求命中')
for (const group of multi.body.groups) {
  const text = group.hits.map((item) => item.excerpt.text.toLowerCase()).join(' ')
  assert.ok(text.includes('magic') && text.includes('link'))
}

// 只命中一个词的会话不该出现。
const onlyMagic = await call(route, `/state?q=${encodeURIComponent('magic 不存在的词')}`)
assert.equal(onlyMagic.body.totalHits, 0)
assert.equal(onlyMagic.body.groups.length, 0)

// 详情接口。
const detail = await call(route, '/session?id=session-a')
assert.equal(detail.status, 200)
assert.ok(detail.body.events.length >= 3)
assert.ok(detail.body.events.some((event) => event.type === 'tool/call' && event.text.includes('pnpm test login')))

// 未知路由 / 缺 id。
assert.equal((await call(route, '/nope')).status, 404)
assert.equal((await call(route, '/session')).status, 400)
assert.equal((await call(route, '/health')).body.ok, true)

// 真实时：一个会话从日志里长出新消息后，再查能看到。
EVENTS['session-b'].push({
  type: 'user/message',
  seq: 2,
  time: NOW + 1000,
  data: { content: [{ type: 'text', text: '顺便检查一下 邮件 发送失败的重试' }] },
})
await call(route, '/refresh', 'POST')
const grown = await waitFor(async () => {
  const response = await call(route, `/state?q=${encodeURIComponent('重试')}`)
  return response.body.totalHits > 0 ? response.body : null
})
assert.equal(grown.groups[0].id, 'session-b')

// 卸载：路由与索引都清掉。
for (const item of ctx.effects.reverse()) item.dispose()
assert.equal(routes.length, 0, '卸载后路由应被摘掉')

console.log('smoke: 12 checks passed')
