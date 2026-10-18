// Local OCR measures line bounds; the chat model remains the source of text
// content and which objects the user intended to rebuild.
const compact = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');

export function refineTextGeometry(blocks, lines, selections = []) {
  let refinedCount = 0;
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const available = (Array.isArray(lines) ? lines : []).filter((line) => line && line.width > 0 && line.height > 0
    && (!selections.length || selections.some((region) => intersects(line, region))));
  const refined = blocks.map((block) => {
    if (!block || Math.abs(Number(block.rotation || 0)) > 2) return block;
    const text = compact(block.text);
    if (text.length < 3) return block;
    const candidates = available.filter((line) => {
      const value = compact(line.text);
      const nearby = Math.abs(line.y - block.y) <= Math.max(100, Number(block.height || 0) * 2);
      return nearby && value.includes(text) && intersects({ ...block, y: line.y, height: line.height }, line);
    }).sort((a, b) => Math.abs(a.y - block.y) - Math.abs(b.y - block.y));
    const line = candidates[0];
    if (!line) return block;
    const wholeLine = compact(line.text) === text;
    const left = wholeLine ? line.x : Math.max(block.x, line.x);
    const right = wholeLine ? line.x + line.width : Math.min(block.x + block.width, line.x + line.width);
    refinedCount += 1;
    return { ...block, x: Math.max(0, left - 2), y: Math.max(0, line.y - 2),
      width: right - left + 4, height: line.height + 4, geometrySource: 'local-ocr-matched-line' };
  });
  return { blocks: refined, refinedCount };
}
