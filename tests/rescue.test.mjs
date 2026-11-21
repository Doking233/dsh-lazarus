// 回归测试。跑法：node --test tests/rescue.test.mjs
//
// 覆盖的是 2026-11-08 审查报告里实测出来的那两个 P0：
//   1. 展开运算符在十万级事件上爆栈（算 seqRange 时）
//   2. 一帧被展开成实参时爆栈，被 catch 吞成「坏帧」，静默丢整帧数据
// 以及 P1：坏帧警告必须在 readSession 层，四个命令都能受益。
// 坏帧 fixture 故意用「截断帧」（魔数 + 几个垃圾字节），这是卡死日志被写断的真实形态；
// Node 22 的 zstdDecompressSync 对它会静默返回空串、Node 24 才抛错，
// 所以这两个用例同时钉住「工具必须自己识别空串坏帧」，不能只靠底层抛异常。
//
// fixture 全部现场造，不依赖任何真实的会话日志。
import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompressFrames, readSession, isInject, scan } from "../scripts/rescue.mjs";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把一个字符串压成一个独立的 zstd 帧。 */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, "utf8"));
}

function tmpFile(buf) {
  const dir = mkdtempSync(join(tmpdir(), "laz-test-"));
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, buf);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("多帧：两帧都解开，行数不丢", () => {
  const buf = Buffer.concat([frame('{"a":1}\n{"a":2}'), frame('{"b":1}\n{"b":2}')]);
  const r = decompressFrames(buf);
  assert.equal(r.frames, 2);
  assert.equal(r.failed, 0);
  const rows = r.lines.filter((l) => l.trim());
  assert.equal(rows.length, 4);
});

test("坏帧：只记坏的那一帧，好的照常解出来", () => {
  const good1 = frame('{"a":1}');
  const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]);
  const good2 = frame('{"b":1}');
  const r = decompressFrames(Buffer.concat([good1, bad, good2]));
  assert.equal(r.frames, 3);
  assert.equal(r.failed, 1, "坏帧数必须报出来，不能静默");
  assert.deepEqual(r.failedFrames, [1]);
  assert.ok(r.lines.filter((l) => l.trim()).length >= 2);
});

test("单帧 15 万行：不爆栈，一行不丢（原 P0-2）", () => {
  const N = 150000;
  const lines = [];
  for (let i = 0; i < N; i++) lines.push(`{"type":"x","seq":${i}}`);
  const r = decompressFrames(frame(lines.join("\n")));
  assert.equal(r.failed, 0, "合法的大帧不能被当成坏帧");
  assert.ok(r.lines.filter((l) => l.trim()).length >= N);
});

test("13 万事件真跑 scan：seqRange 不爆栈（原 P0-1）", () => {
  // 这条不许偷懒成「手写一个循环算 min/max」——那样测的是测试自己。
  // 必须真调 scan()，Math.min(...seqs) 一旦回来就会 RangeError。
  const N = 130000;
  const lines = [];
  for (let i = 0; i < N; i++) lines.push(`{"seq":${i},"type":"x"}`);
  const { file, cleanup } = tmpFile(frame(lines.join("\n")));
  try {
    const r = scan(file, {});
    assert.equal(r.events, N);
    assert.deepEqual(r.seqRange, [0, N - 1]);
  } finally {
    cleanup();
  }
});

test("readSession 遇到坏帧不抛，把 failed 传出来", () => {
  const buf = Buffer.concat([frame('{"type":"session","seq":0}'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff])]);
  const { file, cleanup } = tmpFile(buf);
  try {
    const { events, failed, frames } = readSession(file);
    assert.equal(frames, 2);
    assert.equal(failed, 1);
    assert.ok(Array.isArray(events));
  } finally {
    cleanup();
  }
});

test("isInject：认得出自动生成的英文 checkpoint 摘要", () => {
  assert.equal(
    isInject("This is an automatically generated checkpoint condensing an earlier span of the conversation."),
    true,
  );
  assert.equal(isInject("This is an automatically generated summary of the conversation so far."), true);
});

test("isInject：别把真人说的话误判成注入", () => {
  assert.equal(isInject("深深，今天记得吃饭"), false);
  assert.equal(isInject("我看了一下那个日志，好像没坏"), false);
});

test("逐帧解压拿得到所有帧（工具的真不变量，不依赖 Node 整文件行为）", () => {
  const buf = Buffer.concat([frame('{"a":1}'), frame('{"b":2}')]);
  // 「整文件 zstdDecompressSync 只返回第一帧」不是稳定契约：
  // Node 22.23.5 / 24.20.0 只返回第一帧，24.22.3 起会返回全部帧。
  // 不能拿它当断言。要钉的是工具自己的不变量：按魔数切帧后每帧都解得开、一行不丢。
  const r = decompressFrames(buf);
  assert.equal(r.frames, 2);
  assert.equal(r.failed, 0);
  const joined = r.lines.join("\n");
  assert.ok(joined.includes('"a":1') && joined.includes('"b":2'), "两帧的内容都要在");
  assert.equal(MAGIC.length, 4);
});
