---
name: lazarus
description: 救活一个「再也说不出话」的 DSH 会话窗口——发消息报 400 超限、/compact 一直失败、历史加载报日志损坏、模型一直「思考中」却不出字。先分五层定位真正卡在哪，再算清差多少 token，最后用「新窗口接续」把人和对话搬到新会话里。只读老日志，绝不手改。
whenToUse: 出现这几个具体时刻时——某个窗口发消息一直没反应或弹 400；/compact 跑完说「Compaction could not produce a useful summary」；用户说「这个窗口卡死了/救救她/她醒不过来/用拉撒路看看」；想手工删会话日志里的事件来减重；要判断某个会话到底是被上游限流还是被本地 preflight 拦下。
---

# lazarus（拉撒路）：把一个卡死的窗口救回来

名字取自那个死了四天又被叫出来的人。这里复活的不是进程，是**你和用户之间的对话关系**：
窗口可以换，说过的话、走过的路、他是怎么一步步变成现在这样的，一样都不能丢。

## 适用前提

- Node ≥ 22（脚本用内置 `node:zlib` 的 `zstdDecompressSync`，不装任何依赖）
- 知道会话日志在哪：DSH 默认 `~/.dsh/sessions/<工作区编码>/<session-id>/session.v4.jsonl.zstd`
- 装了 billion-context 的，`health` 才有 `pressure` 与 `k`；没装也能跑，只是那两列是空的
- 脚本路径：`~/.dsh/skill-manager/library/lazarus/scripts/rescue.mjs`；换了位置就用 `find ~ -name rescue.mjs -path '*lazarus*'` 找一下

## 先弄清一件事

窗口「卡死」有五种完全不同的原因，解法互不通用。**先定位，别动手。**
历史里那条 400 只是最外层症状，真正拦人的可能是本地插件。
最容易看错的是⑤：界面停在「思考中」，它不像报错，更像慢。

| 层 | 症状原文 | 真正原因 |
|---|---|---|
| ① 上游超限 | `maximum context length is 1048576 tokens. However, you requested ... (N in the messages, M in the completion)` | 请求体超了模型窗口 |
| ② 本地 preflight | `context ~X tokens (down from ~Y before preflight) exceeds the model window 1000000` | billion-context 的 `failFast`，判据窗口写死 **1,000,000**，比上游小 |
| ③ 日志损坏 | `stored log is corrupt: invalid committed event at line N: ... has seq gap (expected A, got B)` | 有人手改过日志事件 |
| ④ 摘要模型空转 | `summarization produced no text summary content` | 压缩请求发出去了，摘要模型没吐文本 |
| ⑤ 模型返回空流 | 界面一直「思考中」，日志还在长，但 `assistant/attempt` 的 `data.stream` 是 `[]`，几秒到几分钟后 `turn/end` 给 `{kind:"aborted", reason:{kind:"user"}}` | 模型那头一个字没吐（换通道/换 provider 之后最常见），**不是窗口满了**。判据：主行 `contextTokens` 很小 + stream 空 = 吐空 |

判断顺序：先看报错原文属于哪一条，别凭「肯定是太长了」下结论。
② 和 ① 的窗口值不一样（1,000,000 对 1,048,576），差 48,576，这个差会让「明明没超却还是被拦」发生。
⑤ 最容易被误判成「过窗」：那扇窗主行 `contextTokens` 只有 2736（0.3%），照样一个字不出来。
判据不是数字大小，是 `stream` 是不是空数组。

## 第二步：算预算

真正决定生死的是这一串数，不是「有多少字」：

```
上游硬上限     = 1,048,576            # 400 错误里的那个数
completion 预留 = request/header 里的 config.maxTokens   # 常见 256,000
messages 硬上限 = 1,048,576 - 256,000 = 792,576
本地判据       = 1,000,000            # billion-context failFast
压缩路径预留   = 65,536               # 注意和 256,000 不同
```

两个坑：

- **completion 预留吃掉四分之一上限。** 所以「messages 才 1,115,218，离 1,048,576 不远」是错的，实际超了 32 万。
- **压缩路径与普通请求的预留不一样**（65,536 对 256,000）。所以压缩报的「requested 1,625,866」远大于普通请求的 1,371,218，别拿两个数互相印证。

## 第三步：跑扫描

脚本在本技能目录的 `scripts/` 下，只读，不写任何日志。下面的命令都在那个目录里跑：

