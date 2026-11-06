# 变更记录

按日期倒序。格式借 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的分组，
但本项目还没发版本号，所以用日期分段，不用 `v1.2.3`。

README 讲「怎么用、为什么这么设计」，这里只记「哪天动了什么」。
两边分工：想知道某个数为什么长这样，去 README；想知道它是哪次改出来的，来这里。

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
