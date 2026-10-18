/**
 * dsh-session-explorer — 宿主侧（Node）。
 *
 * 职责只有三件事：
 *   1. 通过 `ctx.sessionQuery`（DSH 自带的会话查询服务）把本机所有会话的
 *      语义文本抽出来，做成一个增量维护的内存倒排快照；
 *   2. 提供关键词检索（大小写不敏感、中文子串也能命中、多关键词 AND）；
 *   3. 用 `ctx.webServer.register()` 把这套能力挂到同源 HTTP 路由上，
 *      让浏览器侧的面板可以 fetch，而不必依赖 Typert RPC 代码生成。
 *
 * 为什么不用 `ctx.sessionQuery.searchSessions()`：那条路要求组合里挂 FTS 后端
 * （`dsh-session-query-sqlite`），而 `dsh-base` 默认把它配成 `openAt: never`。
 * 本插件改用它一定提供的精确读取接口（listSessions / readSession），自己维护
 * 一份派生索引：默认配置即可工作，中文子串也能搜，符合「关键词检索」的预期。
 *
 * 本文件刻意不 import 任何包：插件被装进 profile 后，只有 dsh 自身安装里的包
 * 才保证可解析，零依赖让安装最稳。
 */

/** 面板 http 路由前缀；比连接层注册的 `/api` 更长，按最长前缀优先命中。 */
const ROUTE_PATH = '/api/session-explorer'

/** 两次自动重建之间的最小间隔，避免面板轮询把 CPU 打满。 */
const MIN_REFRESH_MS = 1500
/** 最多索引多少个会话（按创建时间倒序）。 */
const MAX_SESSIONS = 400
/** 单次检索最多返回多少条命中。 */
const MAX_HITS = 120
/** 单次检索最多返回多少个会话分组。 */
const MAX_GROUPS = 24
/** 每个会话分组里最多带几条摘要。 */
const MAX_GROUP_HITS = 6
/** 单条事件最多保留多少字符，防止一条超长工具输出撑爆内存。 */
const MAX_DOC_CHARS = 4000
/** 单个会话最多保留多少字符。 */
const MAX_SESSION_CHARS = 320000
/** 每处理这么多个会话就让出一次事件循环，保证界面不卡。 */
const YIELD_EVERY = 2

/** 插件名，写进 Loader 日志用。 */
export const name = 'session-explorer'

/** webServer 是必需的：没有它就没有给浏览器面用的数据通道。 */
export const inject = ['webServer']

/**
 * 插件入口。
 * @param {object} ctx Cordis 宿主上下文。
 */
export function apply(ctx) {
  const explorer = createExplorer(ctx)

  // 路由注册是「效果」：插件卸载时自动摘掉。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: (req, res) => handleRequest(explorer, req, res),
      }),
    'session-explorer: http routes',
  )

  ctx.effect(() => () => explorer.dispose(), 'session-explorer: index')
}

/* ────────────────────────────── HTTP 层 ────────────────────────────── */

/**
 * 处理一次面板请求。
 * @param {ReturnType<typeof createExplorer>} explorer 索引实例。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {import('node:http').ServerResponse} res 响应。
 */
