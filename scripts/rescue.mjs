#!/usr/bin/env node
// rescue.mjs —— 卡死会话的体检与导出。配套技能 lazarus（拉撒路）。
//
// 用法：
//   node rescue.mjs scan   <sid|日志路径>    体积账本 + 注入占比 + 预算 + 最后的错误
//   node rescue.mjs talk   <sid|路径> [out]  按 turn 导出 user/ai 对话文本
//   node rescue.mjs index  <sid|路径> [out]  导出用户消息索引（带本地时间，先看这个再写年表）
//   node rescue.mjs verify <年表.md> <sid|路径>  核对年表里「」框的原话是否真出自他口中
//   node rescue.mjs health [--window N]      所有会话离窗口还有多远（提前发现快死的那扇）
//
// sid 可以是会话 id 的前缀（如 b516a1f7），也可以直接给 .jsonl.zstd 的绝对路径。
// 只读，不写任何日志。
//
// 零依赖：只用 node 标准库（node >= 22.13 才有 zstdDecompressSync）。
// 会话日志默认在 ~/.dsh/sessions，可用环境变量 DSH_SESSIONS 覆盖。
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { zstdDecompressSync } from "node:zlib";

const SESSIONS = process.env.DSH_SESSIONS || join(homedir(), ".dsh", "sessions");

/** 会话日志文件名：不锁定版本号，v3/v4/v5 一律照收。 */
const SESSION_RE = /^session\..+\.jsonl\.zstd$/;

/** zstd 帧魔数。日志是**多帧**的，整文件解压只会拿到第一帧。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd → 行数组。 */
function decompressFrames(buf) {
  const frames = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    const n = buf.indexOf(MAGIC, i + 4);
    frames.push(buf.subarray(i, n === -1 ? buf.length : n));
    i = n;
  }
  const lines = [];
  const failedFrames = [];
  frames.forEach((f, idx) => {
    try {
      lines.push(...zstdDecompressSync(f).toString("utf8").split("\n"));
    } catch {
      // 记帧号：只报"坏了几帧"定位不了。帧是按魔数顺序切的，序号能回指到那一段事件
      failedFrames.push(idx);
    }
  });
  return { lines, frames: frames.length, failed: failedFrames.length, failedFrames };
}

/** 读一个会话日志，返回事件数组（原样，不做 schema 改写）。 */
function readSession(file) {
  const { lines, frames, failed, failedFrames } = decompressFrames(readFileSync(file));
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 半行或坏行：跳过，不因一行坏掉整份日志 */
    }
  }
  const head = events.find((e) => e.type === "session");
  return { file, events, frames, failed, failedFrames, declaredVersion: head?.version ?? null, meta: head ?? null };
}

function readEvents(file) {
  return readSession(file).events;
}

