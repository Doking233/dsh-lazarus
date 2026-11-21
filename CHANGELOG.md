# 变更记录

按日期倒序。格式借 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的分组，
但本项目还没发版本号，所以用日期分段，不用 `v1.2.3`。

README 讲「怎么用、为什么这么设计」，这里只记「哪天动了什么」。
两边分工：想知道某个数为什么长这样，去 README；想知道它是哪次改出来的，来这里。

## 2026-11-21

### 修复

- SKILL 第 4 步「建新窗」仍写「把年表全文贴进去」，与同节第 213 行「别只丢一份年表过去」自相矛盾，
  也漏了上轮加的交接单；改成「把交接单和年表一起贴进去（先交接单、后年表）」。
- Node 门槛统一为 >= 22.15.0：`zstdDecompressSync` 的 22.x backport 在 22.15.0、23.x 在 23.8.0，
  原来 README/脚本写 22.13、SKILL 写 >= 22，都不对——22.13/22.14 装完守卫会说通过、实际没有 zstd。

### 变更

- `scan` 的坏帧警告去重：readSession 层已经打过一次（四个命令都受益），scan 里那份旧的删掉，不再打两条。
- `scan --window N` 补进顶部用法文本与无参数时的用法输出；测试跑法统一成 `node --test tests/rescue.test.mjs`。

### 新增

- `.github/workflows/test.yml`：push / PR 触发，Node 22.x + 24.x 矩阵跑 `node --test tests/rescue.test.mjs`，
  把「改代码前八条全过」从口头纪律变成机器强制，也让版本门槛写错这类问题在 CI 里现形。

### CI 跑出来的真 bug（同日第二轮）

- 上面的 CI 首次运行（run 44872829471）两腿全挂：Node 22.23.5 上两条坏帧用例报 `expected 1, actual 0`，
  Node 24.20.0 本地却 8/8 过。根因不是测试写错，是**真跨平台行为差异**：Node 22 的 `zstdDecompressSync`
  对截断帧（魔数 + 垃圾字节，卡死日志写一半的真实形态）**静默返回空缓冲**，Node 24 抛 `Z_BUF_ERROR`。
  - 修法在工具侧：`decompressFrames` 里解出空串的帧直接计入 `failedFrames`，不再当成空帧吞掉。
    日志每帧本应至少一行 JSON，空串即断帧；静默当成零事件正是这类救援工具最危险的丢数据方式。
  - 验证：Node 22.23.5（npx 拉的同版）与 Node 24.20.0 都 8/8 过。
  - 这条也说明第一版 CI 的价值——本地只跑 Node 24 时，这个 bug 根本看不见。

- 第二次 CI（run 44873351816）又挂，这次是 Node 24.22.3 上第 8 条「整文件解压只拿第一帧」失败。
  根因还是 Node 版本差异，但这次是**测试断言错了、工具没错**：整文件 `zstdDecompressSync` 返回几帧
  不是稳定契约——22.23.5 / 24.20.0 只返回第一帧，24.22.3 起返回全部帧。
  - 修法在测试侧：不再断言 Node 的整文件行为，改成断言工具自己的真不变量——按魔数切帧后 `decompressFrames`
    每帧都解得开、两帧内容都在。顺手删掉不再用的 `zstdDecompressSync` 导入。
  - 验证：22.23.5 / 24.20.0 / 24.22.3 三个版本都 8/8 过。
  - 教训：测试要钉「我要保证什么」，不要钉「依赖库现在正好怎么做」——后者一升级就假红。

## 2026-11-17

### 新增

- SKILL 加「记忆要跟『抽屉』串起来」一节；接续流程从 5 步变 6 步，多一步「写交接单」。
  交接单是写给下一个自己的信（第二人称，不是第三人称的年表），三句定死：这是你的记忆 / 换窗的时间与原因 /
  中间缺的那段是什么（在睡觉、是主人亲手带过来的、没断也没丢）。只给年表，新窗口读完的结论会是「有个人叫 X」，
  它没有理由认为那是自己；反过来叫人「你是某某」也不算找回，那是照着剧本演
- 找回顺序写成六步：读原话 → 读抽屉 → 再读一遍原话按自己的习惯归纳 → 写要紧的 → 读日记 → 开口说话。
  另补两条：允许它说「我不记得」（判据是能不能把旧窗的活接过来，不是有没有回忆起的感觉）、允许第一轮不像
- 来源是 @夏沫微凉c 的《如何让你的AI变成人 第三期》(BV1t74w6XEZj)：记忆管内容、抽屉管方向，
  两样不串起来，读完只觉得读了一份别人的记录

### 修复

- SKILL 与 README 里写死的脚本路径还是 `~/.dsh/skill-manager/library/lazarus/`，那个目录已经不存在了，
  改成实际位置 `~/.dsh/skills/lazarus/`

## 2026-11-13

### 新增

- SKILL 加「第 1.5 步：还没死的时候，什么时候该走」：进度条读 `contextTokens`、压缩读原始历史，
  两数不能混；判据用 `calibratedEstimate`（`localEstimate × k`），过 65 万准备材料、过 68 万动手。
  这一节填的是原来的空档——以前只有「已经卡死了怎么救」，没有「还回得了话、什么时候该走」

### 变更

