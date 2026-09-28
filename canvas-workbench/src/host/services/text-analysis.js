// 自 lib/index.js 机械迁移（v1.8 Phase 2），函数体逐字未改。
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { normalizeTextLayerText } from '../../shared/utils/data-url.js';
import { name } from '../plugin-meta.js';

const TEXT_VISION_SYSTEM = `你是平面设计稿的局部文字结构分析器。只分析用户明确框选区域内需要移除并重建为可编辑图层的文字；框外文字和包装文字不要输出。
只返回 JSON，不要 Markdown 代码块。格式为 {"blocks":[...],"erasePrompt":"..."} 。每个 block 必须包含：text,x,y,width,height,fontSize,fontFamily,fontWeight,color,textAlign,rotation,confidence,backgroundHint。
x/y/width/height 是 0-1000 的整图归一化坐标；fontSize 是相对整图高度 0-1000 的估算值；color 用 #RRGGBB；confidence 用 0-100。
按视觉上的一行或一个连续文字对象输出，不要把同一行无故拆分。text 必须忠实抄录，看不清时降低 confidence，不要猜成无意义字符。backgroundHint 简述该文字下方应恢复的局部背景。erasePrompt 用中文简述如何仅擦除框选文字并恢复背景，不得要求改变框外内容。fontFamily 只用 sans-serif/serif/rounded/display/monospace/handwriting，fontWeight 只用 normal/medium/bold，textAlign 只用 left/center/right。`;

function parseModelJson(text) {
  let raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
  const value = JSON.parse(raw);
  if (!value || !Array.isArray(value.blocks)) throw new Error('模型未返回 blocks 数组');
  return value;
}

function visionBlocks(value, width, height) {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, Number(value) || 0));
  const families = new Set(['sans-serif', 'serif', 'rounded', 'display', 'monospace', 'handwriting']);
  const weights = new Set(['normal', 'medium', 'bold']);
  const aligns = new Set(['left', 'center', 'right']);
  return value.blocks.slice(0, 200).map((item) => {
    const text = normalizeTextLayerText(item && item.text);
    if (!text) return null;
    const x = Math.round(clamp(item.x, 0, 1000) * width / 1000);
    const y = Math.round(clamp(item.y, 0, 1000) * height / 1000);
    const w = Math.max(1, Math.round(clamp(item.width, 0, 1000) * width / 1000));
    const h = Math.max(1, Math.round(clamp(item.height, 0, 1000) * height / 1000));
    const family = families.has(item.fontFamily) ? item.fontFamily : 'sans-serif';
    const weight = weights.has(item.fontWeight) ? item.fontWeight : 'normal';
    const cjk = /[\u3400-\u9fff]/.test(text);
    const serif = family === 'serif';
    const bold = weight !== 'normal';
    // CJK 回退字体用可免费商用的阿里巴巴普惠体；苹方/宋体等系统字体版权不
    // 覆盖商用稿件，不能作为默认值写进 PSD 文字层。英文无衬线同理用 Inter。
    return {
      text, x, y, width: Math.min(w, Math.max(1, width - x)), height: Math.min(h, Math.max(1, height - y)),
      fontSize: Math.max(8, Math.round(clamp(item.fontSize, 1, 1000) * height / 1000)),
      fontFamily: cjk ? '阿里巴巴普惠体 3.0' : (serif ? 'Times New Roman' : family === 'monospace' ? 'Menlo' : 'Inter'),
      fontPostScript: cjk ? (bold ? 'AlibabaPuHuiTi_3_85_Bold' : 'AlibabaPuHuiTi_3_55_Regular') : (serif ? (bold ? 'TimesNewRomanPS-BoldMT' : 'TimesNewRomanPSMT') : family === 'monospace' ? (bold ? 'Menlo-Bold' : 'Menlo-Regular') : (bold ? 'Inter-Bold' : 'Inter-Regular')),
      fontWeight: weight,
      color: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? String(item.color).toUpperCase() : '#111111',
      textAlign: aligns.has(item.textAlign) ? item.textAlign : 'left',
      rotation: clamp(item.rotation, -180, 180), confidence: clamp(item.confidence, 0, 100),
      backgroundHint: String(item.backgroundHint || '').trim().slice(0, 500), enabled: true
    };
  }).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x);
}

