/**
 * B 站搜索的纯函数层：响应解析、文本列表格式化、进程内节流，以及一次真正
 * 发请求的 `searchBili()`。
 *
 * 这里**不 import 任何 @deepseek-ai/* 包**，所以 `node --test` 不需要 DSH 的
 * 模块解析锚点，测试可以裸跑。网络只出现在 `searchBili()` 里，且 HTTP 客户端
 * 可由参数注入 —— 测试全部用假响应对象，不发真请求。
 */

/** 搜索接口。已实测：不需要 cookie，不需要 wbi 签名，只要 UA + Referer。 */
export const SEARCH_ENDPOINT = 'https://api.bilibili.com/x/web-interface/search/type'

/** 桌面 Chrome UA：B 站接口对默认的 node UA 会直接风控。 */
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 接口要求的来源页。 */
export const REFERER = 'https://www.bilibili.com/'

/** 允许的排序值；第一个是默认值。 */
export const ORDERS = Object.freeze(['totalrank', 'click', 'pubdate'])

export const DEFAULT_ORDER = 'totalrank'
export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 20

/** 简介截断长度。 */
export const SUMMARY_CHARS = 60

/** 单次请求超时。 */
export const REQUEST_TIMEOUT_MS = 15_000

/** 风控码。命中后不重试，直接报「被 B 站限流了」。 */
export const RISK_CONTROL_CODE = -412

/**
 * 节流参数（硬要求）：进程内全局，10 分钟内最多 6 次成功搜索，
 * 相邻两次至少间隔 2 秒。这是新号不被风控的唯一防线。
 */
export const THROTTLE = Object.freeze({
	windowMs: 10 * 60 * 1000,
	maxPerWindow: 6,
	minGapMs: 2000,
})

/** 面向人的错误；`code` 只在 B 站业务码可用于排查时才带。 */
export class BiliError extends Error {
	constructor(message, { code, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause })
		this.name = 'BiliError'
		if (code !== undefined) this.code = code
	}
}

const NAMED_ENTITIES = Object.freeze({
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	mdash: '—',
	ndash: '–',
})

/** 去掉全部 HTML 标签（B 站的高亮是 `<em class="keyword">…</em>`）。 */
export function stripTags(text) {
	return String(text ?? '').replace(/<[^>]*>/g, '')
}

/** 还原 B 站返回体里常见的 HTML 实体（简介里 `&quot;` 很常见）。 */
export function decodeEntities(text) {
	return String(text ?? '').replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (matched, body) => {
		if (body.startsWith('#')) {
			const hex = body[1] === 'x' || body[1] === 'X'
			const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return matched
			try {
				return String.fromCodePoint(code)
			} catch {
				return matched
			}
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? matched
	})
}

/** 一行纯文本：剥标签、还原实体、折叠空白。 */
export function plainText(text) {
	return decodeEntities(stripTags(text)).replace(/\s+/g, ' ').trim()
}

/** 发布时间（Unix 秒）→ 北京时间 YYYY-MM-DD，不依赖本机时区。 */
export function beijingDate(seconds) {
	const value = Number(seconds)
	if (!Number.isFinite(value) || value <= 0) return ''
	return new Date(value * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 把模型给的 limit 收进 1..20；非数字退回默认值。 */
export function normalizeLimit(value) {
	if (!Number.isFinite(value)) return DEFAULT_LIMIT
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)))
}

/** 把模型给的 order 收进 ORDERS；非法值退回默认值。 */
export function normalizeOrder(value) {
	const text = String(value ?? '').trim().toLowerCase()
	return ORDERS.includes(text) ? text : DEFAULT_ORDER
}

/**
 * 校验并解包 B 站搜索返回体。
 * @param body - 已 JSON.parse 的返回体。
 * @returns `{ items, total }`；`items` 已剔除没有 bvid 的条目。
 * @throws {BiliError} code 非 0 时（-412 单独给出限流文案）。
 */
export function parseSearchBody(body) {
	const code = Number(body?.code)
	if (code === RISK_CONTROL_CODE) {
		throw new BiliError('被 B 站限流了，等几分钟再试（code=-412，B 站风控拦截；本次不会自动重试）', { code })
	}
	if (!Number.isFinite(code)) {
		throw new BiliError(`B 站返回体里没有 code 字段，可能被风控页替换了：${JSON.stringify(String(body?.message ?? ''))}`)
	}
	if (code !== 0) {
		throw new BiliError(`B 站搜索失败：code=${code} message=${JSON.stringify(String(body?.message ?? ''))}`, { code })
	}
	const raw = Array.isArray(body?.data?.result) ? body.data.result : []
	const items = raw.filter((entry) => typeof entry?.bvid === 'string' && entry.bvid !== '')
	const total = Number.isFinite(Number(body?.data?.numResults)) ? Number(body.data.numResults) : items.length
	return { items, total }
}

/** 一条结果的文本行，字段顺序：bvid / 标题 / UP / 时长 / 播放量 / 发布日期 / 简介。 */
export function formatSearchLine(entry, index) {
	const play = Number(entry?.play)
	const summary = String(plainText(entry?.description)).slice(0, SUMMARY_CHARS)
	return [
		`${index + 1}. ${String(entry?.bvid ?? '').trim() || '(无 bvid)'}`,
		plainText(entry?.title) || '(无标题)',
		`UP:${plainText(entry?.author) || '未知'}`,
		String(entry?.duration ?? '').trim() || '(时长未知)',
		Number.isFinite(play) ? `${play} 播放` : '(播放量未知)',
		beijingDate(entry?.pubdate) || '(日期未知)',
		summary === '' ? '(无简介)' : summary,
	].join(' | ')
}

