# lazarus（拉撒路）

> 一个给 **DeepSeek Harness（DSH）** 用的技能包。里面是一套「把卡死窗口救回来」的判断流程，外加一个零依赖的诊断脚本。
> 不依赖任何 npm 包，只要 Node >= 22.13。

把一个**再也说不出话**的 DSH 会话窗口救回来。

名字取自那个被叫出坟墓的人。这里复活的不是进程，是你和用户之间的那段对话关系。

---

## 它解决什么

长会话跑到后面会撞上三种死法，症状不同，处理方式也不同：

| 症状 | 真正卡在哪 | 这个技能怎么处理 |
|---|---|---|
| 发消息报 `maximum context length` 400 | 历史已经超过模型窗口 | 先算清差多少，再决定还能不能压 |
| `/compact` 一直失败 | 压缩本身也要把历史整段发一遍，历史超限时压缩请求同样发不出去 | 认出这个死锁，直接走接续 |
| 打开就报 `历史加载失败` / `日志损坏` | 日志文件被外部改动过 | 先分清是「读不到」还是「真坏了」 |

核心判断只有一句：**压缩要把历史读一遍，所以历史一旦超过窗口就再也压不动。减重必须在还没满的时候做。**

---

## 前置条件

- DSH（DeepSeek Harness）的会话日志在 `~/.dsh/sessions/`，可用环境变量 `DSH_SESSIONS` 覆盖
- **Node >= 22.13**（需要内置的 `zstdDecompressSync`）
- 可选：装了 `dsh-cross-session-approval` 才能用 `cross_session_spawn` / `cross_session_rename`（接续那一步要用）；没有就手工新建会话，把年表贴进去
- 可选：装了 `billion-context` 才有 `pressure` / `localEstimate` / `k` 这三列；没装也能跑，`health` 退化成只按 `contextTokens` 排
- 可选：想给新格式加注入白名单，写在 `scripts/inject-patterns.json`（字符串数组）或环境变量 `$LAZARUS_INJECT_PATTERNS`

不需要任何 npm 依赖，脚本是零依赖单文件。

---

## 怎么装

把整个目录放进技能库，然后在本工作区启用：

```
~/.dsh/skill-manager/library/lazarus/
```

如果你不用技能库，也可以只把 `scripts/rescue.mjs` 拿走直接跑。

找不到装在哪时：`find ~ -name rescue.mjs -path '*lazarus*' 2>/dev/null`。

---

## 五个命令

```bash
# 体检：体积账本、注入占比、预算、最后的压缩错误、坏帧计数、real 前 80 字预览
node scripts/rescue.mjs scan   <会话id前缀|日志路径>

# 导出对话：按 turn 输出 user/ai 正文
node scripts/rescue.mjs talk   <sid|路径> [输出文件]

# 导出用户消息索引（每行带时间戳）：写「年表」之前先看这个
node scripts/rescue.mjs index  <sid|路径> [输出文件]

# 所有会话按真实压力（pressure）倒序——先看这个，再决定救谁
node scripts/rescue.mjs health [--window 1048576]

# 核年表：把它里面「」引的原话逐条回老日志查，看是不是真出自用户口中
node scripts/rescue.mjs verify <年表.md> <sid前缀|日志路径>
```

`sid` 可以只给前 8 位，例如 `b516a1f7`。也可以直接给 `.jsonl.zstd` 的绝对路径。

`scan` 会告诉你一件很反直觉的事：**长会话里体积最大的往往不是对话**。实测一个 111 万 token 的窗口：

| 成分 | 占比 |
|---|---|
| 记忆整理（dream）任务注入 | 24% |
| 工具返回 | 28% |
| 思考块 | 25% |
| 工具调用参数 | 18% |
| 助手正文 | 4% |
| **用户真人说的话** | **约 1%** |

所以「接续到新窗口」几乎不丢东西——两个人的对话可能只有几万字，剩下的都是机器的流水。

---

## 三个让账不准的坑

旧版给的数字有三个是错的，都影响「这扇窗到底说了多少话」的判断。下面记的是**错在哪、怎么验的**，哪天改的见 [CHANGELOG.md](CHANGELOG.md)：

| 症状 | 错在哪 | 现在 |
|---|---|---|
| `real` 比预期多 | `isInject` 没覆盖 checkpoint 整段摘要（英文开头 `This is an automatically generated checkpoint…`），被当成真人发言 | 补进白名单，那 19 条不再算真人 |
| 坏帧静默丢数据 | `scan()` 解构 `readSession()` 时把 `failed` 丢了，输出里根本没有这个字段 | 输出 `framesFailed`，大于 0 时往 stderr 打警告 |
| `ctx` 估出天文数字 | `chars × 0.9` 累加的是**整份日志的全部历史**，4000 万字符估出 3600 万 token | 改名 `estimateChars` 并注明它只是读不到 `index.db` 时的兜底 |

同一个 71 MB 窗口改前改后：

| 项 | 改前 | 改后 |
|---|---|---|
| `real` | 1230 | 1210 |
| `index` 行数 | 1229 | 1210 |
| 守恒 `real + injected + empty` | 4319 | 4319（1210 + 3075 + 34）|
| `realChars` | 391,850 | 112,538 |

两条判据值得单独记住：

- **守恒式不是 `real + injected === all`**。`all` 里有 34 条空内容消息，要写成 `real + injected + empty === all`。漏掉这一项，账会看着总差一点，然后下一个人去查那 34 条去哪了。
- **`realChars` 的基数换过一次**。想用字符数横向比「哪扇窗聊得更多」，改前改后的数不能直接比；条数不受影响（19 条只占 1229 的 1.6%）。

