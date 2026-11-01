/**
 * bili_search 的纯函数测试：解析返回体 → 文本列表，以及节流判定。
 * 全部用假的响应对象，不发真网络请求。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
	BiliError,
	RISK_CONTROL_CODE,
	THROTTLE,
	beijingDate,
	createThrottle,
	decodeEntities,
	formatSearchLine,
	formatSearchText,
	normalizeLimit,
	normalizeOrder,
	parseSearchBody,
	plainText,
	searchBili,
	stripTags,
} from '../lib/search.js'

/** 一条真实形状的结果（字段名按 2026-10 实测的返回体）。 */
function entry(overrides = {}) {
	return {
		type: 'video',
		author: '罗翔说刑法',
		mid: 517327498,
		bvid: 'BV1Acnx6cEqm',
		title: '【<em class="keyword">罗翔</em>】假如张三精通“茅山道法”',
		description: '何女士生活不顺，刷到一位&quot;精通茅山道法&quot;的大师。大师说她家进了脏东西，必须上门施法。',
		play: 239576,
		pubdate: 1792724400,
		duration: '11:24',
		...overrides,
	}
}

/** 一次成功的返回体。 */
function body(items, { code = 0, message = 'OK', numResults = 1000 } = {}) {
	return { code, message, ttl: 1, data: { page: 1, pagesize: 20, numResults, result: items } }
}

/** 假 fetch：记账，按给定返回值/异常回应。 */
function fakeFetch(responses) {
	const calls = []
	const impl = async (url, init) => {
		calls.push({ url, init })
		const next = responses[Math.min(calls.length - 1, responses.length - 1)]
		if (next instanceof Error) throw next
		return next
	}
	impl.calls = calls
	return impl
}

function okResponse(payload, status = 200) {
	return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
}

/** 捕获同步抛出的错误对象（assert.throws 不返回它）。 */
function caught(fn) {
	try {
		fn()
	} catch (error) {
		return error
	}
	throw new assert.AssertionError({ message: '期望抛出错误，但没有抛' })
}

function freshThrottle(step = 1000) {
	let clock = 1_000_000
	const throttle = createThrottle({ now: () => clock })
	return { throttle, advance: (ms = step) => (clock += ms), at: () => clock }
}

test('正常解析：头部给出关键词/命中数/取第几条，每条含全部字段', () => {
	const { items, total } = parseSearchBody(body([entry(), entry({ bvid: 'BV1bU4y1s7Cr', title: '2021罗翔讲刑法（合集）', play: 42, duration: '1:02:03', pubdate: 1600000000 })]))
	assert.equal(items.length, 2)
	assert.equal(total, 1000)

	const text = formatSearchText({ keyword: '罗翔', order: 'totalrank', items, total, limit: 10 })
	const lines = text.split('\n')
	assert.equal(lines.length, 3)
	assert.match(lines[0], /罗翔/)
	assert.match(lines[0], /命中约 1000 条/)
	assert.match(lines[0], /取第 1-2 条/)
	assert.match(lines[1], /BV1Acnx6cEqm/)
	assert.match(lines[1], /罗翔说刑法/)
	assert.match(lines[1], /11:24/)
	assert.match(lines[1], /239576 播放/)
	assert.match(lines[1], /2026-\d\d-\d\d/)
	assert.equal(lines[2].startsWith('2. BV1bU4y1s7Cr'), true)
})

test('剥高亮标签：<em class="keyword"> 不进列表，标题保留正文', () => {
	const { items } = parseSearchBody(body([entry({ title: '2021<em class="keyword">罗翔</em>讲刑法（合集）已完结 共87讲' })]))
	const line = formatSearchLine(items[0], 0)
	assert.equal(line.includes('<em'), false)
	assert.equal(line.includes('</em>'), false)
	assert.equal(line.includes('2021罗翔讲刑法（合集）已完结 共87讲'), true)

	assert.equal(stripTags('<em class="keyword">罗翔</em>说刑法'), '罗翔说刑法')
	assert.equal(stripTags('无标签标题'), '无标签标题')
})

test('空结果：返回「没搜到」而不是抛错', () => {
	for (const payload of [body([]), { code: 0, message: 'OK', data: {} }, { code: 0, message: 'OK', data: { result: null } }]) {
		const { items, total } = parseSearchBody(payload)
		assert.equal(items.length, 0)
		const text = formatSearchText({ keyword: '这个肯定搜不到', order: 'click', items, total, limit: 10 })
		assert.match(text, /^没搜到/)
		assert.match(text, /这个肯定搜不到/)
	}
})

