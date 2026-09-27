import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 格式标记的渲染推断逻辑在 srcdoc 源文件里(不可直接 import)。
// 这里按源码抽取函数体并求值,保证测试与真实代码逐字同步——改坏即红。
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const srcdoc = await readFile(join(pluginRoot, 'src/client/core/canvas/frame/00-srcdoc.js'), 'utf8');

function extractFn(name) {
  const start = srcdoc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `srcdoc 缺少 ${name}`);
  let depth = 0, end = -1;
  for (let i = srcdoc.indexOf('{', start); i < srcdoc.length; i += 1) {
    if (srcdoc[i] === '{') depth += 1;
    else if (srcdoc[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `${name} 函数体不完整`);
  return srcdoc.slice(start, end);
}

const DSH_FORMAT_TAG_HEX = { psd: '#31A8FF', ai: '#FF9A00', pdf: '#E5322D', svg: '#8B5CF6' };
const docFormatTagOfElement = new Function('DSH_FORMAT_TAG_HEX', `${extractFn('docFormatTagOf')}; return ${extractFn('docFormatTagOfElement')};`)(DSH_FORMAT_TAG_HEX);

test('格式标记:双平台路径/大小写/中文空格路径均可推断', () => {
  assert.equal(docFormatTagOfElement({ customData: { dshSourcePath: 'C:\\Users\\Elan\\袋装咖啡豆 三角洲\\assets\\主图.PSD' } }), 'psd');
  assert.equal(docFormatTagOfElement({ customData: { dshSourcePath: '/Users/x/p/assets/图标.ai' } }), 'ai');
  assert.equal(docFormatTagOfElement({ customData: { dshSourcePath: 'D:\\画册\\说明书.PDF' } }), 'pdf');
  assert.equal(docFormatTagOfElement({ customData: { dshFileName: '矢量稿.SVG' } }), 'svg');
  // 无扩展名时回退 dshSourceKind 字段
  assert.equal(docFormatTagOfElement({ customData: { dshSourceKind: 'psd' } }), 'psd');
});

test('格式标记:普通图片不误判', () => {
  assert.equal(docFormatTagOfElement({ customData: { dshSourcePath: '/a/b/聊天生成.png', dshSourceKind: 'image' } }), null);
  assert.equal(docFormatTagOfElement({ customData: {} }), null);
  assert.equal(docFormatTagOfElement({}), null);
  // 扩展名在中间而非结尾不应命中
  assert.equal(docFormatTagOfElement({ customData: { dshSourcePath: '/a/psd.backup/x.png' } }), null);
});

// 点尺寸随缩放:与 imageNameLabels 中的公式保持一致(抽取校验公式存在且无下限破坏比例)
test('标记点尺寸公式:严格随缩放(存在 cornerSize/dotSize 且以 zoom 为基数)', () => {
  const labels = srcdoc.slice(srcdoc.indexOf('function imageNameLabels'), srcdoc.indexOf('function imageNameLabels') + 2500);
  assert.match(labels, /dotSize:Math\.max\(2,Math\.round\(8\*zoom/);
  assert.match(labels, /cornerSize:Math\.max\(3,Math\.round\(13\*zoom/);
});