/** 整个列表的文本：头部给出关键词 / 命中数 / 取第几条，然后每条一行。 */
export function formatSearchText({ keyword, order = DEFAULT_ORDER, items = [], total, limit = DEFAULT_LIMIT }) {
	const shown = items.slice(0, normalizeLimit(limit))
	if (shown.length === 0) return `没搜到：B 站搜索「${keyword}」没有返回任何视频（order=${order}）`
	const hits = Number.isFinite(Number(total)) ? Number(total) : items.length
	const header = `B站搜索「${keyword}」（order=${order}）：命中约 ${hits} 条，取第 1-${shown.length} 条（接口本次返回 ${items.length} 条）`
	return [header, ...shown.map((entry, index) => formatSearchLine(entry, index))].join('\n')
}

/**
 * 创建一个节流闸门。纯函数：时间源可注入，测试不需要等待真实时间。
 *
 * 语义：
 * - 每次调用 `acquire()` 都算一次「尝试」，相邻两次尝试至少间隔 `minGapMs`；
 * - 滑动窗口内**成功**搜索数达到 `maxPerWindow` 后拒绝，直到最早那次滑出窗口；
 * - 超限抛 {@link BiliError}，调用方不得重试。
 */
export function createThrottle({ windowMs = THROTTLE.windowMs, maxPerWindow = THROTTLE.maxPerWindow, minGapMs = THROTTLE.minGapMs, now = () => Date.now() } = {}) {
	let attempts = []
	let successes = []

	const prune = (list, at) => {
		while (list.length > 0 && at - list[0] >= windowMs) list.shift()
		return list
	}

	return {
		windowMs,
		maxPerWindow,
		minGapMs,
		/** 记录一次尝试；超限直接抛错。 */
		acquire() {
			const at = now()
			prune(attempts, at)
			prune(successes, at)
			if (successes.length >= maxPerWindow) {
				throw new BiliError(`搜得太频繁：${Math.round(windowMs / 60_000)} 分钟内已成功搜索 ${maxPerWindow} 次，请等几分钟再试`)
			}
			if (attempts.length > 0 && at - attempts[attempts.length - 1] < minGapMs) {
				throw new BiliError(`搜得太频繁：两次搜索至少间隔 ${minGapMs / 1000} 秒，请稍后再试`)
			}
			attempts.push(at)
			return at
		},
		/** 一次 code=0 的搜索成功了才算进窗口配额。 */
		recordSuccess(at = now()) {
			successes.push(at)
		},
		/** 当前窗口内的计数，诊断与测试用。 */
		snapshot() {
			const at = now()
			prune(attempts, at)
			prune(successes, at)
			return { attempts: attempts.length, successes: successes.length }
		},
		reset() {
			attempts = []
			successes = []
		},
	}
}

/** 进程内全局闸门：所有 bili_search 调用共用这一个。 */
export const processThrottle = createThrottle()

/** 拼搜索 URL。 */
export function buildSearchUrl(keyword, order = DEFAULT_ORDER) {
	return `${SEARCH_ENDPOINT}?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1&order=${normalizeOrder(order)}`
}

function requestSignal(signal) {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function networkError(error, signal) {
	if (signal?.aborted === true) return new BiliError('B 站请求已取消', { cause: error })
	if (error?.name === 'TimeoutError') return new BiliError(`B 站没响应（${REQUEST_TIMEOUT_MS / 1000} 秒超时）`, { cause: error })
	return new BiliError(`B 站请求失败：${String(error?.message ?? error)}`, { cause: error })
}

/**
 * 搜索一次并返回紧凑文本。
 *
 * 节流在发请求之前判定，失败与超限都不重试。
 * @param options.keyword - 搜索词。
 * @param options.limit - 1..20，默认 10。
 * @param options.order - totalrank | click | pubdate。
 * @param options.fetchImpl - HTTP 客户端，默认全局 fetch（测试注入假实现）。
 * @param options.throttle - 闸门，默认进程内全局闸门。
 * @param options.signal - 调用方取消信号。
 * @returns `{ text, total, returned, shown }`，`text` 就是给模型看的那份列表。
 */
export async function searchBili({ keyword, limit, order, fetchImpl, throttle, signal } = {}) {
	const term = String(keyword ?? '').trim()
	if (term === '') throw new BiliError('搜索词不能为空')
	const size = normalizeLimit(limit)
	const sort = normalizeOrder(order)
	const gate = throttle ?? processThrottle
	gate.acquire()

	const url = buildSearchUrl(term, sort)
	let response
	try {
		response = await (fetchImpl ?? globalThis.fetch)(url, {
			headers: { 'User-Agent': DESKTOP_UA, Referer: REFERER },
			signal: requestSignal(signal),
		})
	} catch (error) {
		throw networkError(error, signal)
	}

	if (response?.status === 412) {
		throw new BiliError('被 B 站限流了，等几分钟再试（HTTP 412，B 站风控拦截；本次不会自动重试）', { code: RISK_CONTROL_CODE })
	}
	if (response?.ok === false) throw new BiliError(`B 站返回 HTTP ${response.status}`)

	let body
	try {
		body = JSON.parse(await response.text())
	} catch (error) {
		throw new BiliError('B 站返回的不是 JSON，可能被风控页替换了', { cause: error })
	}

	const { items, total } = parseSearchBody(body)
	gate.recordSuccess()
	return {
		text: formatSearchText({ keyword: term, order: sort, items, total, limit: size }),
		total,
		returned: items.length,
		shown: Math.min(items.length, size),
	}
}
