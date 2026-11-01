/**
 * 诊断：直接调 dsh-bilibili 的 extractAll，打印 metadata 真实形状，
 * 并在 fetch 失败时打印 URL 与 cause.code，用来定位抽帧失败的原因。
 */
import { EXTRACTOR_URL, prependFfmpegDir } from '../lib/extract.js'
import { DEFAULT_FFMPEG_DIR } from '../lib/options.js'

prependFfmpegDir(DEFAULT_FFMPEG_DIR)
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
	try {
		return await realFetch(input, init)
	} catch (error) {
		const url = typeof input === 'string' ? input : (input?.url ?? String(input))
		console.log(`FETCH-FAIL host=${new URL(url).host} cause=${error?.cause?.code ?? error?.cause?.message ?? '(none)'} msg=${error?.message}`)
		throw error
	}
}

const mod = await import(EXTRACTOR_URL)
const payload = await mod.extractAll({ url: 'BV1dSny6uEQx', extractFrames: true })
const meta = payload.metadata ?? {}
console.log(`ok=${payload.success} elapsed=${payload.elapsed_seconds}`)
console.log(`uploader=${JSON.stringify(meta.uploader)}`)
console.log(`category=${JSON.stringify(meta.category)}`)
console.log(`stats=${JSON.stringify(meta.stats)}`)
console.log(`frames=${JSON.stringify({ enabled: payload.frames?.enabled, strategy: payload.frames?.strategy, error: payload.frames?.error, note: payload.frames?.note, count: payload.frames?.frames?.length })}`)
