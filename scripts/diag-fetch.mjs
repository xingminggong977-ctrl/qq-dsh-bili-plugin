/** 诊断：node fetch 打 B 站搜索接口到底拿到什么（状态码 + 头 + 头 300 字节）。 */
import { DESKTOP_UA, REFERER, buildSearchUrl } from '../lib/search.js'

const url = buildSearchUrl(process.argv[2] ?? '罗翔', 'totalrank')

async function probe(label, headers) {
	const started = Date.now()
	try {
		const response = await fetch(url, { headers })
		const body = await response.text()
		console.log(`${label}: http=${response.status} ct=${response.headers.get('content-type')} bytes=${body.length} ms=${Date.now() - started}`)
		console.log(`${label}: head=${JSON.stringify(body.slice(0, 300))}`)
	} catch (error) {
		console.log(`${label}: THREW ${error?.name} ${error?.message}`)
	}
	console.log('---')
}

await probe('minimal', { 'User-Agent': DESKTOP_UA, Referer: REFERER })
await new Promise((resolve) => setTimeout(resolve, 2_500))
await probe('browser-like', {
	'User-Agent': DESKTOP_UA,
	Referer: REFERER,
	Accept: 'application/json, text/plain, */*',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
	Origin: 'https://search.bilibili.com',
	'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
	'sec-ch-ua-mobile': '?0',
	'sec-ch-ua-platform': '"Windows"',
	'Sec-Fetch-Dest': 'empty',
	'Sec-Fetch-Mode': 'cors',
	'Sec-Fetch-Site': 'same-site',
})
