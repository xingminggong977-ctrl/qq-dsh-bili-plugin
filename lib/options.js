/**
 * 插件配置的归一化。放在 lib/ 里是为了让这一层不 import 任何 @deepseek-ai/*
 * 包 —— 解析与默认值可以像 search.js 一样用 node --test 裸测。
 */

/**
 * 缺省 ffmpeg 目录：Windows 上 ffmpeg 装在 ~/.dsh/vendor 里、不在 PATH 中，需要注入；
 * 其它平台走发行版包管理器（通常落在 /usr/bin）本来就在 PATH 里，用空串表示不注入。
 */
export const DEFAULT_FFMPEG_DIR = process.platform === 'win32' ? 'C:\\Users\\lenovo\\.dsh\\vendor\\ffmpeg\\bin' : ''

/** 节流缺省值：与需求里的硬要求一致，改配置前先想清楚风控代价。 */
export const DEFAULT_WINDOW_MINUTES = 10
export const DEFAULT_MAX_SEARCHES = 6
export const DEFAULT_MIN_GAP_SECONDS = 2

function positive(value, fallback) {
	const number = Number(value)
	return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * 把用户配置归一成插件内部选项。任何非法值都退回缺省，绝不抛错 ——
 * 配置坏了也不该让 qq profile 起不来。
 */
export function resolveOptions(config = {}) {
	const source = config ?? {}
	const ffmpegDir = typeof source.ffmpegDir === 'string' ? source.ffmpegDir.trim() : ''
	return {
		windowMs: positive(source.windowMinutes, DEFAULT_WINDOW_MINUTES) * 60_000,
		maxPerWindow: Math.max(1, Math.floor(positive(source.maxSearchesPerWindow, DEFAULT_MAX_SEARCHES))),
		minGapMs: positive(source.minGapSeconds, DEFAULT_MIN_GAP_SECONDS) * 1_000,
		ffmpegDir: ffmpegDir === '' ? DEFAULT_FFMPEG_DIR : ffmpegDir,
	}
}

/** 一行节流说明，进工具描述与错误文案，让模型知道边界在哪。 */
export function describeThrottle(options) {
	return `${Math.round(options.windowMs / 60_000)} 分钟内最多 ${options.maxPerWindow} 次搜索，相邻两次至少间隔 ${options.minGapMs / 1_000} 秒`
}
