/** bili_extract 的纯格式化与执行器测试：不发网络、不跑 ffmpeg。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { EXTRACTOR_URL, formatExtractFailure, formatExtractText, formatStats, nameOf, prependFfmpegDir, runExtraction } from '../lib/extract.js'

function payload(overrides = {}) {
	return {
		success: true,
		bvid: 'BV1Acnx6cEqm',
		elapsed_seconds: 41.27,
		metadata: {
			title: '【罗翔】假如张三精通“茅山道法”',
			description: '何女士生活不顺，刷到一位"精通茅山道法"的大师。',
			uploader: '罗翔说刑法',
			duration: 684,
			pubdate: 1792724400,
			category: '社科·法律·心理',
			stats: { view: 239576, danmaku: 245, reply: 120, favorite: 3400 },
		},
		transcript: { source: 'subtitle', text: '大家好，我是罗翔。', segments: [], total_segments: 1, note: '' },
		comments: [{ member: { uname: '法外狂徒' }, content: { message: '张三又来了' }, like: 42 }],
		danmaku: [{ text: 'a' }, { text: 'b' }],
		frames: { enabled: true, strategy: 'scene-change peaks + even backfill', frames: [{ time: 3.5, subtitle_text: '开场白', path: 'C:\\tmp\\frame1.jpg', has_image: true }] },
		...overrides,
	}
}

test('成功返回压成紧凑文本：元信息、转写、关键帧路径、热评、弹幕数都在', () => {
	const text = formatExtractText(payload())
	assert.match(text, /bvid=BV1Acnx6cEqm/)
	assert.match(text, /耗时约 41\.3 秒/)
	assert.match(text, /标题：【罗翔】假如张三精通“茅山道法”/)
	assert.match(text, /UP 主：罗翔说刑法 \| 时长：11:24 \| 发布：2026-10-23/)
	assert.match(text, /数据：播放 239576 · 收藏 3400 · 弹幕 245/)
	assert.match(text, /转写：source=subtitle/)
	assert.match(text, /大家好，我是罗翔。/)
	assert.match(text, /关键帧：1 张（策略：scene-change peaks \+ even backfill）/)
	assert.match(text, /C:\\tmp\\frame1\.jpg/)
	assert.match(text, /开场白/)
	assert.match(text, /法外狂徒（42 赞）：张三又来了/)
	assert.match(text, /弹幕：2 条/)
})

test('没有字幕时明确说明，不假装有转写', () => {
	const text = formatExtractText(payload({ transcript: { source: 'none', text: '', segments: [], total_segments: 0, note: 'whisper 不可用' } }))
	assert.match(text, /转写：source=none（whisper 不可用）/)
	assert.match(text, /转写正文：空（没拿到字幕，本机也没有 whisper 可做语音识别）/)
})

test('转写太长时截断并注明总长度', () => {
	const long = '啊'.repeat(9_000)
	const text = formatExtractText(payload({ transcript: { source: 'subtitle', text: long, note: '' } }))
	assert.match(text, /转写正文（前 6000 字，共 9000 字）：/)
	assert.equal(text.includes('啊'.repeat(6_001)), false)
	assert.equal(text.includes('啊'.repeat(6_000)), true)
})

test('帧关闭 / 帧过多时的两种写法', () => {
	const disabled = formatExtractText(payload({ frames: { enabled: false, error: 'ffmpeg 缺失' } }))
	assert.match(disabled, /关键帧：没抽（ffmpeg 缺失）/)

	const many = formatExtractText(payload({ frames: { enabled: true, strategy: 'x', frames: Array.from({ length: 20 }, (_unused, index) => ({ time: index, path: `C:\\f\\${index}.jpg`, has_image: true })) } }))
	assert.match(many, /关键帧：20 张/)
	assert.match(many, /还有 8 张没列出/)
})

test('失败返回给人话，不带堆栈', () => {
	assert.match(formatExtractFailure({ success: false, error: 'cannot parse a Bilibili video id from the url' }), /^视频提取失败：cannot parse/)
	assert.match(formatExtractFailure({ success: false, error: 'boom', bvid: 'BV1xx' }), /视频提取失败（bvid=BV1xx）：boom/)
	assert.match(formatExtractFailure({ success: false }), /没有给出原因/)
})

/** 在系统临时目录里造夹具：withFfmpeg 为真时放一个空的 ffmpeg 占位文件（不要求真有执行权）。 */
function tempDir(withFfmpeg) {
	const dir = mkdtempSync(join(tmpdir(), 'bili-path-'))
	if (withFfmpeg) writeFileSync(join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), '')
	return dir
}