test('code=-412：报「被 B 站限流了」，码与不重试都在', () => {
	const error = caught(() => parseSearchBody({ code: RISK_CONTROL_CODE, message: '请求过于频繁' }))
	assert.equal(error instanceof BiliError, true)
	assert.equal(error.code, RISK_CONTROL_CODE)
	assert.match(error.message, /被 B 站限流了，等几分钟再试/)
	assert.match(error.message, /-412/)
})

test('code 非 0 的其它业务错误：带上 code 与 message', () => {
	const error = caught(() => parseSearchBody({ code: -400, message: '请求错误' }))
	assert.equal(error instanceof BiliError, true)
	assert.equal(error.code, -400)
	assert.match(error.message, /code=-400/)
	assert.match(error.message, /请求错误/)
})

test('节流：10 分钟内 6 次成功后第 7 次拒绝', () => {
	const { throttle, advance } = freshThrottle()
	for (let index = 0; index < THROTTLE.maxPerWindow; index += 1) {
		throttle.acquire()
		throttle.recordSuccess()
		advance(THROTTLE.minGapMs)
	}
	assert.deepEqual(throttle.snapshot(), { attempts: 6, successes: 6 })
	const error = caught(() => throttle.acquire())
	assert.equal(error instanceof BiliError, true)
	assert.match(error.message, /搜得太频繁/)
	assert.match(error.message, /10 分钟内已成功搜索 6 次/)

	// 窗口滑过之后重新放行。
	advance(THROTTLE.windowMs)
	assert.equal(throttle.snapshot().successes, 0)
	assert.doesNotThrow(() => throttle.acquire())
})

test('节流：相邻两次尝试至少间隔 2 秒', () => {
	const { throttle, advance } = freshThrottle()
	throttle.acquire()
	throttle.recordSuccess()
	advance(THROTTLE.minGapMs - 1)
	const error = caught(() => throttle.acquire())
	assert.equal(error instanceof BiliError, true)
	assert.match(error.message, /至少间隔 2 秒/)
	advance(1)
	assert.doesNotThrow(() => throttle.acquire())
})

test('节流：失败的调用不占成功配额，但占间隔', () => {
	const { throttle, advance } = freshThrottle()
	for (let index = 0; index < THROTTLE.maxPerWindow; index += 1) {
		throttle.acquire()
		advance(THROTTLE.minGapMs)
	}
	assert.equal(throttle.snapshot().successes, 0)
	assert.doesNotThrow(() => throttle.acquire(), '没有成功过就没有配额上限')
})

test('limit 截断：返回条数超过 limit 时只列 limit 条', () => {
	const items = Array.from({ length: 20 }, (_unused, index) => entry({ bvid: `BV${String(index).padStart(10, '0')}`, title: `第 ${index} 条` }))
	const { total } = parseSearchBody(body(items))
	const text = formatSearchText({ keyword: '罗翔', order: 'pubdate', items, total, limit: 3 })
	const lines = text.split('\n')
	assert.equal(lines.length, 4)
	assert.match(lines[0], /取第 1-3 条/)
	assert.match(lines[0], /接口本次返回 20 条/)
	assert.match(lines[3], /^3\. /)
	assert.equal(text.includes('第 3 条'), false, '第 4 条起不该出现')
})

test('limit / order 归一：1..20 与三个合法值', () => {
	assert.equal(normalizeLimit(undefined), 10)
	assert.equal(normalizeLimit(0), 1)
	assert.equal(normalizeLimit(21), 20)
	assert.equal(normalizeLimit(3.9), 3)
	assert.equal(normalizeOrder('CLICK'), 'click')
	assert.equal(normalizeOrder('nonsense'), 'totalrank')
	assert.equal(normalizeOrder(undefined), 'totalrank')
})

test('超长标题与简介：简介截到 60 字，标题不截', () => {
	const longDescription = '简介'.repeat(100)
	const { items } = parseSearchBody(body([entry({ description: longDescription, title: '标'.repeat(300) })]))
	const line = formatSearchLine(items[0], 0)
	const summary = line.split(' | ').pop()
	assert.equal(summary.length, 60)
	assert.equal(line.includes('标'.repeat(300)), true)
})

