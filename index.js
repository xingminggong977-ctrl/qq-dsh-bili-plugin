/**
 * qq-bili：给 DSH 加 B 站能力。
 *
 * 两个工具：bili_search（搜索，快）与 bili_extract（提取视频内容，很慢）。
 * 零 npm 依赖：只用 node: 内置模块与 DSH 自带包。
 *
 * 结构照抄 qq-node：命名导出 name / inject / apply，Config 用 schemastery
 * （拿不到就退化成无 Config，插件照样能起）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { runExtraction } from './lib/extract.js'
import { describeThrottle, resolveOptions } from './lib/options.js'
import { BiliError, DEFAULT_LIMIT, MAX_LIMIT, ORDERS, REQUEST_TIMEOUT_MS, createThrottle, searchBili } from './lib/search.js'

export const name = 'qq-bili'

/** 只依赖工具注册表：搜索工具不碰 agent。 */
export const inject = ['tools']

const { default: z } = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }))

export const Config = z === undefined ? undefined : z.object({
	windowMinutes: z.number(),
	maxSearchesPerWindow: z.number(),
	minGapSeconds: z.number(),
	ffmpegDir: z.string(),
})

/** 搜索工具的定义。闸门由 apply 注入，这里只做参数→文本的翻译。 */
function searchTool(options) {
	const throttle = createThrottle(options)
	const boundary = describeThrottle(options)
	return defineTool({
		name: 'bili_search',
		description: [
			'在 B 站（bilibili.com）搜索视频，返回一个紧凑的文本列表，每条一行：',
			'bvid | 标题 | UP 主 | 时长 | 播放量 | 发布日期 | 简介前 60 字。',
			'列表头部有关键词、命中数、取第几条。用 keyword 搜，limit 控制条数（1-20，默认 10），',
			'order 选排序：totalrank（综合，默认）/ click（播放多）/ pubdate（最新）。',
			`有节流：${boundary}；命中大量结果时先多读列表，不要反复改关键词重搜。`,
			'被 B 站限流（code=-412）时不会自动重试，需要等几分钟。',
		].join(''),
		parameters: {
			keyword: { type: 'string', required: true, description: '搜索词，例如「罗翔 刑法」' },
			limit: { type: 'integer', description: `返回条数，1-${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}` },
			order: { type: 'string', enum: [...ORDERS], description: '排序：totalrank 综合（默认）/ click 播放多 / pubdate 最新' },
		},
		output: {
			schema: { type: 'string', description: '文本列表，每条一行' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		timeoutMs: REQUEST_TIMEOUT_MS + 5_000,
		// 节流是进程内的，并发调用只会互相踩；让调度器串起来。
		isConcurrencySafe: () => false,
		async execute(args) {
			try {
				const result = await searchBili({
					keyword: args.keyword,
					limit: args.limit,
					order: args.order,
					throttle,
				})
				return result.text
			} catch (error) {
				// 只把可读的那句抛给模型，不把堆栈带出去。
				if (error instanceof BiliError) throw new BiliError(error.message, { code: error.code, cause: error })
				throw new BiliError(`B 站搜索失败：${String(error?.message ?? error)}`, { cause: error })
			}
		},
	})
}

/** 视频提取工具。慢操作：下载 + 抽帧（+ 转写），几十秒到几分钟。 */
function extractTool(options) {
	return defineTool({
		name: 'bili_extract',
		description: [
			'提取一个 B 站视频的内容：标题/UP/时长/数据、字幕或语音转写正文、关键帧图片路径、热评、弹幕数。',
			'【很慢】这是重操作：要先把视频下载到本地再抽帧，通常几十秒到几分钟（长视频更久），',
			'期间没有进度输出。所以只在确实需要视频内容时才用，别在搜索阶段顺手调；',
			'一次只调一个视频，不要并发。',
			'拿 bvid 或链接都行（BV… / b23.tv 短链 / 完整 URL）。',
			'返回里的关键帧是本地图片绝对路径，想看图就用 read_image 逐张读。',
			'本机没装 whisper，语音转写通常为空，此时只能靠字幕与关键帧。',
		].join(''),
		parameters: {
			url: { type: 'string', required: true, description: '视频链接或 BV 号，例如 BV1Acnx6cEqm 或 https://www.bilibili.com/video/BV1Acnx6cEqm' },
			extract_frames: { type: 'boolean', description: '是否抽关键帧，默认 true；只想要文字时设 false 会明显更快' },
		},
		output: {
			schema: { type: 'string', description: '视频内容摘要文本（含转写正文与关键帧路径）' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		timeoutMs: 15 * 60_000,
		// 一次只跑一个：下载抖动与 ffmpeg 抢 CPU 只会互相拖慢。
		isConcurrencySafe: () => false,
		async execute(args) {
			const result = await runExtraction({
				url: String(args.url ?? '').trim(),
				extractFrames: args.extract_frames !== false,
				ffmpegDir: options.ffmpegDir,
			})
			return result.text
		},
	})
}

export function apply(ctx, config) {
	const options = resolveOptions(config)
	ctx.tools.register(searchTool(options))
	ctx.tools.register(extractTool(options))
}