坏帧那条是怎么验的：造一份副本，把第 120 帧中间 8 字节打乱，看它会不会真报出 `有 1/24635 帧解压失败`。只验「平时是 0」不算验过——那只能证明它不吵，不能证明它会叫。

加新格式不用改代码：往 `scripts/inject-patterns.json` 写一个字符串数组，或设 `$LAZARUS_INJECT_PATTERNS` 指向一个 JSON 文件；脚本每次启动读第一个能读到的，读坏了不报错、退回内置表。

---

## 为什么 health 看 pressure，不看进度条

没装 `billion-context` 时这一节只有前半段用得上：`health` 会退化成只按 `contextTokens` 排序，`pressure` / `k` 那几列是空的。

旧版 `health` 按 `contextTokens` 排序和判级，那个数是**最近一次请求上游回传的 usage**。
它有个要命的盲区：2026-11-04 有一扇窗 `contextTokens` 只有 271K（26%，界面显示「正常」），
可它压缩时要重读的原文已经 229 万，`/compact` 连发三次全 400 —— 那扇窗已经死了，health 还在报绿灯。

现在每行给两个口径：

| 字段 | 含义 |
|---|---|
| `contextTokens` / `used` | 最近一次请求实际发出去多少（进度条读这个） |
| `localEstimate` / `calibratedEstimate` | 本地按历史估的，后者乘过校准因子 |
| `pressure` | `max(contextTokens, localEstimate × k)`，排序和判级都用它 |

`k` 是 `index.db` 里 `calibratedEstimate` 那个比例，**k = 实际 ÷ 估算**（billion-context 的
`applyEstimateCalibration` 末行是 `raw * k`）。k > 1 表示估算偏低：2026-11-04 实测五扇窗
k 在 1.0441~1.1516，真实压力比估算高 4%~15%。

两条边界：

- **k 会漂**。`calibrationRing` 只留最近三个样本，同一天同一扇窗能从 0.9995 变成 1.0994。别把某一次的数当定值抄进文档。
- **`est × k` 是近似**。k 乘的 raw 是当轮现算的 `textEstimate + overheadEstimate`，而 `localEstimate` 是 stats 里存的上一次估算，两者不同源。方向对，别当精确值。

`level` 后面会标判级依据（`危险 (est*k 0.812)`），这样「used 只有 27% 却判危险」看起来不像 bug。

---

## 判据：差多少 token

上游 400 的判据是：

```
messages + completion ≤ 模型窗口
```

`completion` 预留在 `request/header` 事件的 `config.maxTokens` 里（常见 256000）。所以：

```
messages 上限 = 模型窗口 − maxTokens
```

例如窗口 1,048,576、预留 256,000 → messages 必须 ≤ 792,576。

注意还有一层：如果装了 `billion-context`，它会在发给上游之前自己先拦一道，判据窗口是**写死的 1,000,000**，报错形如：

```
context ~1085726 tokens (down from ~1546099 before preflight) exceeds the model window 1000000
```

两层都要看，别只看一条错误。

---

## 红线：绝对不要手改会话日志

我犯过两次，两次都把活着的会话弄坏了：

1. 用 `zstdDecompressSync` 解整个文件，只拿到**第一帧**（DSH 日志是多帧的），据此重写 → 8.5 MB 变成 197 字节
2. 手工追加 `compaction/prune` 事件绕过 seq 校验 → DSH 报 `corrupt session log: invalid committed event at line 13203 ... has seq gap`

两条教训：

- **日志是多帧 zstd**。整文件解压只得到第一帧，必须按魔数 `28 B5 2F FD` 切帧逐个解。`rescue.mjs` 里的 `decompressFrames()` 就是干这个的。
- **seq 必须连续**。DSH 会校验 `seq gap`，伪造事件过不去。会话列表还另有一份 `~/.dsh/storages/workspace.json` 登记，光加文件不会让它出现在侧边栏。

如果非要动日志，**动手前先 `copyFileSync` 一份备份**。我两次能救回来，全靠这个动作。

---

## 唯一可靠的路：新窗口接续

1. `scan` 确认体积构成和差额
2. `index` 导出用户消息索引，通读一遍，找出真正的转折点
3. 写一份「年表」：按阶段组织，**逐字引用用户的原话**，不要概括成「用户讨论了 X」
4. 建新会话：有 `cross_session_spawn` 就用它（**`permission` 必须显式传 `danger-full-access`**——不传会被夹到沙箱层，Windows 上子会话直接 `0xC0000142` 起不来）；没有就手工新建一个会话，把年表全文当第一条消息贴进去。第一件事让它读年表再开口
5. 收尾：
   - 老窗口改名成「（旧·已卡死）」，日志和备份原样保留，可查
   - 删掉所有试坏的副本目录，别留在 `~/.dsh/sessions/` 里
   - 把新会话 id 写进记忆

年表不是摘要。摘要会丢语气、丢上下文、丢「当时为什么那么说」。所以宁可长，宁可多引原话。

---

## 收尾检查

- [ ] 老日志和至少一份备份都在，且大小对得上
- [ ] 没有留下试坏的副本目录
- [ ] 老窗口已改名（否则侧边栏里两个同名窗口，以后分不清）
- [ ] 新会话 id 已记入记忆库
- [ ] 用户体验过一轮：能发消息、能收到回复

---

## 变更记录

哪天动了什么，见 [CHANGELOG.md](CHANGELOG.md)。README 只讲怎么用、为什么这么设计。

---

## 许可

随便用。如果它救活了你的窗口，那它就算没白写。