test('prependFfmpegDir：目录里没有 ffmpeg 就什么都不做', () => {
	const env = { PATH: 'C:\\Windows' }
	assert.equal(prependFfmpegDir('C:\\definitely\\not\\here', env), '')
	assert.equal(env.PATH, 'C:\\Windows')
	assert.equal(prependFfmpegDir('', env), '')

	const empty = tempDir(false)
	try {
		assert.equal(prependFfmpegDir(empty, env), '')
		assert.equal(env.PATH, 'C:\\Windows')
	} finally {
		rmSync(empty, { recursive: true, force: true })
	}
})

test('prependFfmpegDir：临时构造的 ffmpeg 目录会被塞到最前面且幂等', () => {
	const dir = tempDir(true)
	try {
		const seed = ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)
		const env = { PATH: seed }
		assert.match(prependFfmpegDir(dir, env), /已把 .* 加到 PATH 最前面/)
		assert.equal(env.PATH, [dir, seed].join(delimiter))
		assert.equal(env.PATH.split(delimiter)[0], dir)
		assert.equal(env.PATH.split(delimiter).slice(1).join(delimiter), seed)

		const before = env.PATH
		assert.match(prependFfmpegDir(dir, env), /PATH 里已有/)
		assert.equal(env.PATH, before)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('runExtraction：成功路径转调 extractAll 并格式化', async () => {
	const calls = []
	const result = await runExtraction({
		url: 'BV1Acnx6cEqm',
		extractFrames: false,
		ffmpegDir: 'C:\\definitely\\not\\here',
		loadExtractor: async () => ({ extractAll: async (options) => (calls.push(options), payload()) }),
	})
	assert.equal(result.ok, true)
	assert.deepEqual(calls, [{ url: 'BV1Acnx6cEqm', extractFrames: false }])
	assert.match(result.text, /标题：【罗翔】/)
})

test('runExtraction：success=false / 抛错 / 缺 extractAll 都给一句话', async () => {
	const failed = await runExtraction({ url: 'x', loadExtractor: async () => ({ extractAll: async () => ({ success: false, error: 'cannot parse a Bilibili video id from the url' }) }) })
	assert.equal(failed.ok, false)
	assert.match(failed.text, /^视频提取失败：cannot parse/)

	const thrown = await runExtraction({ url: 'x', loadExtractor: async () => ({ extractAll: async () => { throw new Error('ffmpeg exited with code 1') } }) })
	assert.equal(thrown.ok, false)
	assert.match(thrown.text, /视频提取失败：ffmpeg exited with code 1（ffmpeg 调用失败/)

	const broken = await runExtraction({ url: 'x', loadExtractor: async () => ({}) })
	assert.equal(broken.ok, false)
	assert.match(broken.text, /没有导出 extractAll/)

	const noLoad = await runExtraction({ url: 'x', ffmpegDir: 'C:\\definitely\\not\\here', loadExtractor: async () => { throw new Error('ERR_MODULE_NOT_FOUND') } })
	assert.equal(noLoad.ok, false)
	assert.match(noLoad.text, /视频提取器加载失败（file:\/\/\/C:\/Users\/lenovo\/\.dsh\/profiles\/web/)
	assert.equal(EXTRACTOR_URL.includes('dsh-bilibili/lib/extractor.js'), true)
})

test('UP 主/分类是对象、简介是占位符、统计是单数键名时也读得懂', () => {
	const text = formatExtractText({
		success: true,
		bvid: 'BV1dSny6uEQx',
		elapsed_seconds: 17.2,
		metadata: {
			title: '熊猫咬人能不能打它？',
			description: '-',
			uploader: { mid: 123, name: '熊猫观察局' },
			duration: 74,
			pubdate: 1792724400,
			category: { id: 1, name: '生活' },
			stats: { view: 240, like: 2, danmaku: 0 },
		},
		transcript: { source: 'none', text: '', note: 'need login' },
		frames: { enabled: true, frames: [], error: 'download request failed: fetch failed' },
		comments: { comments: [], total: 0 },
		danmaku: [],
	})
	assert.match(text, /UP 主：熊猫观察局 \|/)
	assert.match(text, /分类：生活/)
	assert.match(text, /数据：播放 240 · 点赞 2 · 弹幕 0/)
	assert.ok(!text.includes('简介：'), '占位符简介不该出现在输出里')
	assert.match(text, /关键帧：没抽（download request failed: fetch failed）/)
	assert.equal(nameOf(undefined), '')
	assert.equal(formatStats(null), '')
})