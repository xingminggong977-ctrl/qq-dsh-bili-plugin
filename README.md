# qq-dsh-bili-plugin

**Two Bilibili tools for DSH: search, and read a video.**

`bili_search` finds videos by keyword. `bili_extract` turns one video into metadata,
subtitle text, hot comments, danmaku and keyframes — so an agent can actually watch instead
of guessing from a title.

## In short

- **You need:** Node 22+ and nothing else. No npm dependencies: network calls use `fetch`,
  extraction reuses the `dsh-bilibili` extractor by absolute path.
- **Try it:** `node --test` — 32 tests, the parsers are pure functions so they run offline.
- **Good first read:** `lib/search.js` (response parsing + in-process throttling).

---
# qq-dsh-bili-plugin

两个 B 站工具，装进 DSH 之后它就能自己搜视频、读字幕、看关键帧。

| 工具 | 用途 |
| --- | --- |
| `bili_search` | 关键词搜视频，回标题 / UP / 播放量 / 时长 / 链接 |
| `bili_extract` | 把一条视频拆成元数据、字幕、热评、弹幕、关键帧 |

零 npm 依赖：网络只用 `fetch`，提取复用 web profile 里已有的 `dsh-bilibili` 提取器
（按绝对路径动态 import，不装包）。`lib/` 下三个模块不 import 任何 `@deepseek-ai/*`，
所以测试可以裸跑：

```bash
node --test
```

## 配置

`cordis.patch.yml` 里有完整的默认值与注释。要点：

- 搜索有进程内节流，连续搜不会把接口打到限流。
- 提取会先把视频下到本地再抽帧，重复看同一条视频不会重复下载。
- 关键帧按场景变化选，再按等间隔补齐；也可以用 `timestamps` 指定秒数自己挑。

## 许可

MIT。
