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

export function textLayerGeometry(block) {
  const fontSize = Math.max(8, Math.min(2000, Number(block.fontSize || block.height || 24)));
  const align = ['center', 'right'].includes(block.textAlign) ? block.textAlign : 'left';
  const fit = block.textFit;
  // A designer may edit a row after analysis. Never apply stale fitted
  // bearings/advance to different text, font, size or tracking.
  const fitted = fit && fit.text === block.text && fit.fontPostScript === block.fontPostScript
    && Math.abs(Number(fit.fontSize) - fontSize) < 0.01
    && Math.abs(Number(fit.tracking || 0) - Number(block.tracking || 0)) < 0.01;
  const shift = align === 'center' ? 0.5 : align === 'right' ? 1 : 0;
  const x = Number(block.x || 0) + (fitted ? Number(fit.originOffsetX) + Number(fit.advance) * shift : Number(block.width || 0) * shift);
  const y = Number(block.y || 0) + (fitted ? Number(fit.baselineOffset) : fontSize);
  const angle = Number(block.rotation || 0) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { fontSize, align, transform: [cos, sin, sin ? -sin : 0, cos, x, y] };
}

function nativeTextLayer(block, index) {
  const { fontSize, align, transform } = textLayerGeometry(block);
  return {
    name: `OCR text ${index + 1} (review before enabling)`,
    // The existing Photoshop JSX path also leaves OCR text disabled until the
    // designer has reviewed it. Keep the same non-destructive default.
    hidden: true,
    text: {
      text: String(block.text || ''),
      transform,
      style: {
        font: { name: String(block.fontPostScript || block.fontFamily || 'ArialMT') },
        fontSize,
        // Photoshop expects an integer Tracking value. A real-valued entry
        // is interpreted as 16.16 fixed-point (35.5 becomes 2326528).
        tracking: Math.round(Number(block.tracking || 0)),
        fillColor: color(block.color)
      },
      paragraphStyle: {
        justification: align
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
