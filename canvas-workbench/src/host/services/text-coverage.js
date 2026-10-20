// Merge overlapping tile results in source pixels. Repeated words elsewhere
// on the artwork are distinct objects; text equality alone is never enough.
const compact = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, '');
const intersection = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export function mergeTextCandidates(blocks) {
  const merged = [];
  for (const block of blocks) {
    const text = compact(block.text);
    if (!text || !(block.width > 0 && block.height > 0)) continue;
    const duplicate = merged.findIndex((item) => {
      const other = compact(item.text);
      const coverage = intersection(item, block) / Math.max(1, Math.min(item.width * item.height, block.width * block.height));
      return coverage > 0.55 && (text === other || (Math.min(text.length, other.length) >= 3 && (text.includes(other) || other.includes(text))));
    });
    if (duplicate < 0) merged.push(block);
    else if (text.length > compact(merged[duplicate].text).length
      || (text.length === compact(merged[duplicate].text).length && Number(block.confidence || 0) > Number(merged[duplicate].confidence || 0))) merged[duplicate] = block;
  }
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function supplementTextCoverage(blocks, lines, selections) {
  const additions = [];
  for (const line of lines || []) {
    if (!line || !compact(line.text) || Number(line.confidence || 0) < 55 || !(line.width > 0 && line.height > 0)) continue;
    // Require the line centre inside a user selection, not a stray edge touch.
    const cx = line.x + line.width / 2, cy = line.y + line.height / 2;
    if (!selections.some((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)) continue;
    // Geometry also covers split model objects or differing OCR spelling.
    // Union intervals prevent two columns from counting the same pixels twice.
    const intervals = blocks.filter((b) => Math.min(b.y + b.height, line.y + line.height) - Math.max(b.y, line.y) >= Math.min(b.height, line.height) * 0.45)
      .map((b) => [Math.max(line.x, b.x), Math.min(line.x + line.width, b.x + b.width)])
      .filter(([left, right]) => right > left).sort((a, b) => a[0] - b[0]);
    let covered = 0, end = line.x;
    for (const [left, right] of intervals) { covered += Math.max(0, right - Math.max(end, left)); end = Math.max(end, right); }
    if (covered / line.width >= 0.55) continue;
    // Partial overlap needs manual review instead of adding an overlapping
    // editable layer on top of an already recognized fragment.
    additions.push({ ...line, recognitionSource: 'local-ocr-supplement', needsReview: true,
      enabled: covered === 0, reviewReason: covered > 0 ? '与已有文字部分重叠，请核对后选择保留项' : '本地 OCR 补漏，请核对文字' });
  }
  return { blocks: mergeTextCandidates([...blocks, ...additions]), supplementedCount: additions.length };
}