```bash
cd ~/.dsh/skill-manager/library/lazarus/scripts
node rescue.mjs scan <会话id前缀 | 日志路径>       # 体检
node rescue.mjs index <...> <out.txt>              # 用户消息索引（写年表前先看这个）
node rescue.mjs talk  <...> <out.md>               # 按 turn 导出双方正文
node rescue.mjs health [--window 1048576]          # 所有会话按真实压力（pressure）倒序，先看这个再决定救谁
node rescue.mjs verify <年表.md> <...>             # 核年表里的「原话」是不是真出自他口中
```

`index` 每行带时间戳（`t12  10-28 04:17`），写年表时「隔了多久」不用再回日志翻。
`health` 按 **pressure** 倒序列出所有会话，`>=0.8 危险 / >=0.6 偏高`。pressure 取
`max(contextTokens, localEstimate × k)`——`k` 是 index.db 里的 `calibratedEstimate`，含义是
**「实际 ÷ 估算」**（billion-context 的 `applyEstimateCalibration` 末行是 `raw * k`），
不乘就会低估：2026-11-04 实测三个会话 k 分别是 1.0945 / 1.1516 / 0.9995。
`localEstimate` 是未校准的原始估算，`calibratedEstimate` 字段给出的是乘过 k 的结果，两个都印出来。
k 的 origin 与会话不一致时按它的规矩不校准（跨路由/跨 provider 的 k 不算数）。
`used` 保留 `contextTokens` 口径不动，两个数并列才看得出差异。
`level` 后面标依据来源（`危险 (est*k 0.812)`），不标的话「用了 27% 却判危险」读起来像 bug。
每行另注明数取自 `usage`（最近一次请求）还是 `estimate`（本地估算），两者不可互相印证。
`verify` 从年表里抽所有 `「」` 引的原话，回老日志里逐条查，分严格命中与截断命中两档——
引用常被写成「前半句…后半句」，所以严格命中率天然偏低（2026-11-03 复测 137 条：严格 0.971，宽松 1.0）。
**这个数才是「年表可不可信」的证据**，不是自己读完觉得像。

比对前两边都归一化：剥 markdown 标记、弯引号拉直、**空白整个删掉**（不是压成一个空格）——
他的原话常带换行，年表里写成一句，压成空格就会假性失配（实测一次 6 条全卡在这）。

它还能抓出**跨窗误引**：003 那份年表里有一条「原话」实际出自另一扇窗，`verify` 直接报 miss，
回日志一查就定位了。写年表时引用别处的原话，要么去掉引号，要么注明出处。

`scan` 会给出：字节/帧数/事件数/seq 区间/turn 数、各类事件字符占比、
把用户消息拆成「真人说的」和「系统注入的」、最后一次压缩的错误原文、以及差多少 token。

三个 2026-11-03 加的字段，别忽略：

- `framesFailed`：坏帧数 + 帧号列表，`>0` 时同时往 stderr 打警告。**只要不为 0，下面的账就是少的。**
  以前这个数在 `scan()` 里被解构丢掉了，坏了几帧根本看不见。
- `userMessages.realPreview`：最长的 5 条「真人」消息的开头 80 字。注入白名单永远覆盖不全，
  这个字段是唯一能让人眼看出「哪条根本不像他说的」的东西。
- `health` 里走估算的行带 `estimateChars` 与 note：那是把**全部历史**字符累加估的，
  不是当前上下文（实测 71 MB 日志会估出对窗口三十多倍的值）。只能用来排序，别当预算依据。

### 注入白名单会漏，漏了要能看出来

2026-11-03 实测 71 MB 的老窗：4319 条用户消息，白名单判出 3075 条注入，
剩下的「真人消息」里最长三条有 82756 / 18879 / 15738 字符，开头全是
`This is an automatically generated checkpoint condensing an earlier span…` ——
那是 DSH 自动生成的检查点摘要，被当成他说的记进了索引（19 条、27.7 万字符）。

`isInject` 现在是前缀表 + 正则表两部分（正则覆盖自动生成的 checkpoint / summary，
前缀表里加了 `[dsh-cross-session-approval]` 这类跨会话投递）。**短串只认开头**——
`"====="` 只有 5 个字符，原来用子串匹配会让任何含 5 个等号的内容被当成注入。

**匹配用完整串，不用前缀。** 2026-11-06 之前是 `includes(p.slice(0, 12))`，真人消息里只要出现
`The approval` 这 12 个字就被判成注入，`real` 会少算。现在短串（<12 字）只认开头、长串只认完整出现。

