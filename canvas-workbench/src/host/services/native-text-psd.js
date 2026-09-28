import { initializeCanvas, readPsd, writePsdBuffer } from 'ag-psd';

// ag-psd only needs ImageData-shaped buffers for this workflow. Supplying the
// lightweight factory keeps the plugin portable and avoids a native canvas
// dependency on both macOS and Windows.
initializeCanvas(
  () => { throw new Error('canvas drawing is not required for PSD text layers'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })
);

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

export function buildNativeTextPsd(draftBytes, blocks) {
  const psd = readPsd(draftBytes, { useImageData: true, skipThumbnail: true });
  const enabled = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && block.enabled !== false && String(block.text || '').trim())
    .slice(0, 200);
  psd.children = [...enabled.map(nativeTextLayer), ...(Array.isArray(psd.children) ? psd.children : [])];
  // Photoshop asks once to update the newly-created text engine data. After
  // choosing Update the layers are normal editable Type layers; the warning is
  // safer than shipping stale raster text data as if it were current.
  return writePsdBuffer(psd, { invalidateTextLayers: true });
}
