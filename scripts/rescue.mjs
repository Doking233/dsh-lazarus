#!/usr/bin/env node
// rescue.mjs —— 卡死会话的体检与导出。配套技能 lazarus（拉撒路）。
//
// 用法：
//   node rescue.mjs scan  <sid|日志路径>    体积账本 + 注入占比 + 预算 + 最后的错误
//   node rescue.mjs talk  <sid|路径> [out]  按 turn 导出 user/ai 对话文本
//   node rescue.mjs index <sid|路径> [out]  导出用户消息索引（先看这个再写年表）
//
// sid 可以是会话 id 的前缀（如 b516a1f7），也可以直接给 .jsonl.zstd 的绝对路径。
// 只读，不写任何日志。
//
// 零依赖：只用 node 标准库（node >= 22.13 才有 zstdDecompressSync）。
// 会话日志默认在 ~/.dsh/sessions，可用环境变量 DSH_SESSIONS 覆盖。
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
  let failed = 0;
  for (const f of frames) {
    try {
      lines.push(...zstdDecompressSync(f).toString("utf8").split("\n"));
    } catch {
      failed++;
    }
  }
  return { lines, frames: frames.length, failed };
}

/** 读一个会话日志，返回事件数组（原样，不做 schema 改写）。 */
function readSession(file) {
  const { lines, frames, failed } = decompressFrames(readFileSync(file));
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
  return { file, events, frames, failed, declaredVersion: head?.version ?? null, meta: head ?? null };
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
  "=====",
];

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

const isInject = (t) => INJECT.some((p) => t.startsWith(p) || t.includes(p.slice(0, 12)));

function scan(file) {
  const { events, frames, declaredVersion } = readSession(file);
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
    userMessages: {
      all: userMsgs.length,
      real: real.length,
      realChars: real.reduce((a, b) => a + b.length, 0),
      injected: injected.length,
      injectedChars: injected.reduce((a, b) => a + b.length, 0),
      dreamTaskCount: dream.length,
      dreamTaskChars: dream.reduce((a, b) => a + b.length, 0),
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
      cur = { turn: e.data?.turn ?? turn, seq: e.seq, user: s, ai: [] };
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
  if (outPath) writeFileSync(outPath, md, "utf8");
  return outPath ? `已写 ${outPath}（${rows.length} 轮，${md.length} 字符）` : md;
}

function index(file, outPath) {
  const rows = collect(file);
  const txt = rows
    .map(
      (r, i) =>
        `${String(i + 1).padStart(3, "0")} t${r.turn} ${String(r.user.length).padStart(5)} ${r.user.slice(0, 80).replace(/\s+/g, " ")}`,
    )
    .join("\n");
  if (outPath) writeFileSync(outPath, txt, "utf8");
  return outPath ? `已写 ${outPath}（${rows.length} 条，${txt.length} 字符）` : txt;
}

const [cmd, arg, out] = process.argv.slice(2);
try {
  const file = resolveTarget(arg);
  if (cmd === "scan") console.log(JSON.stringify(scan(file), null, 2));
  else if (cmd === "talk") console.log(talk(file, out));
  else if (cmd === "index") console.log(index(file, out));
  else console.log("用法：node rescue.mjs <scan|talk|index> <sid前缀|日志路径> [输出文件]");
} catch (e) {
  console.error("失败：", e.message);
  process.exit(1);
}
