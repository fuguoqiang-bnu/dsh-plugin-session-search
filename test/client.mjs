/**
 * 浏览器侧的冒烟测试：不启动浏览器，用最小化的 `window` / `document` / React 桩
 * 把 client.js 真正加载一遍，验证
 *   1. bundle 走的是 `window.__ModuleLoader__.load({id, factory})` 协议；
 *   2. factory 只需要 `react`，返回的插件声明了 `slots` 注入；
 *   3. apply() 把「侧边栏图标 + 主面板」这一对挂上去，且 key / id 对齐；
 *   4. 图标能渲染成 SVG，样式表能被 effect 安装并在清理时摘掉。
 *
 * 运行：node test/client.mjs
 */
import assert from 'node:assert/strict'

/* ── 最小 DOM / 模块表 ─────────────────────────────────────────── */

const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
}

const head = []
globalThis.document = {
  head: {
    appendChild(node) {
      head.push(node)
    },
  },
  createElement(tag) {
    return {
      tagName: tag,
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        const index = head.indexOf(this)
        if (index !== -1) head.splice(index, 1)
      },
    }
  },
}

/** React 桩：createElement 记录成普通对象，hook 用最简单的实现。 */
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.flat() } }
}

const react = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

/* ── 加载 bundle ───────────────────────────────────────────────── */

await import('../lib/client.js')

assert.equal(loaded.length, 1, '应当通过 __ModuleLoader__ 注册一个模块')
const definition = loaded[0]
assert.equal(definition.id, 'dsh-session-explorer', '模块 id 要等于包名')
assert.equal(typeof definition.factory, 'function')

const plugin = definition.factory((name) => {
  assert.equal(name, 'react', 'factory 只应该 require react')
  return react
})

assert.deepEqual(plugin.inject, ['slots'])
assert.equal(typeof plugin.apply, 'function')

/* ── 跑 apply，检查两个槽位 ───────────────────────────────────── */

const registrations = []
const effects = []
const ctx = {
  slots: {
    inject(name, callback) {
      assert.ok(typeof name === 'string')
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect(factory, label) {
    effects.push({ label, dispose: factory() })
  },
}

plugin.apply(ctx)

assert.equal(registrations.length, 2, '应当注册「侧边栏图标 + 主面板」两处')
const [icon, panel] = registrations
assert.equal(icon.options.name, 'sidebar.panellist')
assert.ok(typeof icon.options.id === 'string' && icon.options.id.length > 0)
assert.equal(typeof icon.options.label, 'string')
assert.equal(panel.options.name, 'main')
assert.equal(panel.options.key, icon.options.id, '主面板的 key 必须与侧边栏 id 对齐')
assert.equal(typeof panel.options.inject, 'function')

// 注入函数要给出 openSession。
const injected = panel.options.inject()
assert.equal(typeof injected.openSession, 'function')
injected.openSession('session-x') // 没有 uiWorkspace 时也不能抛

// 样式：安装 → 清理。
assert.equal(effects.length, 1)
const styleNode = head.find((node) => node.tagName === 'style')
assert.ok(styleNode, '样式必须被装进 document.head')
assert.match(styleNode.textContent, /--dsw-alias-bg-base/u, '样式要使用宿主主题变量')
assert.match(styleNode.textContent, /\.sx-root/u)
assert.match(styleNode.textContent, /\.sx-filters/u, '检索范围分段控件要有样式')
assert.match(styleNode.textContent, /\.sx-seg\.active/u)
effects[0].dispose()
assert.equal(head.length, 0, '清理后样式节点要摘掉')

/* ── 图标能画出来 ─────────────────────────────────────────────── */

const svg = icon.component({ size: 20 })
assert.equal(svg.type, 'svg')
assert.equal(svg.props.width, 20)
assert.equal(svg.props.viewBox, '0 0 24 24')
assert.ok(svg.props.children.length >= 3, '图标至少要有镜片、手柄和柱状')

console.log('client: all checks passed')