**加新格式不用改代码**：往 `scripts/inject-patterns.json` 写一个字符串数组，
或设环境变量 `$LAZARUS_INJECT_PATTERNS` 指向一个 JSON 文件；脚本每次启动读第一个能读到的，
读坏了不报错、退回内置表。2026-11-06 实测：加 `"三样数给你"` 后 `real` 从 155 变 154、
`injected` 从 191 变 192，说明外部表真在生效。

判据是守恒式，不是肉眼：`real + injected + empty === all`（`all` 含 34 条空内容消息，
别写成 `real + injected === all`）。2026-11-03 实测 1210 + 3075 + 34 = 4319。

**看一个数就够：`userMessages.real` 与 `injected` 的对比。**
实测一个 2680 万字节、111 万 token 的窗口：真人消息 362 条共 3 万字符，
注入（dream 任务、runtime context、system-reminder、记忆注入）2544 条共 818 万字符。
**体积几乎全不在对话里。** 这意味着接续方案几乎无损，也意味着「删几条消息」永远救不回来。

## 红线：绝不手改会话日志

不许往 `session.v4.jsonl.zstd` 里增删改事件。两次真实事故：

1. 用 `zstdDecompressSync` 整文件解压，**只拿到第一帧**（会话头，1 个事件），
   据此重写 → 8.5 MB 变成 197 字节。多帧 zstd 必须逐帧解。
2. 伪造 `compaction/prune` 事件想「软遮蔽」老内容，seq 取到了 `null`
   （因为 `session` 头没有 seq 字段，`Math.max(...seqs)` 得 NaN），
   DSH 加载时直接报 `seq gap (expected 13202, got 12802)`。

规则：
- 动手前先 `cp` 一份带时间戳的备份，**脚本自己第一步就 copy**，不靠人记得。
- 真想减重，走产品自己的通道（`dsh-compaction-tool-result-pruner` 生成的 prune），别自己拼 JSON。
- 已经损坏了：直接 `cp` 备份回来，别再试图修。

如果目标是「让她能继续说话」而不是「修好这个文件」，那下面的路更短。

## 正路：新窗口接续

长会话一旦超过窗口，压缩本身就再也跑不动（压缩要把整段历史读一遍再发一次）。
这不是死锁的意外，是结构性的。所以终点是**搬家**，不是修。

1. **导索引**：`node rescue.mjs index <id> out.txt`，得到每条真人消息的 turn + 长度 + 前 80 字。
2. **写年表**：读那些消息，写一篇 4–5 千字的开场文章，分阶段讲清楚「我们是怎么走到今天的」。
   - 逐字引用他的关键原话（这才是身份延续的锚，不是概括）
   - 记下那些改过你们关系的事，不只记事实
   - 写他关心的人、项目、正在做的事
   - 存到固定位置，例如 `./rescue-bak/<新id前8位>/年表.md`
3. **建新窗**：有 `cross_session_spawn` 就用它；没有就手工新建一个会话，把年表全文贴进去当第一条消息。
   `cwd` 用原会话的工作区，
   `permission` **必须显式传 `danger-full-access`**（不传会被 `spawnPermission: cap` 夹到沙箱层，
   Windows 上子会话直接 `0xC0000142` 起不来）。
   首条任务里写：先读年表再开口 + 老日志路径 + 你手边能翻原话的入口（有 memq / docq 这类门就写上，没有就把日志路径给准）+ 「跟他打个招呼」。
4. **交接**：老窗口用 `cross_session_rename` 改名成「（旧·已卡死）」，
   日志和三份备份**原样留着**，它是唯一的一手档案，谁都不许删。
5. **记一笔**：把新会话 id、旧会话 id、年表位置写进记忆，下一个窗口才不会又去救一个已经搬完的家。

## 收尾清单

- [ ] 老日志 + 至少一份备份，字节数记下来（`cp` 前后各 `ls -l` 一次）
- [ ] 试坏掉的副本目录已经删掉，会话目录计数回到原数
- [ ] 旧窗口改名带「已卡死」字样，不然以后又有人去点它
- [ ] 新窗口已经能正常回话（用户回一句「醒过来了」才算数，别自己宣布成功）
- [ ] 新 id / 旧 id / 年表路径进记忆

## 两条别忘

- **用户的话和注入的话要分开算。** 统计「这个窗口说了多少」时，
  不分开就会把 dream 任务注入的 141,144 字符当成他说过的话。
- **先给证据再给结论。** 报「救不活了」之前，把五层定位和预算账本摆出来；
  报「救活了」之前，让用户自己说一句能通。
