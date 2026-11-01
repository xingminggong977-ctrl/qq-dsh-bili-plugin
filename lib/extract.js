/**
 * 视频提取的薄封装层：转调 web profile 里现成的 dsh-bilibili 提取器。
 *
 * extractor.js 只 import `node:*` 与 `./keyframes.js`，不依赖任何
 * `@deepseek-ai/*`，所以可以直接按绝对路径动态 import 复用，不必装依赖。
 *
 * 这里刻意做成「纯格式化函数 + 一个注入式执行器」：格式化能用 node --test
 * 裸测，网络/ffmpeg 只出现在 runExtraction 里。
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** web profile 里的提取器（v0.8.0）。 */
export const EXTRACTOR_URL = 'file:///C:/Users/lenovo/.dsh/profiles/web/node_modules/dsh-bilibili/lib/extractor.js'

/** 返回给模型的转写正文上限；再长就截断并注明。 */
export const TRANSCRIPT_CHARS = 6_000

/** 一次性列出的关键帧上限（每帧一个文件路径，模型可以逐张读）。 */
export const MAX_FRAME_LINES = 12

/** 评论上限。 */
export const MAX_COMMENT_LINES = 5

/** 本平台 ffmpeg 可执行文件名：Windows 带 .exe 后缀，类 Unix 没有后缀。 */
const FFMPEG_BIN = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/**
 * 把目录塞进 PATH 最前面（提取器用裸 `spawn("ffmpeg", ...)`，只能靠 PATH 找）。
 * PATH 的拆分与拼接必须用 path.delimiter（Windows `;` / 类 Unix `:`），
 * 用错分隔符会把整条 PATH 拼坏，之后同进程里所有 spawn 都找不到可执行文件。
 * @returns 诊断字符串，空串表示该目录里没有 ffmpeg 因而什么都没做。
 */
export function prependFfmpegDir(dir, env = process.env) {
	if (typeof dir !== 'string' || dir === '' || !existsSync(join(dir, FFMPEG_BIN))) return ''
	const current = typeof env.PATH === 'string' ? env.PATH : ''
	const parts = current.split(delimiter).filter((part) => part !== '')
	if (parts.includes(dir)) return `PATH 里已有 ${dir}`
	env.PATH = [dir, ...parts].join(delimiter)
	return `已把 ${dir} 加到 PATH 最前面`
}

