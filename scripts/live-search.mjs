/**
 * 手动联调脚本（不进 node --test 的发现集）。
 * 第一个请求：原始 JSON 证据（状态码、字段名、前两条 bvid/title）+ 纯函数渲染。
 * 第二个请求：走 searchBili 端到端（节流 + 请求头 + 错误文案）。
 */
import { DESKTOP_UA, REFERER, buildSearchUrl, formatSearchText, parseSearchBody, searchBili } from '../lib/search.js'

const keyword = '罗翔'
const url = buildSearchUrl(keyword, 'totalrank')
console.log(`url=${url}`)

const started = Date.now()
const response = await fetch(url, { headers: { 'User-Agent': DESKTOP_UA, Referer: REFERER } })
const raw = await response.text()
console.log(`LIVE http=${response.status} ct=${response.headers.get('content-type')} bytes=${raw.length} ms=${Date.now() - started}`)

let body
try {
	body = JSON.parse(raw)
} catch {
	console.log(`LIVE non-json head=${JSON.stringify(raw.slice(0, 200))}`)
	process.exit(1)
}

console.log(`LIVE code=${body.code} message=${JSON.stringify(body.message)} numResults=${body.data?.numResults} resultLen=${body.data?.result?.length}`)
for (const entry of body.data.result.slice(0, 2)) {
	console.log(`LIVE raw bvid=${entry.bvid}`)
	console.log(`LIVE raw title=${JSON.stringify(entry.title)}`)
}
console.log(`LIVE raw keys=${Object.keys(body.data.result[0]).join(',')}`)

const { items, total } = parseSearchBody(body)
console.log('--- rendered (pure functions, limit=3) ---')
console.log(formatSearchText({ keyword, order: 'totalrank', items, total, limit: 3 }))

await new Promise((resolve) => setTimeout(resolve, 2_500))
console.log('--- searchBili end-to-end (limit=2, order=pubdate) ---')
try {
	const result = await searchBili({ keyword, limit: 2, order: 'pubdate' })
	console.log(result.text)
} catch (error) {
	console.log(`SEARCHBILI ERROR name=${error.name} code=${error.code} message=${error.message}`)
}
