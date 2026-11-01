/**
 * bili-plugin 自己的可见性探测（不改 node-plugin，只读它的 session.js）：
 *
 *   node <dsh>/lib/bin.js --profile qq --patch scripts/probe-bili.patch.yml
 *
 * 证明两件事：owner 会话能看到 bili_search；非 owner 会话一个工具都看不到，
 * 且直接调 bili_search 会被工具运行时挡掉。
 *
 * 两点刻意设计：
 * - 不写静态 import —— 探测脚本自己的导入失败会被启动层吞成一行
 *   "failed to import"，所以改成 apply 里动态导入并把错误原文打出来。
 * - 开跑先检查 QQ_NODE_TOKEN：设置了就拒绝启动，否则会多起一个 bridge
 *   轮询器，和正在服务的进程抢消息。
 */
export const name = 'qq-bili-probe'

export const inject = ['agents', 'tools']

const SESSION_MODULE = 'file:///C:/Users/lenovo/Documents/deepseek-harness/default-workspace/qq-dsh/node-plugin/lib/session.js'

const probeOptions = {
	cwd: process.cwd(),
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	nonOwnerPreset: '',
}

function describe(result) {
	if (result.isError !== true) return `isError=false value=${JSON.stringify(result.value).slice(0, 120)}`
	const text = (result.content ?? []).map((block) => block.text ?? `<${block.type}>`).join(' ')
	return `isError=true error.message=${JSON.stringify(result.error?.message)} content=${JSON.stringify(text)}`
}

export function apply(ctx) {
	ctx.effect(() => {
		let disposed = false
		const report = (line) => console.log(`[bili-probe] ${line}`)
		const failures = []
		const check = (ok, line) => {
			if (!ok) failures.push(line)
			report(`${ok ? 'PASS' : 'FAIL'} ${line}`)
		}

		const run = async () => {
			report('apply mounted')
			if (typeof process.env.QQ_NODE_TOKEN === 'string' && process.env.QQ_NODE_TOKEN !== '') {
				throw new Error('QQ_NODE_TOKEN is set; refusing to boot a second bridge poller')
			}
			await new Promise((resolve) => setTimeout(resolve, 3000))

			const globalNames = ctx.tools.schemas(undefined).map((schema) => schema.name)
			report(`global tool count=${globalNames.length} names=${JSON.stringify(globalNames)}`)
			check(globalNames.includes('bili_search'), 'global tool registry exposes bili_search')

			let createQqAgent
			try {
				;({ createQqAgent } = await import(SESSION_MODULE))
			} catch (error) {
				report(`import session.js failed: ${error?.message}`)
			}
			if (typeof createQqAgent !== 'function') {
				check(false, 'qq-node session.js imported')
				return
			}
			check(true, 'qq-node session.js imported')

			const guest = await createQqAgent({ ctx, options: probeOptions, isOwner: false, log: (level, message) => report(`${level}: ${message}`) })
			const guestNames = ctx.tools.schemas(guest.agent).map((item) => item.name)
			report(`non-owner agent=${guest.agent.id} visible tool count=${guestNames.length} names=${JSON.stringify(guestNames)}`)
			check(guestNames.length === 0, 'non-owner session sees zero tools')

			const owner = await createQqAgent({ ctx, options: probeOptions, isOwner: true, log: (level, message) => report(`${level}: ${message}`) })
			const ownerNames = ctx.tools.schemas(owner.agent).map((item) => item.name)
			report(`owner agent=${owner.agent.id} visible tool count=${ownerNames.length} names=${JSON.stringify(ownerNames)}`)
			check(ownerNames.includes('bili_search'), 'owner session sees bili_search')

			const denied = await ctx.tools.execute({
				callId: 'probe-bili-denied',
				name: 'bili_search',
				arguments: { keyword: '罗翔' },
				signal: AbortSignal.timeout(30_000),
				agent: guest.agent,
			})
			report(`non-owner call bili_search -> ${describe(denied)}`)
			check(denied.isError === true, 'non-owner call to bili_search is refused')

			guest.dispose()
			owner.dispose()
		}

		run()
			.catch((error) => report(`FAILED ${error?.stack ?? error}`))
			.finally(() => {
				report(failures.length === 0 ? 'RESULT OK' : `RESULT FAILURES=${JSON.stringify(failures)}`)
				if (!disposed) process.exit(failures.length === 0 ? 0 : 1)
			})

		return () => {
			disposed = true
		}
	}, 'qq-bili-probe')
}