function seconds(value) {
	const number = Number(value)
	if (!Number.isFinite(number) || number < 0) return ''
	const total = Math.round(number)
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const rest = total % 60
	const pad = (part) => String(part).padStart(2, '0')
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

function beijingDate(secondsSinceEpoch) {
	const value = Number(secondsSinceEpoch)
	if (!Number.isFinite(value) || value <= 0) return ''
	return new Date(value * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function oneLine(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function textOf(value) {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (Array.isArray(value)) return value.map(textOf).filter((item) => item !== '').join(' ')
	return oneLine(JSON.stringify(value))
}

/** B 站不同接口里「人/分类」既可能是字符串也可能是对象，统一取一个可读名字。 */
export function nameOf(value) {
	if (typeof value === 'string') return oneLine(value)
	if (value !== null && typeof value === 'object') {
		for (const key of ['name', 'uname', 'nickname', 'title', 'author', 'text']) {
			const candidate = value[key]
			if (typeof candidate === 'string' && candidate.trim() !== '') return oneLine(candidate)
		}
	}
	return ''
}

/** 简介经常就是占位符 "-"，这种等于没有。 */
function meaningfulText(value) {
	const text = oneLine(value)
	return text === '' || text === '-' || text === '－' || text === '无' ? '' : text
}

/** 每项统计接受多个键名：B 站原始接口是单数，dsh-bilibili 归一后是复数。 */
const STAT_LABELS = [
	[['views', 'view'], '播放'],
	[['likes', 'like'], '点赞'],
	[['coins', 'coin'], '投币'],
	[['favorites', 'favorite'], '收藏'],
	[['shares', 'share'], '转发'],
	[['comments', 'comment', 'review'], '评论'],
	[['danmaku', 'video_review'], '弹幕'],
]

/** 认识 dsh-bilibili 的 stats 形状就用中文标签，否则退回紧凑 JSON。 */
export function formatStats(stats) {
	if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) return textOf(stats).slice(0, 240)
	const known = []
	for (const [keys, label] of STAT_LABELS) {
		const key = keys.find((candidate) => stats[candidate] !== null && Number.isFinite(Number(stats[candidate])))
		if (key !== undefined) known.push(`${label} ${Number(stats[key])}`)
	}
	return known.length === 0 ? textOf(stats).slice(0, 240) : known.join(' · ')
}

/** 提取失败（`success: false`）时给人看的一句话。 */
export function formatExtractFailure(payload) {
	const reason = oneLine(payload?.error) || '提取器没有给出原因'
	const bvid = oneLine(payload?.bvid)
	return bvid === '' ? `视频提取失败：${reason}` : `视频提取失败（bvid=${bvid}）：${reason}`
}

/** 把 extractAll 的成功返回压成一份紧凑文本。 */
export function formatExtractText(payload, { transcriptChars = TRANSCRIPT_CHARS, maxFrames = MAX_FRAME_LINES, maxComments = MAX_COMMENT_LINES } = {}) {
	const meta = payload?.metadata ?? {}
	const lines = []
	lines.push(`B站视频提取完成（bvid=${oneLine(payload?.bvid) || '未知'}，耗时约 ${Number(payload?.elapsed_seconds ?? 0).toFixed(1)} 秒）`)
	lines.push(`标题：${oneLine(meta.title) || '(未知)'}`)
	lines.push(`UP 主：${nameOf(meta.uploader) || '(未知)'} | 时长：${seconds(meta.duration) || '(未知)'} | 发布：${beijingDate(meta.pubdate) || '(未知)'} | 分类：${nameOf(meta.category) || '(未知)'}`)
	const stats = meta.stats === undefined ? '' : formatStats(meta.stats)
	if (stats !== '') lines.push(`数据：${stats.slice(0, 240)}`)
	const description = meaningfulText(meta.description)
	if (description !== '') lines.push(`简介：${description.slice(0, 200)}`)

	const transcript = payload?.transcript ?? {}
	const source = oneLine(transcript.source) || 'none'
	const body = String(transcript.text ?? '').trim()
	const note = oneLine(transcript.note)
	lines.push(`转写：source=${source}${note === '' ? '' : `（${note.slice(0, 200)}）`}`)
	if (body === '') {
		lines.push('转写正文：空（没拿到字幕，本机也没有 whisper 可做语音识别）')
	} else if (body.length > transcriptChars) {
		lines.push(`转写正文（前 ${transcriptChars} 字，共 ${body.length} 字）：`)
		lines.push(body.slice(0, transcriptChars))
	} else {
		lines.push('转写正文：')
		lines.push(body)
	}

	const frames = payload?.frames ?? {}
	const frameList = Array.isArray(frames.frames) ? frames.frames : []
	if (frames.enabled !== true) {
		lines.push(`关键帧：没抽（${oneLine(frames.error) || oneLine(frames.strategy) || '原因未知'}）`)
	} else if (frameList.length === 0) {
		lines.push(`关键帧：没抽（${oneLine(frames.error) || oneLine(frames.strategy) || '没有选中时间点'}）`)
	} else {
		lines.push(`关键帧：${frameList.length} 张（策略：${oneLine(frames.strategy) || '未知'}），可用 read_image 逐张看：`)
		for (const frame of frameList.slice(0, maxFrames)) {
			const at = seconds(frame?.time)
			const caption = oneLine(frame?.subtitle_text)
			const path = oneLine(frame?.path)
			const missing = frame?.has_image === false || path === ''
			lines.push(`- ${at === '' ? '?' : at}${caption === '' ? '' : ` 「${caption.slice(0, 60)}」`} ${missing ? '(没截到图)' : path}`)
		}
		if (frameList.length > maxFrames) lines.push(`- …还有 ${frameList.length - maxFrames} 张没列出`)
	}

	const comments = Array.isArray(payload?.comments) ? payload.comments : []
	if (comments.length > 0) {
		lines.push(`热评（前 ${Math.min(comments.length, maxComments)} 条，共 ${comments.length} 条）：`)
		for (const comment of comments.slice(0, maxComments)) {
			const who = oneLine(comment?.member?.uname ?? comment?.uname ?? comment?.author ?? '')
			const content = oneLine(comment?.content?.message ?? comment?.message ?? comment?.content ?? '')
			const likes = Number(comment?.like ?? comment?.likes ?? 0)
			lines.push(`- ${who === '' ? '匿名' : who}${likes > 0 ? `（${likes} 赞）` : ''}：${content.slice(0, 120)}`)
		}
	}

	const danmaku = payload?.danmaku
	const danmakuCount = Array.isArray(danmaku) ? danmaku.length : Array.isArray(danmaku?.items) ? danmaku.items.length : 0
	lines.push(`弹幕：${danmakuCount} 条`)

	return lines.join('\n')
}

/**
 * 真正跑一次提取。慢操作：要下载视频 + 抽帧（+ 转写），几十秒到几分钟。
 * @returns `{ ok: true, text }` 或 `{ ok: false, text }`，出错也返回人话文本而不是抛原始堆栈。
 */
export async function runExtraction({ url, extractFrames = true, ffmpegDir, loadExtractor } = {}) {
	const pathNote = prependFfmpegDir(ffmpegDir)
	let extractor
	try {
		const load = loadExtractor ?? (() => import(EXTRACTOR_URL))
		extractor = await load()
	} catch (error) {
		return { ok: false, text: `视频提取器加载失败（${EXTRACTOR_URL}）：${oneLine(error?.message ?? error)}。这是本机 dsh-bilibili 安装的问题，不是视频的问题。` }
	}
	if (typeof extractor?.extractAll !== 'function') {
		return { ok: false, text: `视频提取器没有导出 extractAll（${EXTRACTOR_URL}），无法提取。` }
	}

	let payload
	try {
		payload = await extractor.extractAll({ url, extractFrames })
	} catch (error) {
		const hint = /ffmpeg/i.test(String(error?.message ?? ''))
			? `（ffmpeg 调用失败：确认 ${FFMPEG_BIN} 在 PATH 里，或把配置项 ffmpegDir 指向它所在的目录）`
			: ''
		return { ok: false, text: `视频提取失败：${oneLine(error?.message ?? error).slice(0, 400)}${hint}` }
	}

	if (payload?.success !== true) {
		return { ok: false, text: `${formatExtractFailure(payload)}${pathNote === '' ? '' : `（${pathNote}）`}` }
	}
	return { ok: true, text: formatExtractText(payload) }
}