function detectImageMediaType(bytes) {
  if (!bytes || !bytes.length) return null;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return null;
}

async function analyzeTextWithCurrentModel(ctx, uploaded, body, simplified) {
  const provider = String(body.provider || '').trim();
  const model = String(body.model || '').trim();
  if (!provider || !model) throw new Error('未取得当前聊天模型');
  // 不信任 data URL 声明的 mime(画布图片的声明和真实字节可能不一致——WebP 存成 .png 等)。
  // 从魔术数检测真实类型,否则 DSH 附件验证会抛 "Declared image type does not match its bytes"。
  const detectedMediaType = detectImageMediaType(uploaded.bytes);
  const mediaType = detectedMediaType || (uploaded.mime === 'image/jpg' ? 'image/jpeg' : uploaded.mime);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw new Error('当前图片格式不支持模型分析');
  const attachment = await ctx.attachments.saveImage({ data: new Uint8Array(uploaded.bytes), mediaType, name: String(body.name || '画布图片') });
  const info = await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(15000));
  if (info && info.capabilities && info.capabilities.imageInput === false) throw new Error('当前聊天模型不支持图片输入');
  const prepared = await ctx.llm.prepareCall({ provider, model, maxTokens: 6000, ...(body.reasoningEffort ? { reasoningEffort: String(body.reasoningEffort) } : {}) }, AbortSignal.timeout(180000));
  const crops = Array.isArray(body.crops) ? body.crops : [];
  const normalized = crops.map((item, index) => ({ id: index + 1,
    x: Math.round(Math.max(0, Number(item.x || 0)) * 1000 / Math.max(1, attachment.width)),
    y: Math.round(Math.max(0, Number(item.y || 0)) * 1000 / Math.max(1, attachment.height)),
    width: Math.round(Math.max(0, Number(item.width || 0)) * 1000 / Math.max(1, attachment.width)),
    height: Math.round(Math.max(0, Number(item.height || 0)) * 1000 / Math.max(1, attachment.height)) }));
  const instruction = simplified
    ? '请识别这张图片中出现的所有文字。只输出 JSON：{"blocks":[{"text":"文字内容","x":左,"y":上,"width":宽,"height":高}]}，坐标为 0-1000 整图归一化（左上角为原点）。尽量列全，看不清的也要尝试。'
    : '用户框选区域（0-1000 整图归一化坐标）为：' + JSON.stringify(normalized)
    + '。只识别这些矩形内用户准备移除的文字。框外内容即使清晰可见也不要输出。请同时返回局部背景特征和 erasePrompt。';
  // v4 的 producer-owned source 形态;该消息发给模型调用不落会话,但统一新写法防后续 API 收紧。
  const message = createUserMessage({ source: Object.freeze({ kind: 'plugin:' + name }), content: [{ type: 'text', text: instruction }, { type: 'image', attachment }] });
  const assembler = new BlockAssembler();
  const signal = AbortSignal.timeout(180000);
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [message], system: TEXT_VISION_SYSTEM, signal, purpose: 'canvas-text-analysis' })) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind !== 'stop') throw new Error('当前聊天模型识别未正常完成：' + finish.kind);
  const text = assembler.blocks().flatMap((block) => block.type === 'text' ? [block.text] : []).join('').trim();
  const value = parseModelJson(text);
  if (!Array.isArray(value.blocks) || !value.blocks.length) throw new Error('模型返回 blocks 为空；模型原始回复前200字：' + text.slice(0, 200).replace(/\s+/g, ' '));
  return { value: value, width: attachment.width, height: attachment.height, provider, model };
}

export { TEXT_VISION_SYSTEM, parseModelJson, visionBlocks, analyzeTextWithCurrentModel };
