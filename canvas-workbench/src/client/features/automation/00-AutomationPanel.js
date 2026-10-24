    function CanvasAutomationPanel(props) {
      const [folder, setFolder] = React.useState('');
      const [operation, setOperation] = React.useState('remove_background');
      const [recursive, setRecursive] = React.useState(false);
      const [formats, setFormats] = React.useState(['psd']);
      const [allowGeneration, setAllowGeneration] = React.useState(false);
      const [maximum, setMaximum] = React.useState(10);
      const [prompt, setPrompt] = React.useState('');
      const [jobs, setJobs] = React.useState([]);
      const [detail, setDetail] = React.useState(null);
      const [retryUnknown, setRetryUnknown] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const alive = React.useRef(true), pending = React.useRef(false);
      const E = React.createElement;
      const names = { queued: '排队中', running: '处理中', cancelling: '正在停止', completed: '已完成', partial: '部分完成', failed: '未完成', cancelled: '已停止', interrupted: '可继续', needs_review: '需核对' };
      const call = async (action, body) => {
        const response = await fetch('/dsh-canvas/automation/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: props.project.sessionId, ...body }) });
        const value = await response.json(); if (!response.ok || !value.ok) throw new Error(value.error || '后台任务操作失败'); return value.value;
      };
      const refresh = async signal => {
        const r = await fetch('/dsh-canvas/automation/jobs?' + new URLSearchParams({ sessionId: props.project.sessionId || '', summary: 'true' }), { cache: 'no-store', signal });
        const value = await r.json(); if (alive.current && value.ok) setJobs(value.value || []);
      };
      React.useEffect(() => {
        alive.current = true; let stopped = false, timer; const controller = new AbortController();
        const poll = async () => { try { await refresh(controller.signal); } catch (e) { if (!stopped && alive.current) setError('进度暂时无法读取，后台任务会保留'); } if (!stopped) timer = setTimeout(poll, 2500); };
        poll(); return () => { alive.current = false; stopped = true; clearTimeout(timer); controller.abort(); };
      }, [props.project.sessionId]);
      const act = async (action, body) => {
        if (pending.current) return; pending.current = true; setBusy(true); setError('');
        try { const result = await call(action, body); if (!alive.current) return; setNotice(result.message || '操作已受理'); await refresh(); }
        catch (e) { if (alive.current) setError(String(e.message || e)); }
        finally { pending.current = false; if (alive.current) setBusy(false); }
      };
      const showDetail = async job => {
        try { const r = await fetch('/dsh-canvas/automation/job?' + new URLSearchParams({ id: job.id }), { cache: 'no-store' }); const v = await r.json(); if (!v.ok) throw new Error(v.error); if (alive.current) { setDetail(v.value); setRetryUnknown(false); } }
        catch (e) { if (alive.current) setError(String(e.message || e)); }
      };
      return E('aside', { className: 'dsh-layers-panel dsh-automation-panel', 'aria-label': '后台批处理', onPointerDown: e => e.stopPropagation() },
        E('header', { className: 'dsh-layers-head' }, E('div', null, E('strong', null, '后台批处理'), E('small', null, '关闭面板后继续处理，原图会保留')),
          E('button', { type: 'button', onClick: props.onClose, 'aria-label': '关闭后台批处理' }, '×')),
        E('div', { className: 'dsh-layers-scroll' },
          E('p', { className: 'dsh-layers-note' }, '可以在聊天中指定文件夹或画布图片，例如“把这个文件夹的图片批量抠图，完成后展示”。'),
          E('p', { className: 'dsh-layers-note', style: { overflowWrap: 'anywhere' } }, '结果项目跟随当前工作区保存：' + (props.project.cwd || '未设置，使用输入文件夹所在目录')),
          E('label', null, '输入文件夹', E('input', { type: 'text', value: folder, placeholder: '粘贴文件夹路径；留空则处理画布选中图片', onChange: e => setFolder(e.target.value), style: { width: '100%' }, 'aria-label': '批处理输入文件夹' })),
          E('button', { type: 'button', disabled: busy, onClick: async () => { try { const value = await call('pick-folder', {}); if (value.path && alive.current) setFolder(value.path); } catch (e) { if (alive.current) setError(String(e.message || e)); } } }, '选择文件夹'),
          E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: recursive, onChange: e => setRecursive(e.target.checked) }), '包含子文件夹'),
          E('select', { value: operation, onChange: e => setOperation(e.target.value), 'aria-label': '批处理操作', style: { width: '100%' } },
            E('option', { value: 'remove_background' }, '批量抠图（本地处理）'), E('option', { value: 'layered_export' }, '图片拆层 · 可编辑 PSD / AI'),
            E('option', { value: 'flat_psd' }, '普通 PSD 转换（仅封装原图）'), E('option', { value: 'edit_image' }, '批量编辑图片')),
          operation === 'layered_export' ? E('div', { className: 'dsh-layers-inline' }, ...['psd', 'ai', 'svg'].map(f => E('label', { key: f }, E('input', { type: 'checkbox', checked: formats.includes(f), onChange: e => setFormats(current => e.target.checked ? [...current, f] : current.filter(x => x !== f)) }), f.toUpperCase()))) : null,
          operation === 'edit_image' ? E('textarea', { value: prompt, onChange: e => setPrompt(e.target.value), placeholder: '对所有图片执行的修改要求', 'aria-label': '批量图片修改要求', style: { width: '100%', minHeight: 70 } }) : null,
          ['layered_export', 'edit_image'].includes(operation) ? E('div', null,
            E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: allowGeneration, onChange: e => setAllowGeneration(e.target.checked) }), '允许当前图像引擎重建素材'),
            allowGeneration ? E('label', null, '整批图像请求上限 ', E('input', { type: 'number', min: 1, max: 10000, value: maximum, onChange: e => setMaximum(Number(e.target.value)), style: { width: 75 } })) : null) : null,
          E('button', { className: 'dsh-layers-primary', type: 'button', disabled: busy || (operation === 'layered_export' && !formats.length), onClick: () => act('submit', {
            operation, ...(folder.trim() ? { folder: folder.trim() } : { sourceProject: props.project.project, selectedOnly: true }), recursive,
            formats, prompt, allowGeneration, maxImageRequests: allowGeneration ? maximum : 0,
            editableText: true, openCanvas: true }) }, busy ? '正在提交…' : '开始后台处理'),
          error ? E('p', { className: 'dsh-layers-error', role: 'alert' }, error) : null,
          notice ? E('p', { className: 'dsh-layers-note', role: 'status' }, notice) : null,
          E('h4', null, '本聊天的任务'),
          !jobs.length ? E('p', { className: 'dsh-layers-note' }, '还没有后台任务') : null,
          ...jobs.slice(0, 30).map(job => E('section', { className: 'dsh-layers-row', key: job.id },
            E('strong', null, names[job.status] || job.status, ' · ', job.completed + '/' + job.total),
            ['queued','running','cancelling'].includes(job.status) ? E('span', { className: 'dsh-layers-spinner', style: { display: 'inline-block', marginLeft: 8 } }) : null,
            E('p', { className: 'dsh-layers-note' }, job.message),
            E('div', { className: 'dsh-layers-inline' },
              E('button', { type: 'button', onClick: () => act('open', { id: job.id }) }, '展示项目'),
              E('button', { type: 'button', onClick: () => showDetail(job) }, '查看明细'),
              ['queued','running','cancelling'].includes(job.status) ? E('button', { type: 'button', disabled: busy || job.status === 'cancelling', onClick: () => act('cancel', { id: job.id }) }, '停止')
                : job.status !== 'completed' ? E('button', { type: 'button', disabled: busy, onClick: () => act('resume', { id: job.id }) }, '继续未完成') : null))),
          detail ? E('section', { className: 'dsh-layers-row' }, E('strong', null, '任务明细'),
            ...detail.items.slice(0, 20).map(i => E('div', { key: i.id }, E('p', null, i.name, '：', i.error || names[i.status] || i.status),
              i.layeredTaskId ? E('button', { type: 'button', disabled: busy || ['queued','running','cancelling'].includes(detail.status), onClick: () => act('review', { id: detail.id, itemId: i.id }) }, '核对图层与字体') : null)),
            E('small', { style: { display: 'block', overflowWrap: 'anywhere' } }, '项目位置：' + detail.project),
            E('small', { style: { display: 'block' } }, '已使用图像请求：' + detail.imageRequestsUsed + '/' + detail.maxImageRequests),
            detail.items.some(i => i.requestState === 'unknown') ? E('label', { className: 'dsh-layers-note' }, E('input', { type: 'checkbox', checked: retryUnknown, onChange: e => setRetryUnknown(e.target.checked) }), '已核对未知请求，接受重试可能重复消耗') : null,
            detail.status !== 'completed' ? E('button', { type: 'button', disabled: busy, onClick: () => act('resume', { id: detail.id, retryUnknown, ...(allowGeneration ? { allowGeneration: true, maxImageRequests: maximum } : {}) }) }, '继续此任务') : null,
            E('button', { type: 'button', onClick: () => setDetail(null) }, '收起明细')) : null));
    }
