    // ---- OCR text rebuild panel (multi-region, review-first) ----
    // OCR is deliberately review-first: the user can disable or correct every
    // candidate before a PSD is generated.  The source image is never changed.
    function TextRebuildPanel(props) {
      const data = props.data || {};
      const normalizeSelections = (value) => {
        const list = Array.isArray(value) ? value : (value ? [value] : []);
        return list.filter((item) => item && Number(item.width || 0) >= 6 && Number(item.height || 0) >= 6);
      };
      const [selections, setSelections] = React.useState(normalizeSelections(data.selections || data.selection));
      const rectsIntersect = (a, b) => {
        const ax = Number(a && a.x || 0), ay = Number(a && a.y || 0), aw = Number(a && a.width || 0), ah = Number(a && a.height || 0);
        const bx = Number(b && b.x || 0), by = Number(b && b.y || 0), bw = Number(b && b.width || 0), bh = Number(b && b.height || 0);
        const iw = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
        const ih = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
        if (iw <= 0 || ih <= 0) return false;
        const area = iw * ih;
        const blockArea = Math.max(1, aw * ah);
        const centerX = ax + aw / 2, centerY = ay + ah / 2;
        return area >= blockArea * 0.15 || (centerX >= bx && centerX <= bx + bw && centerY >= by && centerY <= by + bh);
      };
      const blockInSelections = (block, regions) => Array.isArray(regions) && regions.length > 0 && regions.some((region) => rectsIntersect(block, region));
      const normalizeBlocks = (value, regions) => (Array.isArray(value) ? value : []).map((item) => ({
        ...item,
        // Full-image OCR is only a candidate list.  A row becomes an actual
        // removal target after it intersects a user-drawn region.
        enabled: blockInSelections(item, regions) && item.enabled !== false
      }));
      const [blocks, setBlocks] = React.useState(normalizeBlocks(data.blocks, normalizeSelections(data.selections || data.selection)));
      const [draftSelection, setDraftSelection] = React.useState(null);
      const [imageSize, setImageSize] = React.useState({ width: Number(data.width || 0), height: Number(data.height || 0) });
      const [dragging, setDragging] = React.useState(false);
      const [zoomed, setZoomed] = React.useState(false);
      const [zoom, setZoom] = React.useState(1);
      const [pan, setPan] = React.useState({ x: 0, y: 0 });
      const [panning, setPanning] = React.useState(false);
      const imageRef = React.useRef(null);
      const naturalImageSizeRef = React.useRef({ width: 0, height: 0, source: '' });
      const zoomRef = React.useRef(1);
      const panRef = React.useRef({ x: 0, y: 0 });
      const panStartRef = React.useRef(null);
      const selectionStartRef = React.useRef(null);
      const draftSelectionRef = React.useRef(null);
      React.useEffect(() => {
        const regions = normalizeSelections(data.selections || data.selection);
        setBlocks(normalizeBlocks(data.blocks, regions));
      }, [data.blocks, data.selections, data.selection]);
      React.useEffect(() => {
        setSelections(normalizeSelections(data.selections || data.selection));
        setDraftSelection(null);
        // 接口回包里的 width/height 可能是预览尺寸或模型输入尺寸，
        // 不能在识别返回后覆盖浏览器已读到的图片真实像素尺寸。
        // 否则旧选区会突然按另一套比例重绘，表现为框选整体偏移。
        if (!naturalImageSizeRef.current.width && (data.width || data.height)) {
          setImageSize({ width: Number(data.width || 0), height: Number(data.height || 0) });
        }
      }, [data.selections, data.selection, data.width, data.height]);
      React.useEffect(() => {
        naturalImageSizeRef.current = { width: 0, height: 0, source: String(data.dataURL || '') };
        if (data.width || data.height) setImageSize({ width: Number(data.width || 0), height: Number(data.height || 0) });
      }, [data.dataURL]);
      React.useEffect(() => { zoomRef.current = zoom; }, [zoom]);
      React.useEffect(() => { panRef.current = pan; }, [pan]);
      const update = (index, patch) => setBlocks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
      const enabledCount = blocks.filter((item) => item && item.enabled !== false && String(item.text || '').trim()).length;
      const addRow = () => setBlocks((current) => current.concat([{ id: 'manual-' + Date.now(), text: '', originalText: '', x: 24, y: 24, width: 320, height: 48, fontSize: 32, fontFamily: 'PingFang SC', fontPostScript: 'PingFangSC-Regular', fontWeight: 'normal', color: '#111827', confidence: null, enabled: selections.length > 0 }]));
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const clampZoom = (value) => clamp(Number(value) || 1, 0.25, 4);
      const setPreviewZoom = (value) => {
        const next = clampZoom(value);
        zoomRef.current = next;
        setZoom(next);
      };
      const resetPreviewView = () => {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        setZoom(1);
        setPan({ x: 0, y: 0 });
      };
      const openZoomPreview = () => {
        resetPreviewView();
        setZoomed(true);
      };
      const wheelZoom = (event) => {
        if (!event || !event.deltaY) return;
        event.preventDefault();
        setPreviewZoom(zoomRef.current * (event.deltaY < 0 ? 1.15 : (1 / 1.15)));
      };
      const beginPan = (event) => {
        if (!event || (event.button !== 1 && !(event.button === 0 && event.target === event.currentTarget))) return;
        event.preventDefault();
        panStartRef.current = { clientX: event.clientX, clientY: event.clientY, x: panRef.current.x, y: panRef.current.y };
        setPanning(true);
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
      };
      const movePan = (event) => {
        const start = panStartRef.current;
        if (!panning || !start) return;
        event.preventDefault();
        const next = { x: start.x + event.clientX - start.clientX, y: start.y + event.clientY - start.clientY };
        panRef.current = next;
        setPan(next);
      };
      const endPan = (event) => {
        if (!panning) return;
        setPanning(false);
        panStartRef.current = null;
        if (event && event.currentTarget && event.currentTarget.releasePointerCapture && event.pointerId != null) {
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (e) {}
        }
      };
      const pointFromEvent = (event) => {
        // The overlay is the actual pointer coordinate space.  Do not use the
        // shared image ref here: the normal and zoom previews can coexist and
        // React will then point the ref at whichever image mounted last.
        const overlay = event && event.currentTarget;
        const wrapper = overlay && overlay.parentElement;
        const image = wrapper && wrapper.querySelector('img');
        if (!overlay || !image) return null;
        // 以真正可见的图片边界为坐标系，不以弹窗、留白容器或
        // object-fit 后的外层 overlay 为基准。缩放和平移已包含在该 rect 中。
        const rect = image.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const width = Number(image.naturalWidth || imageSize.width || rect.width);
        const height = Number(image.naturalHeight || imageSize.height || rect.height);
        return { x: clamp((event.clientX - rect.left) * width / rect.width, 0, width), y: clamp((event.clientY - rect.top) * height / rect.height, 0, height) };
      };
      const beginSelection = (event) => {
        if (data.busy || data.loading || event.button !== 0) return;
        const point = pointFromEvent(event);
        if (!point) return;
        event.preventDefault();
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
        selectionStartRef.current = point;
        draftSelectionRef.current = { x: point.x, y: point.y, width: 0, height: 0 };
        setDragging(true);
        setDraftSelection(draftSelectionRef.current);
      };
      const moveSelection = (event) => {
        if (!dragging) return;
        const point = pointFromEvent(event);
        const start = selectionStartRef.current;
        if (!point || !start) return;
        event.preventDefault();
        const next = { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) };
        draftSelectionRef.current = next;
        setDraftSelection(next);
      };
      const endSelection = (event) => {
        if (!dragging) return;
        setDragging(false);
        const point = pointFromEvent(event);
        const start = selectionStartRef.current;
        selectionStartRef.current = null;
        if (!point || !start) { draftSelectionRef.current = null; setDraftSelection(null); return; }
        const next = { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) };
        draftSelectionRef.current = null;
        setDraftSelection(null);
        if (next.width >= 6 && next.height >= 6) {
          const nextRegions = selections.concat([next]);
          setSelections(nextRegions);
          setBlocks((rows) => rows.map((item) => ({ ...item, enabled: blockInSelections(item, nextRegions) })));
          if (typeof props.onSelectionsChange === 'function') props.onSelectionsChange(nextRegions);
        }
      };
      const clearSelections = () => {
        setSelections([]);
        setDraftSelection(null);
        draftSelectionRef.current = null;
        selectionStartRef.current = null;
        setBlocks((rows) => rows.map((item) => ({ ...item, enabled: false })));
        if (typeof props.onSelectionsChange === 'function') props.onSelectionsChange([]);
      };
      const applySelections = () => {
        setBlocks((rows) => rows.map((item) => ({ ...item, enabled: blockInSelections(item, selections) })));
        if (typeof props.onSelectionsChange === 'function') props.onSelectionsChange(selections);
      };
      const visualSelectionStyle = (item) => item && imageSize.width > 0 && imageSize.height > 0 ? {
        left: (item.x / imageSize.width * 100) + '%',
        top: (item.y / imageSize.height * 100) + '%',
        width: (item.width / imageSize.width * 100) + '%',
        height: (item.height / imageSize.height * 100) + '%'
      } : null;
      const visualSelections = draftSelection ? selections.concat([draftSelection]) : selections;
      return React.createElement('div', { className: 'dsh-text-rebuild-overlay', onPointerDown: (event) => event.stopPropagation() },
        React.createElement('div', { className: 'dsh-text-rebuild-panel', role: 'dialog', 'aria-modal': 'true' },
          React.createElement('div', { className: 'dsh-text-rebuild-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 'dsh-text-rebuild-title' }, '编辑图片文字'),
              React.createElement('div', { className: 'dsh-text-rebuild-subtitle' }, data.name || '当前选中图片', ' · 模型识别仅作候选，请逐条确认')
            ),
            React.createElement('button', { className: 'dsh-text-rebuild-close', disabled: !!data.busy, onClick: props.onClose }, '×')
          ),
          React.createElement('div', { className: 'dsh-text-rebuild-body' },
            React.createElement('div', { className: 'dsh-text-rebuild-preview' },
              data.dataURL ? React.createElement('div', { className: 'dsh-text-select-wrap' },
                React.createElement('img', { ref: imageRef, src: data.dataURL, alt: data.name || '图片预览', decoding: 'async', onLoad: (event) => { const next = { width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1, source: String(data.dataURL || '') }; naturalImageSizeRef.current = next; setImageSize({ width: next.width, height: next.height }); } }),
                React.createElement('div', { className: 'dsh-text-select-overlay', onPointerDown: beginSelection, onPointerMove: moveSelection, onPointerUp: endSelection, onPointerCancel: endSelection },
                  visualSelections.map((item, index) => React.createElement('div', { key: 'selection-' + index, className: 'dsh-text-select-box', style: visualSelectionStyle(item) })),
                  null
                )
              ) : null,
              data.dataURL && !data.loading ? React.createElement('button', { type: 'button', className: 'dsh-text-select-zoom', onClick: openZoomPreview }, '放大编辑 · 框选文字') : null,
              selections.length ? React.createElement('div', { className: 'dsh-text-select-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '已框选 ' + selections.length + ' 个待移除区域'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: () => props.onDetect(selections) }, data.loading ? '理解中…' : '识别选区'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: clearSelections }, '清除选区')
              ) : React.createElement('div', { className: 'dsh-text-select-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '请先框选需要移除并重建的文字区域'),
                React.createElement('button', { type: 'button', disabled: true }, '识别选区')
              )
            ),
            React.createElement('div', { className: 'dsh-text-rebuild-info' },
              data.loading ? React.createElement('div', { className: 'dsh-text-rebuild-empty' }, '正在按原图分块识别并检查遗漏，密集文字需要更长时间…') : null,
              !data.loading && data.recognitionWarning ? React.createElement('div', { className: 'dsh-text-rebuild-empty' }, data.recognitionWarning) : null,
              !data.loading && !blocks.length ? React.createElement('div', { className: 'dsh-text-rebuild-empty' }, data.hasDetected ? '模型未在选区内找到可用文字，请调整选区后重试。' : '框选后点击“识别选区”，模型只理解选区内文字和背景。') : null,
              blocks.map((item, index) => React.createElement('div', { key: item.id || index, className: 'dsh-text-rebuild-row' },
                React.createElement('div', { className: 'dsh-text-rebuild-row-top' },
                  React.createElement('input', { type: 'checkbox', checked: item.enabled !== false, disabled: !!data.busy, onChange: (event) => update(index, { enabled: event.target.checked }) }),
                  React.createElement('span', { className: 'dsh-text-rebuild-confidence' }, item.confidence == null ? '手动' : '置信度 ' + item.confidence + '%'),
                  item.styleConfidence != null ? React.createElement('span', { className: 'dsh-text-rebuild-confidence' }, '样式推测 ' + Math.round(Number(item.styleConfidence) * 100) + '%') : null,
                  item.needsReview ? React.createElement('span', { title: item.reviewReason || '', className: 'dsh-text-rebuild-box' }, '本地补漏 · 待核对') : null,
                  React.createElement('span', { className: 'dsh-text-rebuild-box' }, Math.round(Number(item.x || 0)) + ', ' + Math.round(Number(item.y || 0)) + ' · ' + Math.round(Number(item.width || 0)) + '×' + Math.round(Number(item.height || 0)))
                ),
                React.createElement('textarea', { value: item.text || '', disabled: !!data.busy, placeholder: '输入要保留或替换的文字', onChange: (event) => update(index, { text: event.target.value }) }),
                React.createElement('div', { className: 'dsh-text-rebuild-row-controls' },
                  React.createElement('label', null, '字号', React.createElement('input', { type: 'number', min: 8, max: 2000, value: item.fontSize || 24, disabled: !!data.busy, onChange: (event) => update(index, { fontSize: Number(event.target.value) || 24 }) })),
                  React.createElement('label', null, '字体', React.createElement('select', { value: textRebuildFontValue(item), disabled: !!data.busy, onChange: (event) => update(index, { fontPostScript: event.target.value, fontFamily: event.target.value }) },
                    TEXT_REBUILD_FONTS.map((group) => React.createElement('optgroup', { key: group.group, label: group.group },
                      group.items.map((font) => React.createElement('option', { key: font.ps, value: font.ps }, font.label)))
                  ))),
                  React.createElement('label', null, '颜色', React.createElement('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#111827', disabled: !!data.busy, onChange: (event) => update(index, { color: event.target.value }) })),
                  React.createElement('button', { type: 'button', disabled: !!data.busy, onClick: () => update(index, { enabled: false }) }, '排除')
                )
              )),
              !data.loading ? React.createElement('button', { className: 'dsh-text-rebuild-add', disabled: !!data.busy, onClick: addRow }, '+ 新增文字') : null
            )
          ),
          React.createElement('div', { className: 'dsh-text-rebuild-foot' },
            React.createElement('div', { className: 'dsh-text-rebuild-note' }, data.error ? data.error : (enabledCount ? ('已选 ' + enabledCount + ' 个文字对象' + (data.tileCount ? ' · 分块识别 ' + data.tileCount + ' 块' : '') + (data.supplementedCount ? ' · 本地补漏 ' + data.supplementedCount + ' 项待核对' : '') + '；请对照原图确认。') : '先框选，再让当前聊天模型理解选区，确认后由工具执行清理。')),
            React.createElement('div', { className: 'dsh-text-rebuild-actions' },
              React.createElement('button', { className: 'dsh-text-rebuild-cancel', disabled: !!data.busy, onClick: props.onClose }, '取消'),
              React.createElement('button', { className: 'dsh-text-rebuild-export', disabled: !!data.busy || data.loading || enabledCount === 0, onClick: () => props.onExport(blocks, true, selections) }, data.busy ? '正在清理并生成…' : '清理背景并生成 PSD'),
              React.createElement('button', { className: 'dsh-text-rebuild-export', disabled: !!data.busy || data.loading || enabledCount === 0, title: '与 PSD 同构：由 Illustrator 脚本生成原生点文字层并保存为 .ai；不可用时退回 SVG', onClick: () => props.onExport(blocks, true, selections, 'ai') }, data.busy ? '正在清理并生成…' : '生成 AI（Illustrator）')
            )
          ),
          zoomed && data.dataURL ? React.createElement('div', { className: 'dsh-text-zoom-overlay', role: 'dialog', 'aria-modal': 'true' },
            React.createElement('div', { className: 'dsh-text-zoom-dialog', onPointerDown: (event) => event.stopPropagation() },
              React.createElement('div', { className: 'dsh-text-zoom-head' },
                React.createElement('div', { className: 'dsh-text-zoom-head-main' },
                  React.createElement('strong', null, '放大预览'),
                  React.createElement('span', null, '框选需要编辑的文字区域 · 滚轮缩放 · 中键拖动')
                ),
                React.createElement('div', { className: 'dsh-text-zoom-tools' },
                  React.createElement('button', { type: 'button', title: '缩小', onClick: () => setPreviewZoom(zoomRef.current / 1.2) }, '−'),
                  React.createElement('span', { className: 'dsh-text-zoom-value' }, Math.round(zoom * 100) + '%'),
                  React.createElement('button', { type: 'button', title: '放大', onClick: () => setPreviewZoom(zoomRef.current * 1.2) }, '+'),
                  React.createElement('button', { type: 'button', className: 'dsh-text-zoom-fit', onClick: resetPreviewView }, '适应'),
                  React.createElement('button', { type: 'button', className: 'dsh-text-zoom-close', onClick: () => setZoomed(false) }, '×')
                ),
              ),
              React.createElement('div', { className: 'dsh-text-zoom-stage', onWheel: wheelZoom, onPointerDown: beginPan, onPointerMove: movePan, onPointerUp: endPan, onPointerCancel: endPan, onPointerLeave: endPan, style: { cursor: panning ? 'grabbing' : (zoom > 1 ? 'grab' : 'default') } },
                React.createElement('div', { className: 'dsh-text-select-wrap dsh-text-select-wrap-large', style: { transform: 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + zoom + ')' } },
                  React.createElement('img', { ref: imageRef, src: data.dataURL, alt: data.name || '图片放大预览', decoding: 'async', onLoad: (event) => { const next = { width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1, source: String(data.dataURL || '') }; naturalImageSizeRef.current = next; setImageSize({ width: next.width, height: next.height }); } }),
                  React.createElement('div', { className: 'dsh-text-select-overlay', onPointerDown: beginSelection, onPointerMove: moveSelection, onPointerUp: endSelection, onPointerCancel: endSelection },
                    visualSelections.map((item, index) => React.createElement('div', { key: 'zoom-selection-' + index, className: 'dsh-text-select-box', style: visualSelectionStyle(item) }))
                  )
                )
              ),
              selections.length ? React.createElement('div', { className: 'dsh-text-zoom-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '已框选 ' + selections.length + ' 个待移除区域'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: () => { props.onDetect(selections); setZoomed(false); } }, data.loading ? '理解中…' : '识别选区'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: clearSelections }, '清除选区')
              ) : React.createElement('div', { className: 'dsh-text-zoom-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '请先框选需要移除的文字区域'),
                React.createElement('button', { type: 'button', disabled: true }, '识别选区')
              )
            )
          ) : null
        )
      );
    }

