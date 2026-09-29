// ag-psd 懒加载:宿主加载插件只装包本体、不装 npm dependencies——静态 import 在
// 依赖缺失时会让整个插件"failed to import"(1.9.36~1.9.41 的真实事故:入口消失
// 的根因)。改为首次使用时动态加载:缺依赖只影响 PSD 文字层导出并给出可操作提示,
// 画布其余功能不受牵连。
let agPsdModule = null;
async function ensureAgPsd() {
  if (agPsdModule) return agPsdModule;
  let mod;
  try {
    mod = await import('ag-psd');
  } catch (err) {
    throw new Error('PSD 原生文字层依赖 ag-psd 未安装(插件更新时依赖未随装)。请用「更多 → 检查更新」重装本插件修复依赖后重试。原始错误: ' + String((err && err.message) || err));
  }
  // ag-psd only needs ImageData-shaped buffers for this workflow. Supplying the
  // lightweight factory keeps the plugin portable and avoids a native canvas
  // dependency on both macOS and Windows.
  mod.initializeCanvas(
    () => { throw new Error('canvas drawing is not required for PSD text layers'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
  );
  agPsdModule = mod;
  return mod;
}

function color(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ''));
  const hex = match ? match[1] : '111827';
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function nativeTextLayer(block, index) {
  const fontSize = Math.max(8, Math.min(220, Number(block.fontSize || block.height || 24)));
  return {
    name: `OCR text ${index + 1} (review before enabling)`,
    // The existing Photoshop JSX path also leaves OCR text disabled until the
    // designer has reviewed it. Keep the same non-destructive default.
    hidden: true,
    text: {
      text: String(block.text || ''),
      transform: [1, 0, 0, 1, Math.max(0, Number(block.x || 0)), Math.max(0, Number(block.y || 0)) + fontSize],
      style: {
        font: { name: String(block.fontPostScript || block.fontFamily || 'ArialMT') },
        fontSize,
        fillColor: color(block.color)
      },
      paragraphStyle: {
        justification: ['center', 'right'].includes(String(block.textAlign || '').toLowerCase())
          ? String(block.textAlign).toLowerCase()
          : 'left'
      }
    }
  };
}

export async function buildNativeTextPsd(draftBytes, blocks) {
  const { readPsd, writePsdBuffer } = await ensureAgPsd();
  const psd = readPsd(draftBytes, { useImageData: true, skipThumbnail: true });
  const enabled = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && block.enabled !== false && String(block.text || '').trim())
    .slice(0, 200);
  // ag-psd 的 children 顺序是「底部在前、顶部在后」（与 Photoshop 图层面板相反）。
  // 原生文字层必须追加到末尾（=堆叠顶部），否则会被不透明的 Clean background
  // 盖住 —— 用户点开图层「小眼睛」也看不到文字。
  psd.children = [...(Array.isArray(psd.children) ? psd.children : []), ...enabled.map(nativeTextLayer)];
  // Photoshop asks once to update the newly-created text engine data. After
  // choosing Update the layers are normal editable Type layers; the warning is
  // safer than shipping stale raster text data as if it were current.
  return writePsdBuffer(psd, { invalidateTextLayers: true });
}
