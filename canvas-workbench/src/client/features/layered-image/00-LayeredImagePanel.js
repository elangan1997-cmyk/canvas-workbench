    async function layeredImageSourceHash(data) {
      const match = /^data:image\/[^;,]+;base64,([\s\S]+)$/.exec(String(data || ''));
      if (!match || !globalThis.crypto?.subtle) return '';
      const binary = atob(match[1]), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    }
    function layeredTaskStatusLabel(status) {
      return ({ running: '处理中', failed: '失败，可继续', cancelled: '已停止，可继续', review: '待提取', ready: '已完成', needs_review: '待核对' })[status] || '已保存';
    }
    function LayeredImagePanel(props) {
      const [task, setTask] = React.useState(null);
      const [draft, setDraft] = React.useState([]);
      const [recent, setRecent] = React.useState([]);
      const [restoring, setRestoring] = React.useState(true);
      const [historyVersion, setHistoryVersion] = React.useState(0);
      const [posting, setPosting] = React.useState(false);
      const [error, setError] = React.useState('');
      const [format, setFormat] = React.useState('psd');
      const [hidden, setHidden] = React.useState({});
      const [original, setOriginal] = React.useState(true);
      const [dirty, setDirty] = React.useState(false);
      const [retryUnknown, setRetryUnknown] = React.useState(false);
      const [localOnly, setLocalOnly] = React.useState(props.automationLimits ? !props.automationLimits.generationAllowed : false);
      const [autoExport, setAutoExport] = React.useState(!props.automationLimits);
      const [autoOpen, setAutoOpen] = React.useState(!props.automationLimits);
      const [editableText, setEditableText] = React.useState(true);
      const [splitMode, setSplitMode] = React.useState('detailed');
      const [enhanceSource, setEnhanceSource] = React.useState(false);
      const [maxImageRequests, setMaxImageRequests] = React.useState(40);
      const [mergeUndo, setMergeUndo] = React.useState([]);
      const alive = React.useRef(true);
      const sending = React.useRef(false);
      const ownExports = React.useRef(false);
      const delivered = React.useRef(new Set());
      const receivedTaskId = React.useRef('');
      const taskProject = React.useRef('');
      const recoveryKey = React.useRef('');
      const liveProps = React.useRef(props);
      liveProps.current = props;
      const projectKey = JSON.stringify(props.project || {});
      const busy = restoring || posting || (task && task.status === 'running');
      const receive = (next) => {
        if (!alive.current || !next) return;
        if (receivedTaskId.current !== next.id) {
          receivedTaskId.current = next.id;
          setSplitMode(next.splitMode || (next.reconstruction==='complete' ? (next.completionPolicy==='practical'?'practical':'detailed') : 'preserve'));
          if (next.autoExportFormat !== undefined) {
            setAutoExport(!!next.autoExportFormat);
            if (['ai', 'psd', 'svg'].includes(next.autoExportFormat)) setFormat(next.autoExportFormat);
            setAutoOpen(next.openAfterExport === true);
          }
        }
        if (recoveryKey.current && !props.automationLimits) try {
          window.localStorage.setItem(recoveryKey.current, JSON.stringify({ id: next.id, storageProject: next.storageProject, sourceHash: next.referenceSourceHash || next.sourceHash }));
        } catch { /* Disk task records remain recoverable if browser storage is unavailable. */ }
        setRecent(items => [next, ...items.filter(item => item.id !== next.id)].sort((a,b) => b.createdAt-a.createdAt));
        taskProject.current = next.storageProject || props.project.project || '';
        setTask(next); setDraft(next.elements || []); setDirty(false);
        setLocalOnly(props.automationLimits && !props.automationLimits.generationAllowed ? true : next.localOnly === true);
        if (props.automationLimits) setMaxImageRequests(props.automationLimits.maxImageRequests || 0);
        else if (next.maxImageRequests !== undefined) setMaxImageRequests(next.maxImageRequests);
        if (next.previewUrl && next.status === 'ready') setOriginal(false);
        if (ownExports.current || next.autoExportFormat) for (const item of next.exports || []) {
          if (!delivered.current.has(item.path)) { delivered.current.add(item.path); liveProps.current.onFile(item); }
        }
      };
      const endpoint = (suffix, extra) => '/dsh-canvas/layered-image/' + suffix + '?' + new URLSearchParams({ ...(liveProps.current.project || {}),
        ...(suffix !== 'tasks' && taskProject.current ? { project: taskProject.current } : {}), ...(extra || {}) }).toString();
      const read = async (url, options) => {
        const r = await fetch(url, options), value = await r.json();
        if (!r.ok || !value.ok) throw new Error(typeof value.error === 'string' ? value.error : '图片拆层请求失败');
        return value;
      };
      React.useEffect(() => {
        alive.current = true;
        let cancelled = false;
        setRestoring(true); recoveryKey.current = '';
        const queries = [read(endpoint('tasks'))];
        if (!props.automationLimits && (props.project.cwd || props.project.sessionId)) queries.push(read(endpoint('tasks', { storageScope: 'workspace' })));
        const restoreSaved = async () => {
          const [results, sourceHash] = await Promise.all([Promise.allSettled(queries), layeredImageSourceHash(props.data.imageData).catch(() => '')]);
          if (cancelled || !alive.current) return;
          const items = new Map(); for (const result of results) if (result.status === 'fulfilled') for (const item of result.value.tasks || []) items.set(item.id, item);
          const history = [...items.values()].sort((a,b) => b.createdAt-a.createdAt);
          setRecent(history);
          if (props.initialTaskId) {
            const value = await read(endpoint('task', { id: props.initialTaskId }));
            if (!cancelled && alive.current) receive(value.task);
            return;
          }
          if (props.automationLimits) return;
          const candidates = [];
          if (sourceHash) {
            recoveryKey.current = 'dsh-canvas-layered-task:' + JSON.stringify([props.project.sessionId || '', props.project.cwd || '', props.project.project || '', sourceHash]);
            try {
              const saved = JSON.parse(window.localStorage.getItem(recoveryKey.current) || 'null');
              if (saved?.id && saved.storageProject && saved.sourceHash === sourceHash) candidates.push(saved);
            } catch { /* Fall back to persisted task history. */ }
            candidates.push(...history.filter(item => item.sourceHash === sourceHash || item.referenceSourceHash === sourceHash));
          }
          let restoreError = '';
          for (const previous of candidates.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)) {
            try {
              const value = await read(endpoint('task', { id: previous.id, project: previous.storageProject }));
              if (cancelled || !alive.current) return;
              if (value.task?.sourceHash !== sourceHash && value.task?.referenceSourceHash !== sourceHash) continue;
              ownExports.current = false; receive(value.task); setError(''); return;
            } catch (e) { restoreError = String(e.message || e); }
          }
          if (restoreError) setError('历史任务暂时无法恢复，原素材仍保留。请刷新任务记录：' + restoreError);
          else if (results.every(result => result.status === 'rejected')) setError('任务记录暂时无法读取，请刷新任务记录后继续');
        };
        restoreSaved().catch(e => { if (!cancelled && alive.current) setError(String(e.message || e)); })
          .finally(() => { if (!cancelled && alive.current) setRestoring(false); });
        return () => { cancelled = true; alive.current = false; };
      }, [projectKey, props.initialTaskId, historyVersion]);
      React.useEffect(() => {
        if (!task || (props.hidden && task.status === 'ready')) return undefined;
        let stopped = false, timer = null;
        const controller = new AbortController();
        const poll = async () => {
          try {
            const value = await read(endpoint('task', { id: task.id }), { signal: controller.signal });
            if (!stopped && alive.current) { receive(value.task); setError(''); }
          } catch (e) {
            if (!stopped && alive.current) setError('进度暂时无法连接，任务仍保存在项目中：' + String(e.message || e));
          }
          if (!stopped) timer = setTimeout(poll, task.status === 'running' ? 2000 : 8000);
        };
        timer = setTimeout(poll, 1000);
        return () => { stopped = true; controller.abort(); clearTimeout(timer); };
      }, [task && task.id, task && task.status, projectKey, props.hidden]);
      const act = async (action, payload) => {
        if (sending.current) return;
        sending.current = true; setPosting(true); setError('');
        try {
          const value = await read('/dsh-canvas/layered-image/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...(liveProps.current.project || {}),
              ...(action !== 'analyze' && taskProject.current ? { project: taskProject.current } : {}), ...(payload || {}) }) });
          receive(value.task);
        } catch (e) { if (alive.current) setError(String(e.message || e)); }
        finally { sending.current = false; if (alive.current) setPosting(false); }
      };
      const submitAnalysis = automatic => {
        ownExports.current = automatic && autoExport;
        return act('analyze', { ...props.data, autoRun: automatic, autoRefine: true, editableText, localOnly, maxImageRequests,
          splitMode: localOnly || !editableText ? 'preserve' : splitMode, enhanceSource: enhanceSource && !localOnly,
          autoExportFormat: autoExport ? format : '', openAfterExport: autoOpen, fontPolicy: 'substitute',
          ...(!props.automationLimits ? { storageScope: 'workspace' } : {}), ...(props.getModel ? props.getModel() : props.model || {}) });
      };
      const update = (id, patch) => { setDraft(items => items.map(e => e.id === id ? { ...e, ...patch } : e)); setDirty(true); };
      const move = (id, step) => {
        const sorted = draft.filter(e => e.type !== 'background').sort((a, b) => a.z - b.z);
        const i = sorted.findIndex(e => e.id === id), j = i + step;
        if (j < 0 || j >= sorted.length) return;
        const temp = sorted[i]; sorted[i] = sorted[j]; sorted[j] = temp;
        const positions = new Map(sorted.map((e, i) => [e.id, i]));
        setDraft(items => items.map(e => e.type === 'background' ? e : { ...e, z: positions.get(e.id) })); setDirty(true);
      };
      const mergeBehind = (element) => {
        const behind = draft.filter(e => e.enabled && e.type === 'image' && e.id !== element.id && e.z < element.z).sort((a, b) => b.z - a.z)[0];
        if (!behind) return;
        setMergeUndo(history => [...history, draft]);
        const x = Math.min(behind.x, element.x), y = Math.min(behind.y, element.y);
        const mergedIds = [...new Set([...(behind.mergedIds || []), element.id, ...(element.mergedIds || [])])];
        setDraft(items => items.map(e => e.id === element.id ? { ...e, enabled: false } : e.id === behind.id ? { ...e, mergedIds, x, y,
          width: Math.max(behind.x + behind.width, element.x + element.width) - x, height: Math.max(behind.y + behind.height, element.y + element.height) - y,
          name: behind.name + '＋' + element.name, description: '将下述元素作为一个整体提取，保留彼此前后遮挡、位置与细节：' + behind.description + '；' + element.description } : e));
        setDirty(true);
      };
      const restore = async id => {
        if (!id || busy) return;
        setError(''); setRestoring(true); ownExports.current = false;
        try { const previous = recent.find(t => t.id === id); const value = await read(endpoint('task', { id, project: previous?.storageProject || props.project.project })); if (alive.current) receive(value.task); }
        catch (e) { if (alive.current) setError(String(e.message || e)); }
        finally { if (alive.current) setRestoring(false); }
      };
      const canExport = task && !busy && !dirty && task.elements.length && task.elements.filter(e => e.enabled).every(e => e.status === 'complete');
      const display = [...draft].sort((a, b) => b.z - a.z);
      const hasAssets = draft.some(e => e.url && e.status === 'complete');
      const E = React.createElement;
      return E('aside', { className: 'dsh-layers-panel', 'aria-label': '图片拆层', style: props.hidden ? { display: 'none' } : undefined, onPointerDown: e => e.stopPropagation() },
        E('header', { className: 'dsh-layers-head' }, E('div', null, E('strong', null, '图片拆层'), E('small', null, '独立图层 · AI / PSD / SVG')),
          E('button', { type: 'button', onClick: () => props.onClose(busy), 'aria-label': '关闭拆层面板' }, '×')),
        E('div', { className: 'dsh-layers-scroll' },
          E('p', { className: 'dsh-layers-note' }, 'AI 中文字可编辑，复杂图像独立嵌入；不会自动变成全矢量。'),
          !task && !props.automationLimits ? E('p', { className: 'dsh-layers-note', style: { overflowWrap: 'anywhere' } }, '新拆层跟随当前工作区保存：' + (props.project.cwd || '请先选择聊天工作目录')) : null,
          props.automationLimits ? E('p', { className: 'dsh-layers-note' }, '这是后台任务的图层核对。完成修正后，在后台任务中继续未完成项；任务会复用这里的素材并按整批额度导出。') : null,
          recent.length ? E('select', { className: 'dsh-layers-recent', value: task ? task.id : '', disabled: busy, onChange: e => restore(e.target.value), 'aria-label': '恢复拆层任务' },
            E('option', { value: '' }, '历史拆层任务（可继续）…'), ...recent.map(t => E('option', { key: t.id, value: t.id }, t.name + ' · ' + layeredTaskStatusLabel(t.status) + ' · ' + new Date(t.createdAt).toLocaleString()))) : null,
          restoring ? E('p', { className: 'dsh-layers-note', role: 'status' }, '正在恢复这张图片的拆层进度…') : null,
          E('button', { type: 'button', disabled: busy, onClick: () => { setError(''); setHistoryVersion(v => v+1); } }, '刷新任务记录'),
          task && !restoring ? E('p', { className: 'dsh-layers-note', role: 'status' }, '任务已保存 · ' + layeredTaskStatusLabel(task.status) + '；关闭窗口后可继续，已有素材会复用。') : null,
          E('div', { className: 'dsh-layers-preview', style: { aspectRatio: (task && task.width || 1) + '/' + (task && task.height || 1) } },
            original || !hasAssets ? E('img', { src: task && task.sourceUrl || props.data.imageData, alt: '拆层原图', draggable: false })
              : [...draft].filter(e => e.enabled && e.url && !hidden[e.id]).sort((a, b) => a.z - b.z).map(e => E('img', { key: e.id, src: e.url, alt: e.name, draggable: false,
                style: e.bounds && task ? { left: e.bounds.x / task.width * 100 + '%', top: e.bounds.y / task.height * 100 + '%', right: 'auto', bottom: 'auto', width: e.bounds.width / task.width * 100 + '%', height: e.bounds.height / task.height * 100 + '%' } : undefined }))),
          E('div', { className: 'dsh-layers-preview-tools' }, E('button', { type: 'button', onClick: () => setOriginal(true), 'aria-pressed': original }, '原图'),
            E('button', { type: 'button', disabled: !hasAssets, onClick: () => setOriginal(false), 'aria-pressed': !original }, '图层预览'),
            task ? E('small', null, task.width + '×' + task.height) : null),
          task && task.status === 'running' ? E('div', { className: 'dsh-layers-progress', role: 'status' }, E('span', { className: 'dsh-layers-spinner' }),
            E('span', null, task.message || '处理中…'), E('progress', { value: Number(task.progress || 0), max: 100 })) : null,
          error || task && task.error ? E('p', { className: 'dsh-layers-error', role: 'alert' }, error || task.error) : null,
          task && task.quality ? E('details', { className: 'dsh-layers-warnings', open: task.quality.status === 'needs_review' },
            E('summary', null, '自动处理说明'),
            ...(task.quality.issues || []).map((i, index) => E('p', { key: index }, i.message || i.code))) : null,
          E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: editableText, disabled: busy || !!task,
            onChange: e => setEditableText(e.target.checked) }), '自动校准普通文字，生成可编辑文字层'),
          !task ? E('label', { className: 'dsh-layers-note',style:{display:'block',marginTop:8} }, '拆分方式 ', E('select', {value:localOnly||!editableText?'preserve':splitMode,disabled:busy||localOnly||!editableText,onChange:e=>setSplitMode(e.target.value),'aria-label':'拆分方式'},
            E('option',{value:'detailed'},'精细拆分（推荐）'),E('option',{value:'practical'},'实用拆分 · 允许原图组合'),E('option',{value:'preserve'},'原像素保留'))) : null,
          !task ? E('p',{className:'dsh-layers-note'},'精细拆分先判断每个区域的制作方式和遮挡关系，分别处理文字、图形、主体及背景。实用拆分允许难点保留组合；均不会要求逐项确认。') : null,
          task && task.productionPlan ? E('details',{className:'dsh-layers-warnings'},E('summary',null,'区域制作方案 · '+task.productionPlan.entries.length+' 项'),...task.productionPlan.entries.map(p=>E('p',{key:p.id},p.name+'：'+({'native-text':'原生文字','native-shape':'原生图形','transparent-image':'透明主体','photo-panel':'完整照片','background':'独立背景','source-group':'原图组合'}[p.method]||p.method)+'；'+p.reason))) : null,
          !task ? E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: enhanceSource, disabled: busy || localOnly,
            onChange: e => setEnhanceSource(e.target.checked) }), '先用图像模型高清重建，按实际返回尺寸检查；计入图像请求上限') : null,
          task && task.completeness ? E('p', { className: 'dsh-layers-note' }, task.completeness.practicalAccepted ? '实用拆分已准备；复杂内容保留组合，未声明全部独立可编辑' : task.completeness.complete ? '独立分层检查通过：可编辑文字 '+task.completeness.editableText+' 个，未确认微字字形 '+(task.completeness.unconfirmedGlyphs||[]).length+' 处' : '完整性检查尚未通过，已保留具体原因和素材') : null,
          task && task.status !== 'running' && task.message !== task.error && task.message !== error ? E('p', { className: 'dsh-layers-note' }, task.message) : null,
          task && task.warnings && task.warnings.length ? E('details', { className: 'dsh-layers-warnings' }, E('summary', null, '查看 ' + task.warnings.length + ' 项处理说明'), ...task.warnings.map((w, i) => E('p', { key: i }, w))) : null,
          task ? E('p', { className: 'dsh-layers-note' }, '已准备 ' + draft.filter(e => e.enabled && e.status === 'complete').length + ' / ' + draft.filter(e => e.enabled).length + ' 个图层；' + draft.filter(e => e.enabled && ['image','background'].includes(e.type) && (e.resolutionPolicy==='enhance' || (!e.sourceRegion && e.extractionMode!=='photo')) && e.status !== 'complete' && e.requestState !== 'returned').length + ' 个图层可能需要生图。文字与原图区块优先本地处理。') : null,
          !task ? E('p', { className: 'dsh-layers-note' }, '一键执行分析、提取和导出，成功素材会复用；临时本地故障会自动恢复。包装文字随产品保留。') : null,
          ...display.map(e => E('section', { key: e.id, className: 'dsh-layers-row' },
            E('div', { className: 'dsh-layers-row-title' },
              E('input', { type: 'checkbox', checked: e.enabled, disabled: busy || e.type === 'background' || draft.some(b => b.enabled && ((b.mergedIds || []).includes(e.id)||e.sourceParentId===b.id)), onChange: v => update(e.id, { enabled: v.target.checked }), 'aria-label': '输出图层' + e.name }),
              E('input', { value: e.name, disabled: busy, onChange: v => update(e.id, { name: v.target.value }), 'aria-label': '图层名称' }),
              e.type !== 'background' ? E('button', { type: 'button', disabled: busy, onClick: () => move(e.id, 1), title: '移到前面' }, '↑') : null,
              e.type !== 'background' ? E('button', { type: 'button', disabled: busy, onClick: () => move(e.id, -1), title: '移到后面' }, '↓') : null,
              e.url ? E('button', { type: 'button', title: '仅切换预览；不输出此图层请取消左侧勾选', onClick: () => { setHidden(h => ({ ...h, [e.id]: !h[e.id] })); setOriginal(false); }, 'aria-label': '显示或隐藏' + e.name }, hidden[e.id] ? '显示' : '隐藏') : null),
            E('small', null, ({ text: '文字', image: e.sourceRegion?'原图区块':e.extractionMode==='photo'?'完整照片':'抠图主体', shape:'图形', background: '完整背景' }[e.type] || '图层') + ' · ' + ({ pending: '待提取', complete: '已完成', failed: '待重试' }[e.status] || '待提取')),
            ['source-pixel-flat','source-photo-rectangle','source-text-region'].includes(e.extractionEngine) ? E('small', null, ' · 原图像素保留') : null,
            e.classificationReason ? E('small',null,' · '+e.classificationReason+(e.shadowMode==='preserve'?'（保留接触阴影）':'')) : null,
            e.type === 'image' ? E('label',null,'图片类型 ',E('select',{value:e.extractionMode||'',disabled:busy,onChange:v=>update(e.id,{extractionMode:v.target.value,modeLocked:!!v.target.value})},E('option',{value:''},'自动判断'),E('option',{value:'photo'},'完整矩形照片'),E('option',{value:'cutout'},'透明主体'))) : null,
            e.type === 'image' ? E('label',null,E('input',{type:'checkbox',checked:e.resolutionPolicy==='enhance',disabled:busy||localOnly,onChange:v=>update(e.id,{resolutionPolicy:v.target.checked?'enhance':'preserve',qualityReason:v.target.checked?(e.qualityReason||'用户选择高清重绘，须保留商品身份及原构图'):''})}),' 高清重绘并对照原图核验') : null,
            e.enhancementCheck ? E('small',null,e.enhancementCheck.accepted?'高清重绘已采用':'高清候选未采用，已保留原图') : null,
            e.extractionEngine === 'model-reconstruction' ? E('small', null, ' · 模型重建，请核对细节') : null,
            e.bounds ? E('small', null, 'PNG ' + e.bounds.width + '×' + e.bounds.height + ' · 原图坐标 (' + e.bounds.x + ', ' + e.bounds.y + ')') : null,
            e.status === 'complete' || e.status === 'failed' ? E('button', { type: 'button', disabled: busy, onClick: () => update(e.id, { revision: (e.revision || 0) + 1, status: 'pending' }) }, '重新生成此层') : null,
            e.type === 'image' && e.enabled && draft.some(b => b.enabled && b.type === 'image' && b.z < e.z) ? E('button', { type: 'button', disabled: busy, title: '与后方图像合并提取，适合保留完整产品与装饰组合', onClick: () => mergeBehind(e) }, '并入后层') : null,
            E('textarea', { value: e.description || '', disabled: busy, onChange: v => update(e.id, { description: v.target.value }), 'aria-label': '元素描述', placeholder: '描述需单独提取的元素和必须保留的细节' }),
            e.type !== 'background' ? E('div', { className: 'dsh-layers-inline' }, ...[['x','左'],['y','上'],['width','宽'],['height','高']].map(([key,label]) =>
              E('label', { key }, label, E('input', { type: 'number', min: key === 'x' || key === 'y' ? 0 : 1, value: e[key], disabled: busy,
                'aria-label': e.name + label, onChange: v => update(e.id, { [key]: Number(v.target.value), geometryIssues: undefined, geometryLocked:true }) })))) : null,
            e.error ? E('p', { className: 'dsh-layers-error' }, e.error) : null,
            e.type === 'text' ? E('div', { className: 'dsh-layers-text' },
              E('textarea', { value: e.text || '', disabled: busy, onChange: v => update(e.id, { text: v.target.value }), 'aria-label': '核对文字内容' }),
              E('label', null, E('input', { type: 'checkbox', checked: !!e.nativeText, disabled: busy, onChange: v => update(e.id, { nativeText: v.target.checked, fontAccepted: false, textMode:v.target.checked?'editable':'image',modeLocked:!v.target.checked,sourceTextFallback:!v.target.checked }) }), '可编辑文字（未勾选时保留原字形图像）'),
              e.nativeText ? E('div', null,
                E('select', { value: e.fontPostScript, disabled: busy, onChange: v => update(e.id, { fontPostScript: v.target.value, fontAccepted: false }), 'aria-label': '候选字体' },
                  ...TEXT_REBUILD_FONTS.map(group => E('optgroup', { key: group.group, label: group.group }, ...group.items.map(f => E('option', { key: f.ps, value: f.ps }, f.label))))),
                E('div', { className: 'dsh-layers-inline' }, E('label', null, '字号 ', E('input', { type: 'number', min: 8, max: 2000, value: e.fontSize, disabled: busy, onChange: v => update(e.id, { fontSize: Number(v.target.value) }) })),
                  E('input', { type: 'color', value: e.color || '#111827', disabled: busy, onChange: v => update(e.id, { color: v.target.value }), 'aria-label': '文字颜色' })),
                E('small', null, '系统自动匹配字体和位置；无法匹配时保留原字形区域')) : null) : null)),
          draft.some(e => e.requestState === 'unknown') ? E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: retryUnknown, onChange: e => setRetryUnknown(e.target.checked) }), '已核对服务记录，接受未知请求重试可能重复消耗额度') : null,
          E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: localOnly, disabled: busy || props.automationLimits && !props.automationLimits.generationAllowed, onChange: e => setLocalOnly(e.target.checked) }), '仅使用原图提取（不调用生图，复杂遮挡可能无法完成）'),
          E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: autoExport, disabled: busy, onChange: e => setAutoExport(e.target.checked) }), '拆层完成后自动导出并加入画布'),
          E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: autoOpen, disabled: busy, onChange: e => setAutoOpen(e.target.checked) }), '导出后自动打开 ' + (format === 'psd' ? 'Photoshop' : 'Illustrator')),
          mergeUndo.length ? E('button', { type: 'button', disabled: busy, onClick: () => { setDraft(mergeUndo[mergeUndo.length - 1]); setMergeUndo(history => history.slice(0, -1)); setDirty(true); } }, '撤销最近合并') : null,
          E('p', { className: 'dsh-layers-note' }, '取消勾选的前景不会出现在导出文件中。提取和补背景按元素消耗当前引擎额度，成功素材会复用，请逐层核对生成细节。'),
          task && (task.exports || []).length ? E('div', { className: 'dsh-layers-exports' }, ...task.exports.map(file => E('div', { key: file.path }, E('strong', null, file.kind.toUpperCase() + ' · ' + file.name),
            E('button', { type: 'button', onClick: () => props.onFile(file) }, '加入画布'), E('small', { title: file.path }, file.path)))) : null,
          task && task.outputDirectory ? E('small', { className: 'dsh-layers-path', title: task.outputDirectory }, '本任务工作区：' + task.workspaceRoot + '\n过程文件：' + task.outputDirectory) : null),
        E('footer', { className: 'dsh-layers-foot' },
          task && !busy && !props.automationLimits ? E('button', { type: 'button', onClick: () => { ownExports.current = false; taskProject.current = ''; setTask(null); setSplitMode('detailed'); setDraft([]); setMergeUndo([]); setDirty(false); setError(''); setOriginal(true); } }, '新分析') : null,
          !task && !props.automationLimits ? E('button', { className: 'dsh-layers-primary', type: 'button', disabled: busy, onClick: () => submitAnalysis(true) }, posting ? '正在提交…' : '一键拆层' + (autoExport ? '并导出 ' + format.toUpperCase() : '')) : null,
          !task ? E('button', { type: 'button', disabled: busy, onClick: () => submitAnalysis(false) }, '仅分析，先调整清单') : null,
          task && !busy ? E('button', { type: 'button', onClick: () => { act('refine', { id: task.id, editableText, fontPolicy: 'substitute' }); } }, '重新校准') : null,
          task && task.status === 'running' ? E('button', { type: 'button', disabled: posting, onClick: () => act('cancel', { id: task.id }) }, '停止后续操作') : null,
          task && task.status !== 'running' && (task.status !== 'ready' || dirty) ? E('button', { className: 'dsh-layers-primary', type: 'button', disabled: busy || (!draft.length&&!task.analysisModel), onClick: () => { ownExports.current = autoExport; for (const f of task.exports || []) delivered.current.add(f.path); act('run', { id: task.id, elements: draft, retryUnknown, localOnly,
            maxImageRequests, autoExportFormat: autoExport ? format : '', openAfterExport: autoOpen }); } }, dirty ? '应用修改并继续' : task.status === 'review' ? '开始拆层' + (autoExport ? '并导出 ' + format.toUpperCase() : '') : '继续生成') : null,
          E('div', { className: 'dsh-layers-export-tools' }, E('select', { value: format, disabled: busy, onChange: e => setFormat(e.target.value), 'aria-label': '拆层导出格式' }, E('option', { value: 'ai' }, 'AI（需 Illustrator）'), E('option', { value: 'psd' }, 'PSD'), E('option', { value: 'svg' }, 'SVG')),
            E('button', { type: 'button', disabled: !canExport, onClick: () => { ownExports.current = true; for (const f of task.exports || []) delivered.current.add(f.path); act('export', { id: task.id, format, openAfterExport: autoOpen }); } }, '导出 ' + format.toUpperCase())),
          E('label', null, '图像请求上限 ', E('input', { type: 'number', min: 0, max: 10000, value: maxImageRequests, disabled: busy || !!props.automationLimits,
            style: { width: 70 }, onChange: e => setMaxImageRequests(Number(e.target.value)) }), E('small', null, ' 已使用 ' + (task?.generationAttempts || 0)))));
    }
