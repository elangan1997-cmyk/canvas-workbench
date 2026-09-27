import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginChatGeneration, endChatGeneration, noteChatGenerationCompleted, chatGenerationStatus
} from '../../src/host/services/chat-generation.js';

test('chat-generation: active 计数随 begin/end 增减,并发的快照互不干扰', async () => {
  assert.equal(chatGenerationStatus().active >= 0, true);
  beginChatGeneration();
  beginChatGeneration();
  const snap = chatGenerationStatus();
  assert.ok(snap.active >= 2, `active 应至少为 2,实际 ${snap.active}`);
  // 快照返回的是浅拷贝,调用方改不动内部状态
  snap.active = 0;
  assert.ok(chatGenerationStatus().active >= 2);
  endChatGeneration();
  endChatGeneration();
  assert.equal(chatGenerationStatus().active, 0);
});

test('chat-generation: end 下限为 0,重复结束不会出现负数', () => {
  endChatGeneration();
  endChatGeneration();
  assert.equal(chatGenerationStatus().active, 0);
});

test('chat-generation: 完成路径登记为环形列表,上限 50 条', () => {
  // 先读当前长度,再灌 60 条,验证裁剪
  for (let i = 0; i < 60; i += 1) noteChatGenerationCompleted(`/tmp/gen-${i}.png`);
  const { completed } = chatGenerationStatus();
  assert.equal(completed.length, 50);
  assert.equal(completed[completed.length - 1].path, '/tmp/gen-59.png');
  assert.equal(typeof completed[0].at, 'number');
  assert.equal(completed[0].path.startsWith('/tmp/gen-'), true);
  // 完成列表同样防篡改
  completed.length = 0;
  assert.equal(chatGenerationStatus().completed.length, 50);
});
