/**
 * 手动联调：真跑一次视频提取（很慢，几十秒到几分钟）。
 * 用法： node scripts/live-extract.mjs [BV号或链接]
 */
import { runExtraction } from '../lib/extract.js'
import { DEFAULT_FFMPEG_DIR } from '../lib/options.js'

const url = process.argv[2] ?? 'BV1dSny6uEQx'
const started = Date.now()
console.log(`[live-extract] start url=${url} ffmpegDir=${DEFAULT_FFMPEG_DIR}`)
const result = await runExtraction({ url, extractFrames: true, ffmpegDir: DEFAULT_FFMPEG_DIR })
console.log(`[live-extract] ok=${result.ok} wall=${Math.round((Date.now() - started) / 1000)}s`)
console.log('----- text -----')
console.log(result.text)