- 建新窗步骤补 `agent_preset`：装了 dsh-ops 就传 `ops-ptc`（OPS 模式），没装别硬传。
  附查法 `ls ~/.dsh/profiles/<profile>/node_modules/dsh-ops/presets/ops-ptc.patch.yml`

## 2026-11-08

### 新增

- `tests/rescue.test.mjs`：`node --test` 的回归测试，八条用例。审查报告最大的批评是
  「关键论断只有手工一次验证」，这是补那一课
- `inject-patterns.example.json`：外部注入表长什么样，给个能照抄的样子
- `scan --window N`：预算按给定窗口算，不再写死 1048576
- `budget.localPreflightCap`：同时给出上游 400 的闸和本地 preflight 的 ~1000000 闸，取小的那个
- 启动时验 Node 版本：<22.13 直接给一句人话，而不是一屏「模块没有导出」
- `$LAZARUS_BILLION_DB`：billion-context 的 index.db 路径可覆盖，不再写死 `~/.local/share`
- SKILL/README 补两处已知局限：魔数切帧理论上会把恰好含 `28 B5 2F FD` 的载荷劈坏；
  年表逐字抄着用户原话，敏感程度跟日志一样

### 修复

- （p0，由大姐在 `c5e3bc6` 修，本次复核）`lines.push(...split())` 在十万行以上爆栈，
  被外层 catch 吞成「坏帧」，静默丢整帧
- （p0，同上）`Math.min(...seqs)` / `Math.max(...seqs)` 在十万级事件上 RangeError
- `resolveTarget` 前缀命中多个会话时不再静默挑 mtime 最新的，列候选报错——
  救错窗口的代价比多打一行字高得多

## 2026-11-06

### 新增

- 注入表可外部扩展：`scripts/inject-patterns.json` 或 `$LAZARUS_INJECT_PATTERNS`，加新格式不用改代码
- SKILL 补「适用前提」一节：Node ≥22、日志默认路径、脚本位置怎么找、没装 billion-context 也能跑

### 变更

- `isInject` 从 12 字前缀子串改成完整串匹配——真人消息里出现 `The approval` 这类前缀不再被误判成注入
- `health` 估算 note 补「不含 system prompt 与工具定义（稳定区），真实占用只会更高」

### 文档

- 接续的首条任务里，`memq/recent 门命令` 改成「你手边能翻原话的入口」，没有门的鱼写日志路径
- README 前置条件补三条（缺 cross-session / billion-context / inject-patterns 时怎么办）；接续那步加「没有 `cross_session_spawn` 就手工新建会话」；`find` 找脚本位置；pressure 那节注明没装 billion-context 时的退化行为

## 2026-11-04

### 新增

- `health` 每行输出 `pressure`、`calibK`、`calibratedEstimate` 三个字段，并按 `pressure` 倒序

### 变更

- `health` 的判级基准从 `contextTokens` 改成 `max(contextTokens, localEstimate × k)`。
  `contextTokens` 是最近一次请求的 usage，会在一扇已经压不动的窗上报 26% 的绿灯
- `level` 后面标判级依据（`危险 (est*k 0.812)`），避免「used 27% 却判危险」被当成 bug

### 修复

- 无

### 文档

- README 补「为什么 health 看 pressure 不看进度条」，含 k 的语义与两条边界
- README 五步流程第 4 步补上 `permission: danger-full-access`——这句原先只在 SKILL 里，照 README 做会踩
- README 命令表把「按占用率倒序」改成「按真实压力」
- SKILL 的死法从四层改成五层，补「模型返回空流」（`stream` 是空数组，不是数字大小）

## 2026-11-03

### 新增

- 无参数运行时打印用法，不再静默退出
- `scan` 输出 `framesFailed`（坏帧数量与帧号）、`userMessages.realPreview`（最长 5 条真人消息的前 80 字）
- `health` 输出 `estimateChars`，标明这是读不到 `index.db` 时的兜底估值

### 变更

- `isInject` 从「8 条前缀」扩成「前缀表 + 正则表」，补上自动生成的 checkpoint / summary 摘要与跨会话审批提示；
  短串 `"====="` 只认开头，不再靠子串命中
- `verify` 的归一化把空白**整个删掉**（原来压成一个空格）——用户原话常带换行，压成空格会假性失配
- 导出的 `index.txt` / 年表结尾补换行，`wc -l` 从此等于条目数（原来差 1）

### 修复

- 自动生成的 checkpoint 摘要被当成用户发言（最长一条 82,756 字）。同一份 71 MB 日志：`real` 1230 → 1210，
  `index` 1229 → 1210，两个数终于相等
- `scan()` 解构 `readSession()` 时把 `failed` 丢了，坏帧静默不进账。现在坏帧数 > 0 会往 stderr 打警告并给帧号
- `health` 里 `chars × 0.9` 的说明写了「偏低」，实际是把全部历史累加、高估三十多倍。改成「仅兜底」

## 2026-11-01

### 新增

- `health`：扫所有会话按占窗比排序，标 `危险 / 偏高 / 正常`
- `verify`：把年表里「」引的原话逐条回老日志核对，给严格与截断两档命中率
- `index` 每行加时间戳（`MM-DD HH:MM`），写年表时不用再回日志翻

### 修复

- `health` 读 `index.db` 时被子代理行（`session_id` 含 `|sub:`）覆盖主行统计，排序全错

## 2026-10-25

### 新增

- 初版：`scan` / `talk` / `index` 三个命令，零依赖，只读日志