async function handleRequest(explorer, req, res) {
  /**
   * 统一的 JSON 响应。
   * @param {number} status HTTP 状态码。
   * @param {unknown} payload 响应体。
   */
  const send = (status, payload) => {
    let body
    try {
      body = JSON.stringify(payload)
    } catch {
      body = JSON.stringify({ ok: false, error: 'response is not serializable' })
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  try {
    // 放行规则：本机进程直接放行（它们本来就能读 ~/.dsh 下的会话库）；
    // 来自其他机器的请求必须过连接层的 Host/Origin 与浏览器凭据检查。
    const rejection = explorer.admit(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    const url = new URL(String(req.url ?? '/'), 'http://session-explorer.local')
    const path = url.pathname.slice(ROUTE_PATH.length) || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && (path === '/' || path === '/state')) {
      // 先按当前索引作答，再踢一次增量重建：这样响应里的 building 反映的是
      // 「此刻有没有后台任务」，而不是本次请求刚排进去的那个。
      const payload = explorer.snapshot(
        url.searchParams.get('q') ?? '',
        url.searchParams.get('scope') ?? 'all',
      )
      explorer.kick()
      return send(200, payload)
    }

    if (method === 'GET' && path === '/session') {
      const id = url.searchParams.get('id') ?? ''
      if (id === '') return send(400, { ok: false, error: 'missing id' })
      const detail = await explorer.detail(id)
      return send(detail.ok ? 200 : 404, detail)
    }

    if (method === 'POST' && path === '/refresh') {
      explorer.kick(true)
      return send(200, { ok: true, queued: true })
    }

    if (method === 'GET' && path === '/health') {
      return send(200, { ok: true, route: ROUTE_PATH })
    }

    return send(404, { ok: false, error: `unknown route: ${path}` })
  } catch (error) {
    send(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/* ────────────────────────────── 索引层 ────────────────────────────── */

/**
 * 建一个索引实例（闭包持有全部状态，便于单测直接驱动）。
 * @param {object} ctx Cordis 宿主上下文。
 */
function createExplorer(ctx) {
  /** @type {Map<string, SessionEntry>} 会话 id → 索引条目。 */
  const entries = new Map()

  let building = null
  let lastBuildAt = 0
  let lastError = ''
  let scanned = 0
  let disposed = false
  let statsCache = null

  /**
   * 取一个可选服务。
   *
   * Cordis 里直接访问 `ctx.xxx` 会要求插件在 `inject` 里声明过；本插件的三个
   * 依赖（sessionQuery / sessions / sessionPersistence）都只想「有就用、没有降级」，
   * 所以统一走 `ctx.get()`，并且兜住早期/残缺上下文里的异常。
   * @param {object} context 上下文。
   * @param {string} key 服务名。
   * @returns {any} 服务实例或 undefined。
   */
  function service(context, key) {
    try {
      if (typeof context.get === 'function') {
        const found = context.get(key)
        if (found !== undefined && found !== null) return found
      }
    } catch {
      /* 没有该服务 */
    }
    try {
      const direct = context[key]
      if (direct !== undefined && direct !== null) return direct
    } catch {
      /* 未声明 inject，按「没有」处理 */
    }
    return undefined
  }

  /** 取 DSH 的会话查询服务；没挂就返回 undefined，面板会显示原因而不是崩掉。 */
  function query() {
    return service(ctx, 'sessionQuery')
  }

  /** 取活跃会话表（可选服务）。 */
  function liveSessions() {
    return service(ctx, 'sessions')
  }

  /** 取持久化服务（可选），用来拿便宜的 revision 做变更判定。 */
  function persistence() {
    return service(ctx, 'sessionPersistence')
  }

  /**
   * 安排一次增量重建。已有任务在跑时不重复排。
   * @param {boolean} [force] 忽略最小间隔与缓存键，强制全量重读。
   */
  function kick(force = false) {
    if (disposed) return
    if (building !== null) return
    const now = Date.now()
    if (!force && now - lastBuildAt < MIN_REFRESH_MS) return
    lastBuildAt = now
    building = build(force)
      .catch((error) => {
        lastError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        building = null
      })
  }

  /**
   * 真正重建：先列会话，再按「便宜的变化信号」决定哪些会话需要重读。
   * @param {boolean} force 是否全量重读。
   */
  async function build(force) {
    const sq = query()
    if (sq === undefined) {
      lastError = '本部署没有挂 ctx.sessionQuery，无法读取会话历史'
      return
    }

    const records = await sq.listSessions()
    const revisions = await readRevisions()

    // 活跃优先：用户正在聊的会话最该立刻可搜。
    const ordered = records
      .map((record) => ({ record, live: safeLive(record.header.id) }))
      .sort((a, b) => {
        if ((a.live !== undefined) !== (b.live !== undefined)) return a.live !== undefined ? -1 : 1
        return b.record.header.createdAt - a.record.header.createdAt
      })
      .slice(0, MAX_SESSIONS)

    scanned = ordered.length
    let changed = 0

    for (let index = 0; index < ordered.length; index += 1) {
      if (disposed) return
      const { record, live } = ordered[index]
      const id = record.header.id

      // 变化信号：活跃会话看日志长度，冷会话看持久化的 revision。
      const key =
        live !== undefined
          ? `live:${live.seq}`
          : `persisted:${revisions.get(id) ?? record.header.createdAt}`

      const existing = entries.get(id)
      if (!force && existing !== undefined && existing.key === key) continue

      try {
        const events = live !== undefined ? live.snapshotEvents() : await coldEvents(sq, id)
        entries.set(id, buildEntry(record.header, id, events, key, record))
        changed += 1
      } catch (error) {
        // 损坏或迁移中的会话不该拖垮整轮：记下原因、保留旧条目。
        const reason = error instanceof Error ? error.message : String(error)
        lastError = `${id}: ${reason}`
        if (existing === undefined) {
          entries.set(id, emptyEntry(record.header, id, key, reason))
        }
      }

      if (index % YIELD_EVERY === 0) await yieldLoop()
    }

    // 会话被删掉（或超出上限）时同步清理，避免面板显示幽灵记录。
    const alive = new Set(ordered.map((item) => item.record.header.id))
    for (const id of [...entries.keys()]) if (!alive.has(id)) entries.delete(id)

    if (changed > 0 || statsCache === null) statsCache = computeStats()
    lastError = lastError === '' ? '' : lastError
  }

  /**
   * 读冷会话的完整事件日志。
   * @param {object} sq sessionQuery 服务。
   * @param {string} id 会话 id。
   * @returns {Promise<readonly object[]>} 事件数组。
   */
  async function coldEvents(sq, id) {
    const snapshot = await sq.readSession(id)
    return snapshot.events ?? snapshot.session?.events ?? []
  }

  /** 列持久化快照的 revision；不可用就返回空表（下次全读，仍然正确）。 */
  async function readRevisions() {
    const store = persistence()
    if (store === undefined || typeof store.list !== 'function') return new Map()
    try {
      const list = await store.list()
      const map = new Map()
      for (const item of list ?? []) {
        if (item?.header?.id !== undefined && typeof item.revision === 'string') {
          map.set(item.header.id, item.revision)
        }
      }
      return map
    } catch {
      return new Map()
    }
  }

  /** 取活跃会话对象；`get()` 可能因会话刚被销毁而抛，兜住。 */
  function safeLive(id) {
    const store = liveSessions()
    if (store === undefined || typeof store.get !== 'function') return undefined
    try {
      return store.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * 给面板的一份快照：统计 + 会话摘要 +（可选）检索命中。
   * @param {string} rawQuery 用户输入。
   * @param {string} rawScope 检索范围：all / user / assistant / tool。
   * @returns {object} 可直接 JSON 化的响应体。
   */
  function snapshot(rawQuery, rawScope) {
    const queryText = String(rawQuery ?? '').trim()
    const scope = normalizeScope(rawScope)
    const sessions = [...entries.values()]
      .map(summarize)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)

    const payload = {
      ok: true,
      generatedAt: Date.now(),
      route: ROUTE_PATH,
      index: {
        sessions: sessions.length,
        scanned,
        messages: sessions.reduce((sum, item) => sum + item.messages, 0),
        characters: sessions.reduce((sum, item) => sum + item.characters, 0),
        building: building !== null,
        ready: statsCache !== null,
        error: lastError,
      },
      stats: statsCache ?? emptyStats(),
      sessions,
      scope,
    }

    if (queryText === '') return payload

    const result = search(queryText, scope)
    return {
      ...payload,
      query: queryText,
      scope,
      hits: result.hits,
      groups: result.groups,
      totalHits: result.totalHits,
      matchedSessions: result.matchedSessions,
    }
  }

  /**
   * 取单个会话的完整可读文本（面板的详情抽屉用）。
   * @param {string} id 会话 id。
   */
  async function detail(id) {
    let entry = entries.get(id)
    if (entry === undefined) {
      const sq = query()
      if (sq === undefined) return { ok: false, error: 'sessionQuery unavailable' }
      try {
        const events = await coldEvents(sq, id)
        const header = { id, createdAt: 0, isSeeded: false }
        entry = buildEntry(header, id, events, `detail:${Date.now()}`, { header })
        entries.set(id, entry)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      ok: true,
      session: summarize(entry),
      events: entry.docs.slice(-200).map((doc) => ({
        seq: doc.seq,
        type: doc.type,
        role: doc.role,
        time: doc.time,
        text: doc.text,
      })),
    }
  }

  /**
   * 关键词检索：多关键词 AND，大小写不敏感，中文按子串。
   * @param {string} queryText 用户输入。
   * @param {'all' | 'user' | 'assistant' | 'tool'} scope 只在这些角色里找。
   */
  function search(queryText, scope) {
    const terms = splitTerms(queryText)
    const hits = []
    const groups = []
    let totalHits = 0

    if (terms.length === 0) return { hits, groups, totalHits: 0, matchedSessions: 0 }

    for (const entry of entries.values()) {
      const matched = []
      for (const doc of entry.docs) {
        if (!inScope(doc.role, scope)) continue
        const found = matchTerms(doc.text, terms)
        if (found === null) continue
        totalHits += 1
        matched.push({
          sessionId: entry.id,
          seq: doc.seq,
          type: doc.type,
          role: doc.role,
          time: doc.time,
          matches: found.count,
          excerpt: buildExcerpt(doc.text, found.first, terms),
        })
      }
      if (matched.length === 0) continue
      matched.sort((a, b) => b.matches - a.matches || a.seq - b.seq)
      const summary = summarize(entry)
      groups.push({ ...summary, hitCount: matched.length, hits: matched.slice(0, MAX_GROUP_HITS) })
      for (const hit of matched.slice(0, MAX_GROUP_HITS)) {
        if (hits.length >= MAX_HITS) break
        hits.push(hit)
      }
    }

    groups.sort((a, b) => b.hitCount - a.hitCount || b.updatedAt - a.updatedAt)
    hits.sort((a, b) => b.matches - a.matches || b.time - a.time)
    return {
      hits,
      groups: groups.slice(0, MAX_GROUPS),
      totalHits,
      matchedSessions: groups.length,
    }
  }

  /** 汇总一组会话的统计量，缓存到下次重建。 */
  function computeStats() {
    const days = new Map()
    const tools = new Map()
    const workspaces = new Map()
    let user = 0
    let assistant = 0
    let tool = 0
    let characters = 0
    let live = 0

    for (const entry of entries.values()) {
      if (entry.live) live += 1
      const workspaceKey = entry.header.cwd ?? '(未记录工作区)'
      const bucket = workspaces.get(workspaceKey) ?? { cwd: workspaceKey, sessions: 0, messages: 0 }
      bucket.sessions += 1
      bucket.messages += entry.docs.length
      workspaces.set(workspaceKey, bucket)

      user += entry.counts.user
      assistant += entry.counts.assistant
      characters += entry.characters

      for (const [name, calls] of Object.entries(entry.tools ?? {})) {
        tools.set(name, (tools.get(name) ?? 0) + calls)
        tool += calls
      }

      for (const [day, cell] of Object.entries(entry.days ?? {})) {
        const bucketDay = days.get(day) ?? { date: day, user: 0, assistant: 0, tool: 0, other: 0 }
        bucketDay.user += cell.user
        bucketDay.assistant += cell.assistant
        bucketDay.tool += cell.tool
        bucketDay.other += cell.other
        days.set(day, bucketDay)
      }
    }

    const now = Date.now()
    const timeline = []
    for (let offset = 13; offset >= 0; offset -= 1) {
      const day = dayKey(now - offset * 86400000)
      timeline.push(days.get(day) ?? { date: day, user: 0, assistant: 0, tool: 0, other: 0 })
    }

    return {
      totals: { sessions: entries.size, live, user, assistant, tool, characters },
      timeline,
      tools: topEntries(tools, 10).map(([toolName, calls]) => ({ name: toolName, calls })),
      workspaces: [...workspaces.values()].sort((a, b) => b.messages - a.messages).slice(0, 8),
    }
  }

  /** 释放：标记退出并清空索引，避免卸载后还被轮询写入。 */
  function dispose() {
    disposed = true
    entries.clear()
  }

  /**
   * 决定一个请求能不能进来。
   *
   * - 本机（回环地址）放行：本机进程本来就能直接读 `~/.dsh/sessions` 下的文件，
   *   在这里再做一次"鉴权"只会让自检脚本更难用，挡不住真正的本机读者。
   * - 其他来源：交给连接层判断（Host/Origin 校验 + 浏览器凭据）。没有连接层就直接拒绝，
   *   因为那时说明这个部署根本没启用鉴权，把会话正文暴露到网络上更危险。
   *
   * @param {import('node:http').IncomingMessage} req 请求。
   * @returns {401 | 403 | undefined} 拒绝状态码，放行时为 undefined。
   */
  function admit(req) {
    const address = String(req.socket?.remoteAddress ?? '')
    const loopback =
      address.startsWith('127.') ||
      address === '::1' ||
      address === '::ffff:127.0.0.1' ||
      address === ''

    if (loopback) return undefined

    const connection = service(ctx, 'connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        return connection.requestRejection({ headers: req.headers ?? {} })
      } catch {
        return 403
      }
    }
    return 403
  }

  return { kick, snapshot, detail, dispose, search, admit }
}

/* ────────────────────────────── 事件抽取 ────────────────────────────── */

/**
 * 把一个会话的事件日志压成可检索的文档数组。
 *
 * **只收两类内容**：用户自己发出的提示词，以及每一轮里助手最后那段
 * 不带工具调用的「最终输出」。中间过程（带工具调用的助手消息、工具调用本身、
 * 工具结果、todo、压缩摘要）都不进索引——它们是过程，不是要检索的结论。
 *
 * @param {object} header 会话头。
 * @param {string} id 会话 id。
 * @param {readonly object[]} events 事件日志。
 * @param {string} key 变化信号。
 * @param {object} record listSessions 返回的记录（拿 live/persisted 标记）。
 * @returns {SessionEntry} 索引条目。
 */
function buildEntry(header, id, events, key, record) {
  const docs = []
  /** @type {Record<string, {user: number, assistant: number, tool: number, other: number}>} */
  const days = Object.create(null)
  /** @type {Record<string, number>} */
  const tools = Object.create(null)
  const counts = { user: 0, assistant: 0 }
  let title = ''
  let characters = 0
  let updatedAt = header.createdAt ?? 0
  const live = record?.live === true
  /** 当前这一轮里出现的助手消息候选（只有最后一个纯文字才是最终输出）。 */
  let candidates = []

  const markDay = (time, kind) => {
    const day = dayKey(time)
    if (day === null) return
    const cell = days[day] ?? (days[day] = { user: 0, assistant: 0, tool: 0, other: 0 })
    cell[kind] += 1
  }

  const clip = (text) => (text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}…` : text)

  /** 收尾一轮：从后往前找第一条不带工具调用的助手消息，它就是最终输出。 */
  const flushTurn = () => {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]
      if (candidate.hasToolCall) continue
      if (characters < MAX_SESSION_CHARS) {
        docs.push(candidate.doc)
        counts.assistant += 1
        characters += candidate.doc.text.length
      }
      break
    }
    candidates = []
  }

  for (const event of events ?? []) {
    if (event === null || typeof event !== 'object') continue
    const type = typeof event.type === 'string' ? event.type : ''
    const time = typeof event.time === 'number' ? event.time : 0
    if (time > updatedAt) updatedAt = time

    switch (type) {
      case 'session/title': {
        const next = event.data?.title
        if (typeof next === 'string' && next.trim() !== '') title = next.trim()
        break
      }
      case 'session': {
        if (typeof event.cwd === 'string' && header.cwd === undefined) {
          header = { ...header, cwd: event.cwd }
        }
        break
      }
      case 'turn/start':
      case 'turn/end': {
        flushTurn()
        break
      }
      case 'user/message': {
        const text = extractText(event)
        if (text === '' || characters >= MAX_SESSION_CHARS) break
        const doc = {
          seq: Number.isFinite(event.seq) ? event.seq : docs.length,
          type,
          role: 'user',
          time,
          text: clip(text),
        }
        docs.push(doc)
        counts.user += 1
        characters += doc.text.length
        markDay(time, 'user')
        break
      }
      case 'assistant/message': {
        markDay(time, 'assistant')
        const text = extractText(event)
        if (text === '') break
        const blocks = event.data?.message?.content
        const hasToolCall =
          Array.isArray(blocks) && blocks.some((block) => block?.type === 'tool-call')
        candidates.push({
          hasToolCall,
          doc: {
            seq: Number.isFinite(event.seq) ? event.seq : docs.length,
            type,
            role: 'assistant',
            time,
            text: clip(text),
          },
        })
        break
      }
      case 'tool/call': {
        const name = typeof event.data?.name === 'string' ? event.data.name : ''
        if (name !== '') tools[name] = (tools[name] ?? 0) + 1
        markDay(time, 'tool')
        break
      }
      case 'tool/result': {
        markDay(time, 'tool')
        break
      }
      case 'todo/write':
      case 'compaction/summary': {
        markDay(time, 'other')
        break
      }
      default:
        break
    }
  }
  flushTurn()

  const fallbackTitle = firstLine(docs.find((doc) => doc.role === 'user')?.text)
  return {
    id,
    key,
    live,
    header,
    title: title !== '' ? title : fallbackTitle !== '' ? fallbackTitle : id,
    docs,
    days,
    tools,
    characters,
    updatedAt: updatedAt === 0 ? Date.now() : updatedAt,
    counts,
    error: '',
  }
}

/**
 * 占位条目：会话读不出来时仍然在面板里占一行，并显示原因。
 * @param {object} header 会话头。
 * @param {string} id 会话 id。
 * @param {string} key 变化信号。
 * @param {string} reason 失败原因。
 * @returns {SessionEntry} 索引条目。
 */
function emptyEntry(header, id, key, reason) {
  return {
    id,
    key,
    live: false,
    header,
    title: id,
    docs: [],
    days: Object.create(null),
    tools: Object.create(null),
    characters: 0,
    updatedAt: header.createdAt ?? Date.now(),
    counts: { user: 0, assistant: 0 },
    error: reason,
  }
}

/**
 * 从一条事件里抽出可检索的语义文本。
 *
 * 只有两条来源：用户消息的正文，助手消息的正文（`reasoning` 思考块与
 * `tool-call` 工具调用块都跳过）。工具调用、工具结果、todo、压缩摘要这些
 * 过程性事件不产生文档——它们只进图表计数，不进检索。
 *
 * @param {object} event 会话事件。
 * @returns {string} 换行连接后的文本；不可检索返回空串。
 */
function extractText(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message':
      return joinText(contentText(data.content))
    case 'assistant/message':
      return joinText(contentText(data.message?.content))
    default:
      return ''
  }
}

/** 内容块数组 → 文本片段数组（只取 text 块）。 */
function contentText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? [content] : []
  return content.flatMap((block) => {
    if (block === null || typeof block !== 'object') return []
    return block.type === 'text' ? [block.text] : []
  })
}

/** 去空、trim、换行连接。 */
function joinText(parts) {
  return parts
    .filter((part) => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n')
}

/* ────────────────────────────── 检索辅助 ────────────────────────────── */

/**
 * 拆关键词：空白分隔，支持用双引号包住一个短语。
 * @param {string} raw 原始输入。
 * @returns {string[]} 关键词列表。
 */
function splitTerms(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  const terms = []
  const pattern = /"([^"]+)"|(\S+)/gu
  let match
  while ((match = pattern.exec(text)) !== null) {
    const term = (match[1] ?? match[2] ?? '').trim()
    if (term !== '') terms.push(term)
  }
  return terms.slice(0, 8)
}

/**
 * 判断一段文本是否命中全部关键词。
 * @param {string} text 文本。
 * @param {string[]} terms 关键词。
 * @returns {{count: number, first: number} | null} 命中次数与首个命中位置。
 */
function matchTerms(text, terms) {
  if (text === '') return null
  const lowered = text.toLowerCase()
  let count = 0
  let first = -1
  for (const term of terms) {
    const needle = term.toLowerCase()
    let index = lowered.indexOf(needle)
    if (index === -1) return null
    if (first === -1 || index < first) first = index
    while (index !== -1) {
      count += 1
      index = lowered.indexOf(needle, index + needle.length)
    }
  }
  return { count, first: first === -1 ? 0 : first }
}

/**
 * 截一段带高亮位置的摘要。
 * @param {string} text 原文。
 * @param {number} index 首个命中位置。
 * @param {string[]} terms 关键词。
 * @returns {{text: string, marks: number[][]}} 摘要与相对位置的高亮区间。
 */
function buildExcerpt(text, index, terms) {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length === 0) return { text: '', marks: [] }

  // 原文里的换行被压平成空格后，位置会有偏移：用关键词重新定位。
  let anchor = 0
  const lowered = flat.toLowerCase()
  for (const term of terms) {
    const at = lowered.indexOf(term.toLowerCase())
    if (at !== -1) {
      anchor = at
      break
    }
  }
  const radius = 90
  const start = Math.max(0, anchor - Math.floor(radius / 2))
  const end = Math.min(flat.length, start + radius * 2)
  const slice = flat.slice(start, end)
  return {
    text: `${start > 0 ? '…' : ''}${slice}${end < flat.length ? '…' : ''}`,
    marks: markRanges(slice, terms).map(([from, to]) => [
      from + (start > 0 ? 1 : 0),
      to + (start > 0 ? 1 : 0),
    ]),
  }
}

/**
 * 在一段文本里找出所有关键词的区间（合并重叠），供前端画 `<mark>`。
 * @param {string} text 文本。
 * @param {string[]} terms 关键词。
 * @returns {number[][]} 升序、互不重叠的 [start, end) 区间。
 */
function markRanges(text, terms) {
  const lowered = text.toLowerCase()
  const spans = []
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (needle === '') continue
    let index = lowered.indexOf(needle)
    while (index !== -1) {
      spans.push([index, index + needle.length])
      index = lowered.indexOf(needle, index + needle.length)
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push(span)
  }
  return merged.slice(0, 40)
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

/**
 * 允许的检索范围。
 *
 * 索引里只有两类文档（提示词、每轮的最终输出），所以范围也只有这两个取值加 all。
 */
const SCOPES = new Set(['all', 'user', 'assistant'])

/**
 * 规范化 scope 参数；认不出来的一律当 all。
 * @param {unknown} raw 查询串里的 scope。
 * @returns {'all' | 'user' | 'assistant'} 规范化后的范围。
 */
function normalizeScope(raw) {
  const value = String(raw ?? 'all').trim().toLowerCase()
  return SCOPES.has(value) ? value : 'all'
}

/**
 * 这个角色在不在检索范围里。
 * @param {string} role 文档角色。
 * @param {string} scope 检索范围。
 * @returns {boolean} 是否参与检索。
 */
function inScope(role, scope) {
  return scope === 'all' || role === scope
}

/** 会话摘要（不含正文），列表和详情都用它。 */
function summarize(entry) {
  return {
    id: entry.id,
    title: entry.title,
    cwd: entry.header.cwd ?? '',
    createdAt: entry.header.createdAt ?? 0,
    updatedAt: entry.updatedAt,
    messages: entry.docs.length,
    characters: entry.characters,
    live: entry.live,
    counts: entry.counts,
    error: entry.error,
  }
}

/** 取第一行非空文本，当作没有标题时的兜底。 */
function firstLine(text) {
  if (typeof text !== 'string') return ''
  const line = text.replace(/\s+/gu, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

/** 时间戳 → 本地日期键（YYYY-MM-DD）。 */
function dayKey(time) {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** Map → 按值倒序的 [key, value] 前 N 项。 */
function topEntries(map, limit) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

/** 空统计，索引还没建好时返回，前端不用判空。 */
function emptyStats() {
  return {
    totals: { sessions: 0, live: 0, user: 0, assistant: 0, tool: 0, characters: 0 },
    timeline: [],
    tools: [],
    workspaces: [],
  }
}

/** 让出事件循环：把一个大会话的解析切成小段，界面不至于卡顿。 */
function yieldLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * @typedef {object} SessionEntry
 * @property {string} id 会话 id。
 * @property {string} key 变化信号。
 * @property {boolean} live 是否活跃。
 * @property {object} header 会话头。
 * @property {string} title 标题。
 * @property {Array<{seq: number, type: string, role: 'user' | 'assistant', time: number, text: string}>} docs 可检索文档（提示词 + 每轮最终输出）。
 * @property {Record<string, {user: number, assistant: number, tool: number, other: number}>} days 按天的活动量（含过程事件，只用于图表）。
 * @property {Record<string, number>} tools 工具调用次数（只用于图表，不进检索）。
 * @property {number} characters 字符数。
 * @property {number} updatedAt 最后活动时间。
 * @property {{user: number, assistant: number}} counts 可检索文档的构成。
 * @property {string} error 读取失败原因。
 */
