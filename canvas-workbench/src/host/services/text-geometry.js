// Local OCR measures line bounds; the chat model remains the source of text
// content and which objects the user intended to rebuild.
const compact = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');

function similarLine(a, b) {
  const longest = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) < 8 || Math.abs(a.length - b.length) > longest * 0.15) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length] <= Math.floor(longest * 0.15);
}

export function refineTextGeometry(blocks, lines, selections = [], { minLength = 3 } = {}) {
  let refinedCount = 0;
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const available = (Array.isArray(lines) ? lines : []).filter((line) => line && line.width > 0 && line.height > 0
    && (!selections.length || selections.some((region) => intersects(line, region))));
  const refined = blocks.map((block) => {
    if (!block || Math.abs(Number(block.rotation || 0)) > 2) return block;
    const text = compact(block.text);
    if (text.length < minLength) return block;
    const candidates = available.filter((line) => {
      const value = compact(line.text);
      const nearby = Math.abs(line.y - block.y) <= Math.max(12, Math.min(Number(block.height || 0), Number(line.height || 0)) * .8);
      const matches = text.length < 3 ? value === text : value.includes(text) || similarLine(value, text);
      return nearby && matches && intersects({ ...block, y: line.y, height: line.height }, line);
    }).sort((a, b) => Number(!compact(a.text).includes(text)) - Number(!compact(b.text).includes(text)) || Math.abs(a.y - block.y) - Math.abs(b.y - block.y));
    const line = candidates[0];
    if (!line) return block;
    const wholeLine = compact(line.text) === text || similarLine(compact(line.text), text);
    const left = wholeLine ? line.x : Math.max(block.x, line.x);
    const right = wholeLine ? line.x + line.width : Math.min(block.x + block.width, line.x + line.width);
    refinedCount += 1;
    return { ...block, x: Math.max(0, left - 2), y: Math.max(0, line.y - 2),
      width: right - left + 4, height: line.height + 4, geometrySource: 'local-ocr-matched-line' };
  });
  return { blocks: refined, refinedCount };
}