/** 列出所有会话日志文件。 */
function listSessionFiles(root = SESSIONS) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const ws of readdirSync(root)) {
    const wp = join(root, ws);
    let wsStat;
    try {
      wsStat = statSync(wp);
    } catch {
      continue;
    }
    if (!wsStat.isDirectory()) continue;
    for (const sid of readdirSync(wp)) {
      const sd = join(wp, sid);
      let sdStat;
      try {
        sdStat = statSync(sd);
      } catch {
        continue;
      }
      if (!sdStat.isDirectory()) continue;
      for (const name of readdirSync(sd)) {
        if (!SESSION_RE.test(name)) continue;
        const file = join(sd, name);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        out.push({ session: sid, ws, file, name, bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

const INJECT = [
  "可能相关的记忆，仅供参考",
  "Current runtime context",
  "Time sampled while preparing turn",
  "[meow-memory-reflect]",
  "[meow-memory-dream]",
  "<system-reminder>",
  "The approval policy changed",
  "[dsh-cross-session-approval]",
  "=====",
];

// 自动生成的检查点摘要。2026-11-03 实测老窗里有 19 条、最长 82756 字，
// 因为不在这张表里，被当成"他说的"记进了用户消息索引。
const INJECT_RE = [
  /^This is an automatically generated checkpoint condensing/i,
  /^This is an automatically generated summary of/i,
];

/** 一条 user/message 是注入还是他真说的。
 *  短串（"=====" 只有 5 个字符）只认开头：子串匹配会让任何含 5 个等号的内容被当成注入。 */
function isInject(t) {
  if (!t) return false;
  for (const p of INJECT) {
    if (t.startsWith(p)) return true;
    if (p.length >= 12 && t.includes(p.slice(0, 12))) return true;
  }
  return INJECT_RE.some((re) => re.test(t));
}

function resolveTarget(arg) {
  if (!arg) throw new Error("缺参数：sid 前缀或日志路径");
  if (/\.jsonl\.zstd/.test(arg)) {
    if (!existsSync(arg)) throw new Error(`文件不存在：${arg}`);
    return arg;
  }
  const all = listSessionFiles().filter((s) => s.session.includes(arg));
  if (!all.length) throw new Error(`没找到会话：${arg}（日志根目录 ${SESSIONS}）`);
  all.sort((a, b) => b.mtime - a.mtime);
  return all[0].file;
}

/** 把 content / message 统一摊成纯文本。 */
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.content === "string") return v.content;
    if (Array.isArray(v.content)) return v.content.map(textOf).join("");
    if (typeof v.arguments === "string") return v.arguments;
  }
  return "";
}


function scan(file) {
  const { events, frames, failed, failedFrames, declaredVersion } = readSession(file);
  if (failed > 0) {
    const shown = failedFrames.slice(0, 10).join(", ");
    console.error(
      "[警告] " + file + " 有 " + failed + "/" + frames + " 帧解压失败（帧号 " + shown +
        (failedFrames.length > 10 ? " …" : "") + "）。这些帧里的事件没被读进来，下面的账是少的。",
    );
  }
  const seqs = events.map((e) => e.seq).filter(Number.isFinite);
  const turns = new Set();
  const chars = {};
  const userMsgs = [];
  let reasoningChars = 0;
  let textChars = 0;
  let toolCallChars = 0;

  for (const e of events) {
    if (e.data?.turn != null) turns.add(e.data.turn);
    const t = e.type;
    if (t === "user/message") {
      const s = textOf(e.data?.content) || textOf(e.data?.message);
      chars[t] = (chars[t] ?? 0) + s.length;
      userMsgs.push(s);
    } else if (t === "tool/result") {
      const s = textOf(e.data?.content) || textOf(e.data?.message) || textOf(e.data?.result);
      chars[t] = (chars[t] ?? 0) + s.length;
    } else if (t === "assistant/message") {
      for (const b of e.data?.message?.content ?? []) {
        const n = textOf(b).length;
        if (b.type === "reasoning") reasoningChars += n;
        else if (b.type === "text") textChars += n;
        else if (b.type === "tool-call") toolCallChars += n;
      }
    }
  }

  const real = userMsgs.filter((s) => s && !isInject(s));
  const injected = userMsgs.filter((s) => s && isInject(s));
  const dream = userMsgs.filter((s) => s.includes("[meow-memory-dream]"));

  const errors = events
    .filter((e) => e.type === "compaction/end" && e.data?.error)
    .slice(-5)
    .map((e) => ({ seq: e.seq, error: String(e.data.error).slice(0, 400) }));
  const lastHeaders = events.filter((e) => e.type === "request/header").slice(-1);
  const maxTokens = lastHeaders[0]?.data?.config?.maxTokens ?? null;

  const totalChars =
    Object.values(chars).reduce((a, b) => a + b, 0) + reasoningChars + textChars + toolCallChars;

  return {
    file,
    bytes: statSync(file).size,
    version: declaredVersion,
    frames,
    events: events.length,
    seqRange: seqs.length ? [Math.min(...seqs), Math.max(...seqs)] : null,
    seqCount: new Set(seqs).size,
    turns: turns.size,
    byTypeChars: chars,
    assistantBlocks: { reasoning: reasoningChars, text: textChars, toolCall: toolCallChars },
    totalChars,
    framesFailed: { count: failed, indexes: failedFrames.slice(0, 20), total: frames },
    userMessages: {
      all: userMsgs.length,
      real: real.length,
      realChars: real.reduce((a, b) => a + b.length, 0),
      injected: injected.length,
      injectedChars: injected.reduce((a, b) => a + b.length, 0),
      dreamTaskCount: dream.length,
      dreamTaskChars: dream.reduce((a, b) => a + b.length, 0),
      // 最长 5 条"真人"消息的开头：注入污染几乎总藏在最长的那些里，人眼扫这个最快
      realPreview: [...real]
        .sort((a, b) => b.length - a.length)
        .slice(0, 5)
        .map((s) => ({ len: s.length, head: s.slice(0, 80) })),
    },
    lastCompactionErrors: errors,
    completionReserved: maxTokens,
    budget:
      maxTokens == null
        ? "拿不到 maxTokens（这份日志里没有 request/header），按 256000 估"
        : {
            messagesCap: 1048576 - maxTokens,
            note: "上游 400 的判据是 messages + completion ≤ 1048576",
          },
  };
}

function collect(file) {
  const events = readEvents(file);
  const rows = [];
  let cur = null;
  let turn = null;
  for (const e of events) {
    if (e.type === "turn/start") turn = e.data?.turn ?? turn;
    if (e.type === "user/message") {
      const s = textOf(e.data?.content) || textOf(e.data?.message);
      if (!s || isInject(s)) continue;
      cur = { turn: e.data?.turn ?? turn, seq: e.seq, time: e.time, user: s, ai: [] };
      rows.push(cur);
    } else if (e.type === "assistant/message" && cur) {
      const s = (e.data?.message?.content ?? [])
        .filter((b) => b.type === "text")
        .map(textOf)
        .join("");
      if (s) cur.ai.push(s);
    }
  }
  return rows;
}

function talk(file, outPath) {
  const rows = collect(file);
  const md = rows
    .map(
      (r) =>
        `### turn ${r.turn} (seq ${r.seq})\n**他**：${r.user}\n\n**我**：${r.ai.join("\n") || "（无正文）"}\n`,
    )
    .join("\n");
  if (outPath) writeFileSync(outPath, md.endsWith("\n") ? md : md + "\n", "utf8");
  return outPath ? `已写 ${outPath}（${rows.length} 轮，${md.length} 字符）` : md;
}

/** 毫秒时间戳 → 本地 `MM-DD HH:MM`。写年表时「隔了多久」比「第几轮」有用得多。 */
function fmtTime(ms) {
  if (!Number.isFinite(ms)) return "  --  --:--";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function index(file, outPath) {
  const rows = collect(file);
  const txt = rows
    .map(
      (r, i) =>
        `${String(i + 1).padStart(3, "0")} t${String(r.turn).padEnd(4)} ${fmtTime(r.time)} ${String(r.user.length).padStart(5)} ${r.user.slice(0, 80).replace(/\s+/g, " ")}`,
    )
    .join("\n");
  if (outPath) writeFileSync(outPath, txt.endsWith("\n") ? txt : txt + "\n", "utf8");
  return outPath ? `已写 ${outPath}（${rows.length} 条，${txt.length} 字符）` : txt;
}

/**
 * 年表自检：从年表里抽出被引号框住的原话，逐条回老日志核对「真有这句」。
 *
 * 为什么只核「有没有」而不用模型问新窗：新窗认不认得，最终还是要人看一眼；
 * 而「这句到底是不是他说的」是可以完全自动化的——核不上就说明年表里编了话。
 */
function verify(args) {
  const [timelinePath, target] = args;
  if (!timelinePath || !target) throw new Error("用法：node rescue.mjs verify <年表.md> <sid前缀|日志路径>");
  if (!existsSync(timelinePath)) throw new Error(`年表不存在：${timelinePath}`);
  const file = resolveTarget(target);
  const rows = collect(file);

  // 真人原话拼成一个大池子，按「连续子串」判断。逐条 contains 比 N×M 比对省得多。
  const pool = rows.map((r) => r.user).join("\u0000");
  // 比对前两边都归一化：剥掉 markdown 标记、把弯引号拉直、压空白。
  // 不这么做的话，「**原文**」这种把加粗写进引号内的引用会被判成编造——
  // 那是格式差异，不是虚构。归一化只抹格式，不动字。
  const norm = (s) =>
    String(s)
      .replace(/\*\*|__|`/g, "")
      .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      // 空白整个删掉而不是压成一个空格：他的原话常带换行，年表里写成一句，
      // 压成空格反而对不上（2026-11-03 实测 6 条引文全卡在这一处）。
      .replace(/[\s\u3000]+/g, "");
  const poolNorm = norm(pool);

  const md = readFileSync(timelinePath, "utf8");
  const quotes = [];
  const seen = new Set();
  for (const m of md.matchAll(/「([^」]+)」/g)) {
    const q = norm(m[1]);
    if (q.length < 6) continue; // 太短的（人名、单字）不具判别力
    if (seen.has(q)) continue;
    seen.add(q);
    quotes.push(q);
  }

  // 年表里的引用常常是「原文前半句 + …」的截断版，整串比对会把这类
  // 判成编造。所以按省略号切段：全段命中算 strict，任一段命中算 partial，
  // 一段都不中才是真的核不上（那才是要人看的地方）。
  const SPLIT = /(?:…+|\.{3,}|。\s*\.\.\.)/;
  const hits = [];
  const partial = [];
  const misses = [];
  for (const q of quotes) {
    if (poolNorm.includes(q)) {
      hits.push(q);
      continue;
    }
    const segs = q
      .split(SPLIT)
      .map((s) => s.replace(/[，、；：,;:]+$/, "").trim())
      .filter((s) => s.length >= 6);
    const got = segs.filter((s) => poolNorm.includes(s));
    if (got.length) partial.push({ quote: q, matchedSegments: got.length, segments: segs.length });
    else misses.push(q);
  }
  return {
    file,
    timeline: timelinePath,
    quotes: quotes.length,
    strictHits: hits.length,
    partialHits: partial.length,
    misses: misses.length,
    // 宽松命中率：截断的引用只要有一段对得上就算「有出处」
    hitRate: quotes.length ? Number(((hits.length + partial.length) / quotes.length).toFixed(3)) : null,
    strictRate: quotes.length ? Number((hits.length / quotes.length).toFixed(3)) : null,
    partial: partial.slice(0, 10),
    missing: misses.slice(0, 30),
  };
}

/**
 * 全部会话的「离窗口还有多远」。默认窗口 1048576。
 *
 * 优先读 billion-context 的 index.db（它有本地估算的 contextTokens），
 * 读不到就按日志字符数粗估——粗估不准，但足以把最危险的那几个排到前面。
 */
function health(opts) {
  const window = Number(opts.window) || 1048576;
  const rows = [];
  let source = "估算（index.db 不可用）";

  const dbPath = join(homedir(), ".local", "share", "billion-context", "sessions", "index.db");
  const fromDb = new Map();
  if (existsSync(dbPath)) {
    try {
      // node:sqlite 是内置模块；拿不到就退回估算，不让整条命令失败。
      const { DatabaseSync } = require_db();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      // 只认主行：同一个会话下面还有一堆 |sub:<id> 的子代理行，它们的
      // contextTokens 可能是另一个数量级（实测大姐主行 2736、某个 sub 行 1635086），
      // 混在一起会把「谁快撑爆了」排错。
      for (const r of db.prepare("select session_id, label, updated_at, stats_json from sessions").all()) {
        if (String(r.session_id).includes("|sub:")) continue;
        const s = JSON.parse(r.stats_json || "{}");
        const ctx = Number(s.contextTokens);
        if (Number.isFinite(ctx) && ctx > 0) {
          fromDb.set(r.session_id, {
            contextTokens: ctx,
            updatedAt: r.updated_at,
            source: s.contextTokensSource || "?",
            requests: Number(s.requests) || 0,
            lastInputTokens: Number(s.lastInputTokens) || 0,
            localEstimate: Number(s.localInputEstimate) || 0,
          });
        }
      }
      db.close();
      if (fromDb.size) source = "billion-context index.db";
    } catch {
      /* 读不动就退回估算 */
    }
  }

  for (const s of listSessionFiles()) {
    const hit = fromDb.get(s.session);
    let ctx = hit?.contextTokens;
    let src = hit?.source;
    let estimateChars = 0;
    if (!Number.isFinite(ctx)) {
      try {
        const ev = readEvents(s.file);
        let chars = 0;
        for (const e of ev) {
          if (e.type === "user/message" || e.type === "tool/result") chars += textOf(e.data?.content ?? e.data?.message ?? e.data?.result).length;
          else if (e.type === "assistant/message") for (const b of e.data?.message?.content ?? []) chars += textOf(b).length;
        }
        // 注意：这里累加的是**全部历史**，不是当前上下文。实测 71 MB 的日志 totalChars 4000 万，
        // 估出 3600 万 token，对 104 万窗口高估三十多倍。只是读不到 index.db 时的兜底。
        ctx = Math.ceil(chars * 0.9);
        src = "估算（全历史累加，仅兜底）";
        estimateChars = chars;
      } catch {
        // 读不动就别猜：日志是 zstd 压缩过的，拿压缩后的字节数换算上下文
        // 会离谱到几千万（实测 78 MB 的日志算出 2348 万 token）。
        // 标「未知」比给一个错的数好——错的数会被当成结论。
        ctx = null;
        src = "未知（日志读不动）";
      }
    }
    const known = Number.isFinite(ctx);
    // level 回答的是「离爆还有多远」，所以要用真正会进窗口的量：contextTokens 和
    // localEstimate 谁大取谁。两个数谁大不固定（实测有 287K/536K 的，也有 331K/305K 的），
    // 只看一个会漏。used 保留原来的 contextTokens 口径，不动——两个数并列才看得出差异。
    const est = hit?.localEstimate ?? 0;
    const ctxVal = known ? ctx : 0;
    const pressureTokens = Math.max(ctxVal, est) || null;
    const pressure = pressureTokens === null ? null : Number((pressureTokens / window).toFixed(3));
    const levelSrc = pressureTokens === null ? null : est > ctxVal ? "est" : "ctx";
    const levelText = pressure === null ? "未知" : pressure >= 0.8 ? "危险" : pressure >= 0.6 ? "偏高" : "正常";
    const level = levelSrc === null ? levelText : levelText + " (" + levelSrc + " " + pressure + ")";
    const usageOnly = known && src === "usage"; // billion-context 用 usage 时记的是「最近一次请求」
    rows.push({
      session: s.session,
      bytes: s.bytes, // 日志体积 = 这扇窗的历史总量，不是当前上下文，不参与 used 计算
      mtimeMs: s.mtime,
      contextTokens: known ? ctx : null,
      requests: hit?.requests ?? 0,
      lastInputTokens: hit?.lastInputTokens ?? 0,
      localEstimate: hit?.localEstimate ?? 0,
      window,
      pressure,
      used: known ? Number((ctx / window).toFixed(3)) : null,
      level,
      tokensSource: src,
      estimateChars: estimateChars || undefined,
      note: usageOnly
        ? "这个数来自最近一次请求的 usage，不等于当前上下文大小；要判真实占用看日志体积与压缩记录"
        : estimateChars
          ? "这个数把全部历史字符累加后估算（" + estimateChars + " 字符），不是当前上下文；对窗口比只能用来排序，别当预算依据"
          : undefined,
    });
  }
  // 排序按 pressure（真实压力），不是 used（消息面）。health 的用途是先把最危险的捞出来。
  rows.sort((a, b) => (b.pressure ?? -1) - (a.pressure ?? -1));
  return { window, source, count: rows.length, sessions: rows };
}

/** node:sqlite 在旧版 node 上不存在，用 require 动态取，取不到就抛出由调用方兜住。 */
function require_db() {
  return createRequire(import.meta.url)("node:sqlite");
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
try {
  if (cmd === "health") {
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--window") opts.window = rest[++i];
    }
    console.log(JSON.stringify(health(opts), null, 2));
  } else if (cmd === "verify") {
    console.log(JSON.stringify(verify(rest), null, 2));
  } else {
    const [arg, out] = rest;
    // 只认 scan/talk/index 才去解析目标：命令行空着时要打印用法，而不是报"缺参数"
    const file = ["scan", "talk", "index"].includes(cmd) ? resolveTarget(arg) : null;
    if (cmd === "scan") console.log(JSON.stringify(scan(file), null, 2));
    else if (cmd === "talk") console.log(talk(file, out));
    else if (cmd === "index") console.log(index(file, out));
    else
      console.log(
        [
          "用法：",
          "  node rescue.mjs scan   <sid前缀|日志路径>          体检 + 预算",
          "  node rescue.mjs index  <sid前缀|日志路径> [out.txt] 用户消息索引（带时间）",
          "  node rescue.mjs talk   <sid前缀|日志路径> [out.md]  按 turn 导出双方正文",
          "  node rescue.mjs verify <年表.md> <sid前缀|日志路径> 核对年表里的引号原话是否真出自他口中",
          "  node rescue.mjs health [--window N]                所有会话离窗口还有多远",
        ].join("\n"),
      );
  }
} catch (e) {
  console.error("失败：", e.message);
  process.exit(1);
}