test('HTML 实体与日期：&quot; 还原，pubdate 按北京时间取日期', () => {
	assert.equal(decodeEntities('一位&quot;精通&quot;大师 &amp; &#39;x&#39;'), `一位"精通"大师 & 'x'`)
	assert.equal(plainText('  a\n b\t<em>c</em>  '), 'a b c')
	assert.equal(beijingDate(0), '')
	assert.equal(beijingDate(Number.NaN), '')
	// 1792724400 = 2026-10-23T03:00:00Z → 北京时间 2026-10-23
	assert.equal(beijingDate(1792724400), '2026-10-23')
})

test('searchBili：URL/头/节流记账都对', async () => {
	const { throttle } = freshThrottle()
	const fetchImpl = fakeFetch([okResponse(body([entry()]))])
	const result = await searchBili({ keyword: ' 罗翔 ', limit: 5, order: 'click', fetchImpl, throttle })

	assert.equal(fetchImpl.calls.length, 1)
	const { url, init } = fetchImpl.calls[0]
	assert.match(url, /search_type=video/)
	assert.match(url, /keyword=%E7%BD%97%E7%BF%94/)
	assert.match(url, /order=click/)
	assert.match(url, /page=1/)
	assert.match(init.headers['User-Agent'], /Chrome/)
	assert.equal(init.headers.Referer, 'https://www.bilibili.com/')
	assert.equal(result.returned, 1)
	assert.equal(result.shown, 1)
	assert.match(result.text, /BV1Acnx6cEqm/)
	assert.deepEqual(throttle.snapshot(), { attempts: 1, successes: 1 })
})

test('searchBili：-412 只打一次请求，不自动重试', async () => {
	const { throttle } = freshThrottle()
	const fetchImpl = fakeFetch([okResponse({ code: RISK_CONTROL_CODE, message: '请求过于频繁' })])
	await assert.rejects(() => searchBili({ keyword: '罗翔', fetchImpl, throttle }), /被 B 站限流了，等几分钟再试/)
	assert.equal(fetchImpl.calls.length, 1)
	assert.equal(throttle.snapshot().successes, 0, '被限流不算一次成功搜索')
})

test('searchBili：HTTP 412 也按限流报', async () => {
	const { throttle } = freshThrottle()
	const fetchImpl = fakeFetch([{ ok: false, status: 412, text: async () => '<html>412</html>' }])
	await assert.rejects(() => searchBili({ keyword: '罗翔', fetchImpl, throttle }), /被 B 站限流了/)
	assert.equal(fetchImpl.calls.length, 1)
})

test('searchBili：超时报「B 站没响应（15 秒超时）」', async () => {
	const { throttle } = freshThrottle()
	const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
	const fetchImpl = fakeFetch([timeout])
	await assert.rejects(() => searchBili({ keyword: '罗翔', fetchImpl, throttle }), /B 站没响应（15 秒超时）/)
})

test('searchBili：非 JSON 返回体给人话错误', async () => {
	const { throttle } = freshThrottle()
	const fetchImpl = fakeFetch([{ ok: true, status: 200, text: async () => '<html>风控页</html>' }])
	await assert.rejects(() => searchBili({ keyword: '罗翔', fetchImpl, throttle }), /不是 JSON/)
})

test('searchBili：空关键词直接拒绝，不发请求', async () => {
	const { throttle } = freshThrottle()
	const fetchImpl = fakeFetch([okResponse(body([]))])
	await assert.rejects(() => searchBili({ keyword: '   ', fetchImpl, throttle }), /搜索词不能为空/)
	assert.equal(fetchImpl.calls.length, 0)
})

test('searchBili：节流拒绝发生在发请求之前', async () => {
	const { throttle, advance } = freshThrottle()
	const fetchImpl = fakeFetch([okResponse(body([entry()]))])
	for (let index = 0; index < THROTTLE.maxPerWindow; index += 1) {
		await searchBili({ keyword: '罗翔', fetchImpl, throttle })
		advance(THROTTLE.minGapMs)
	}
	const before = fetchImpl.calls.length
	await assert.rejects(() => searchBili({ keyword: '罗翔', fetchImpl, throttle }), /搜得太频繁/)
	assert.equal(fetchImpl.calls.length, before, '被节流时一个请求都不该发出去')
})
