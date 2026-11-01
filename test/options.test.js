/** resolveOptions 的归一化测试：坏配置退回缺省，绝不抛错。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_FFMPEG_DIR, describeThrottle, resolveOptions } from '../lib/options.js'

test('缺省配置就是需求里的硬要求：10 分钟 6 次、间隔 2 秒', () => {
	const options = resolveOptions(undefined)
	assert.equal(options.windowMs, 600_000)
	assert.equal(options.maxPerWindow, 6)
	assert.equal(options.minGapMs, 2_000)
	assert.equal(options.ffmpegDir, DEFAULT_FFMPEG_DIR)
	assert.equal(describeThrottle(options), '10 分钟内最多 6 次搜索，相邻两次至少间隔 2 秒')
})

test('坏值退回缺省，不抛错', () => {
	for (const config of [{}, null, { windowMinutes: 'abc' }, { maxSearchesPerWindow: -3 }, { minGapSeconds: 0 }, { windowMinutes: Number.NaN }]) {
		const options = resolveOptions(config)
		assert.equal(options.windowMs, 600_000)
		assert.equal(options.maxPerWindow, 6)
		assert.equal(options.minGapMs, 2_000)
	}
})

test('合法配置被采纳，并换算成毫秒', () => {
	const options = resolveOptions({ windowMinutes: 5, maxSearchesPerWindow: 3, minGapSeconds: 4, ffmpegDir: '  D:\\bin  ' })
	assert.equal(options.windowMs, 300_000)
	assert.equal(options.maxPerWindow, 3)
	assert.equal(options.minGapMs, 4_000)
	assert.equal(options.ffmpegDir, 'D:\\bin')
	assert.equal(resolveOptions({ ffmpegDir: '   ' }).ffmpegDir, DEFAULT_FFMPEG_DIR)
})
