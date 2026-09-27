    // Windows 官方桌面用自绘标题栏(顶部一条 -webkit-app-region:drag 拖拽区,
    // 右上是系统最小化/关闭按钮)。画布工具栏若与它同行,点击会被拖拽区吞掉
    // (实测:换行到第二行的按钮就能点)。检测到 Windows 时整体下移避开。
    const IS_WINDOWS_UI = /Windows/i.test(String(navigator.userAgent || ''));
    // 实测高度优先:应用的 [data-windows-titlebar] 标记元素 → 继承的 CSS 变量 → 经验值。
    // 不直接依赖 CSS var(某些装配下不继承到 overlay,1.9.2 在 Win 实机未生效)。
    const measureWindowsTitlebar = () => {
      let height = 0;
      let source = 'none';
      try {
        const marked = document.querySelector('[data-windows-titlebar]');
        if (marked) {
          const rect = marked.getBoundingClientRect();
          if (rect && rect.height > 0 && rect.height < 120) { height = Math.ceil(rect.height); source = 'attr-rect'; }
        }
        if (!height) {
          const probe = document.querySelector('[data-windows-titlebar] *') || document.body;
          const value = getComputedStyle(probe).getPropertyValue('--dsh-windows-titlebar-height').trim();
          const parsed = parseFloat(value);
          if (Number.isFinite(parsed) && parsed > 0) { height = Math.ceil(parsed); source = 'css-var'; }
        }
      } catch (err) {}
      if (!height) { height = 40; source += '+fallback'; }
      return { height, source };
    };

    function CanvasOverlay() {
      const [on, setOn] = React.useState(getMode());
      const minimumChatWidth = 520;
      const clampPanelWidth = React.useCallback((value) => {
        const viewport = Math.max(720, window.innerWidth || 0);
        const maxByChat = Math.max(320, viewport - minimumChatWidth);
        return Math.max(320, Math.min(Math.round(value), Math.round(viewport * 0.75), maxByChat));
      }, []);
      const [width, setWidth] = React.useState(() => {
        let saved = 0;
        try { saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY) || 0); } catch (err) {}
        return clampPanelWidth(saved > 0 ? saved : window.innerWidth * 0.5);
      });
      const [status, setStatus] = React.useState('loading');
      const [feedback, setFeedback] = React.useState('');
      const [removeProgress, setRemoveProgress] = React.useState(null);
      const [projectInfo, setProjectInfo] = React.useState({ cwd: activeChatCwd, sessionId: activeChatSessionId, project: chosenProject(activeChatCwd, activeChatSessionId) });
      activeCanvasProjectPath = String(projectInfo.project || '');
      React.useEffect(() => {
        activeCanvasProjectPath = String(projectInfo.project || '');
        activeChatContextRevision += 1;
        window.dispatchEvent(new CustomEvent('dsh-canvas:project-context', {
          detail: { cwd: activeChatCwd, sessionId: activeChatSessionId, project: activeCanvasProjectPath }
        }));
      }, [projectInfo.project]);
      // 聊天生图状态轮询:宿主是生成起止与产出路径的唯一权威来源。
      // 自动上画布开启时:active 增长 → 在画布里创建与「编辑图片」同款的
      // 生成中占位元素(斜纹+转圈 SVG,占据图片即将落地的位置);完成路径
      // → 原位替换为真实图片;active 归零后的孤儿占位 → 标记失败。
      // 没有占位可替换时(占位被用户删掉)回退到普通自动加入。
      const chatPendingRef = React.useRef([]);
      const chatHandledRef = React.useRef(new Set());
      const chatProjectAskedRef = React.useRef({ sessionId: '', asked: false });
      const openProjectListRefHolder = React.useRef(null);
      React.useEffect(() => {
        if (!on) { chatPendingRef.current = []; return; }
        let stopped = false;
        const tokenOf = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
        const tick = async () => {
          try {
            const res = await fetch('/dsh-canvas/generation-status', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            const data = await res.json();
            if (stopped) return;
            const active = Number(data.active) || 0;
            const pending = chatPendingRef.current;
            const chatCtx = projectRef.current || {};
            const unbound = !chatCtx.project;
            const dismissedThisSession = chatProjectAskedRef.current.sessionId === chatCtx.sessionId && chatProjectAskedRef.current.dismissed;
            const unprocessed = Array.isArray(data.completed)
              ? data.completed.filter((item) => item && item.path && !chatHandledRef.current.has(String(item.path))).length
              : 0;
            // 未绑定画布项目:在聊天输入区(设计模式开关旁)显示询问横幅,不弹画布模态框
            // (模态会盖住画布阻断交互)。横幅期间占位与自动上画暂缓,绑定后自动补上;
            // 点「本次手动加入」后,本会话的完成路径标记为已处理,回纯手动模式。
            const askShow = canvasAutoAddEnabled() && unbound && !dismissedThisSession && (active > 0 || unprocessed > 0);
            const askState = JSON.stringify({ show: askShow, active });
            if (window.__dshCanvasGenAskState !== askState) {
              window.__dshCanvasGenAskState = askState;
              window.dispatchEvent(new CustomEvent('dsh-canvas:gen-state', { detail: { show: askShow, active } }));
            }
            if (canvasAutoAddEnabled() && unbound && !dismissedThisSession && (active > 0 || unprocessed > 0)) return;
            if (canvasAutoAddEnabled() && unbound && dismissedThisSession && Array.isArray(data.completed)) {
              for (const item of data.completed) {
                if (item && item.path) chatHandledRef.current.add(String(item.path));
              }
              return;
            }
            if (canvasAutoAddEnabled()) {
              // 占位数量对齐进行中数量(用户删掉的占位不重建,完成时走回退)
              while (pending.length < active) {
                const id = 'e_chat_pending_' + tokenOf();
                post({ type: 'chat-gen-placeholder', id, index: pending.length, subtitle: active > 1 ? '批量生成中 ×' + active + ',完成后自动加入画布' : '完成后自动加入画布' });
                pending.push(id);
              }
            }
            if (Array.isArray(data.completed) && canvasAutoAddEnabled()) {
              for (const item of data.completed) {
                if (!item || !item.path) continue;
                const path = String(item.path);
                // 宿主的完成记录是环形列表,每轮轮询都会重放:同一路径无论走
                // 占位原位替换还是兜底加入,只处理一次,否则会出现两张一样的图。
                if (chatHandledRef.current.has(path)) continue;
                chatHandledRef.current.add(path);
                const name = path.slice(path.lastIndexOf('/') + 1) || '聊天生成.png';
                const slotId = pending.shift();
                if (slotId) {
                  post({ type: 'chat-gen-resolve', id: slotId, url: '/dsh-canvas/image?path=' + encodeURIComponent(path), path, name });
                } else {
                  dispatchGeneratedToCanvas(path);
                }
              }
              if (chatHandledRef.current.size > 500) {
                chatHandledRef.current = new Set([...chatHandledRef.current].slice(-500));
              }
            }
            // 生成全部结束但仍有占位:完成环里还有未处理路径说明结果正在归档/在途,
            // 不能判死;只有确实没有任何在途结果时才留观 10 秒后标记失败
            // (外置盘归档 + v4 会话写入可能超过旧 4 秒窗口,曾把好占位误判成失败)。
            if (active === 0 && pending.length) {
              if (unprocessed > 0) {
                if (tick.settleTimer) { window.clearTimeout(tick.settleTimer); tick.settleTimer = null; }
              } else if (!tick.settleTimer) {
                tick.settleTimer = window.setTimeout(() => {
                  tick.settleTimer = null;
                  const rest = chatPendingRef.current;
                  if (rest.length && !stopped) {
                    chatPendingRef.current = [];
                    for (const id of rest) post({ type: 'chat-gen-fail', id, message: '生成已结束但没有等到结果——删除后重新生成即可' });
                  }
                }, 10000);
              }
            } else if (tick.settleTimer) {
              window.clearTimeout(tick.settleTimer);
              tick.settleTimer = null;
            }
          } catch (err) {}
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => {
          stopped = true;
          window.clearInterval(timer);
          if (tick.settleTimer) window.clearTimeout(tick.settleTimer);
        };
      }, [on]);
      const [projectDialog, setProjectDialog] = React.useState(null);
      const [projectList, setProjectList] = React.useState({ loading: false, items: [], error: '' });
      const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
      const [updateInfo, setUpdateInfo] = React.useState(null);
      const [updating, setUpdating] = React.useState(false);
      const refreshUpdateInfo = (silent) => {
        fetch('/dsh-canvas/update-check', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
          setUpdateInfo(d);
          if (!silent && d) {
            setFeedback(d.hasUpdate ? '🔄 发现新版本 ' + d.latest + '（更多菜单可一键更新）' : '✓ 已是最新版 ' + (d.current || ''));
          }
        }).catch(() => {});
      };
      React.useEffect(() => {
        let last = 0;
        try { last = Number(window.localStorage.getItem('dsh-canvas-update-checked-at') || 0); } catch (err) {}
        if (Date.now() - last < 24 * 60 * 60 * 1000) return undefined;
        try { window.localStorage.setItem('dsh-canvas-update-checked-at', String(Date.now())); } catch (err) {}
        const timer = window.setTimeout(() => refreshUpdateInfo(false), 6000);
        return () => window.clearTimeout(timer);
      }, []);
      // Adobe 桥接安装状态：默认按"已装"处理不显示安装按钮，打开「更多」菜单时查一次实际状态，
      // 缺菜单脚本 / CEP 面板才显示对应安装入口（装完按钮即消失，避免常驻三个一次性动作）。
      const [adobeInstall, setAdobeInstall] = React.useState({ scriptsInstalled: true, cepInstalled: true });
      const [imageSettings, setImageSettings] = React.useState(null);
      const [toolchain, setToolchain] = React.useState(null);
      const [imageSettingsBusy, setImageSettingsBusy] = React.useState(false);
      const [autoAddOn, setAutoAddOnState] = React.useState(canvasAutoAddEnabled());
      const [textRebuild, setTextRebuild] = React.useState(null);
      const projectRef = React.useRef({ cwd: activeChatCwd, sessionId: activeChatSessionId, project: chosenProject(activeChatCwd, activeChatSessionId) });
      const projectSwitchToken = React.useRef(0);
      // 场景令牌：每次向 iframe 发 load 都换新值；iframe 回传的 changed 必须携带
      // 当前令牌，否则视为上一个场景的迟到消息丢弃。防止 600ms 防抖的 changed
      // 跨项目切换后触发，把 A 项目场景合并进 B 项目（会清空 files、误触
      // scheduleRemovedImages 把图片移入画布回收站）。
      const canvasLoadToken = React.useRef('');
      const newLoadToken = () => 'lt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const postSceneLoad = (snapshot) => {
        canvasLoadToken.current = newLoadToken();
        post({ type: 'load', snapshot: JSON.stringify(snapshot), token: canvasLoadToken.current });
      };
      const switchingProject = React.useRef(false);
      // —— 素材库：独立于画布项目的自定义目录，支持最近访问与双向拖拽 ——
      const [materials, setMaterials] = React.useState(null);
      const [materialLibrary, setMaterialLibrary] = React.useState(() => {
        try {
          const saved = JSON.parse(window.localStorage.getItem(MATERIAL_LIBRARY_KEY) || '{}');
          return { current: typeof saved.current === 'string' ? saved.current : '', recent: Array.isArray(saved.recent) ? saved.recent.filter((path) => typeof path === 'string' && path).slice(0, 8) : [] };
        } catch (err) { return { current: '', recent: [] }; }
      });
      // —— 画布整理：排序方式与颜色标记范围（发给 iframe 的 arrange-images 消息） ——
      const [canvasArrangeOpen, setCanvasArrangeOpen] = React.useState(false);
      // 画布背景模式：跟随 DSH 主题（默认）或跟随系统外观；ref 同步给定时器闭包。
      const [canvasBgFollowSystem, setCanvasBgFollowSystem] = React.useState(() => {
        try { return window.localStorage.getItem('dsh-canvas-bg-follow-system') === '1'; } catch (error) { return false; }
      });
      const bgFollowSystemRef = React.useRef(canvasBgFollowSystem);
      const [canvasArrangeOrder, setCanvasArrangeOrder] = React.useState('name');
      const [canvasArrangeTag, setCanvasArrangeTag] = React.useState('');
      const [materialQuery, setMaterialQuery] = React.useState('');
      const [materialSelection, setMaterialSelection] = React.useState([]);
      const [materialSelectMode, setMaterialSelectMode] = React.useState(false);
      const [materialPreview, setMaterialPreview] = React.useState(null);
      const [materialDropActive, setMaterialDropActive] = React.useState(false);
      const [materialControlsOpen, setMaterialControlsOpen] = React.useState(false);
      // —— 素材整理：排序方式（本地记忆）+ 颜色标记与按色筛选 ——
      const [materialSort, setMaterialSort] = React.useState(() => {
        try { return JSON.parse(window.localStorage.getItem(MATERIAL_SORT_KEY) || 'null') || 'time'; } catch (err) { return 'time'; }
      });
      const [materialTagFilter, setMaterialTagFilter] = React.useState('');
      const [materialTags, setMaterialTags] = React.useState({});
      const [materialTagMenu, setMaterialTagMenu] = React.useState(null);
      const canvasMaterialDrag = React.useRef([]);
      const rememberMaterialDirectory = (dir) => {
        const path = String(dir || '').trim();
        if (!path) return;
        setMaterialLibrary((prev) => {
          const next = { current: path, recent: [path].concat((prev.recent || []).filter((item) => item !== path)).slice(0, 8) };
          try { window.localStorage.setItem(MATERIAL_LIBRARY_KEY, JSON.stringify(next)); } catch (err) {}
          return next;
        });
      };
      const loadMaterialDirectory = async (dir, options) => {
        const current = projectRef.current;
        const params = new URLSearchParams();
        if (dir) params.set('dir', dir);
        else if (current.cwd) params.set('cwd', current.cwd);
        if (!params.toString()) throw new Error('请先选择素材库文件夹');
        const r = await fetch('/dsh-canvas/materials?' + params.toString());
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || '读取失败');
        rememberMaterialDirectory(data.dir);
        setMaterialSelection([]);
        setMaterialPreview(null);
        setMaterials({ dir: data.dir, files: data.files || [], busy: false, error: '' });
        // 颜色标记按目录读取；读取失败不阻断列表，仅退化为无标记状态。
        try {
          const tr = await fetch('/dsh-canvas/materials/tags?dir=' + encodeURIComponent(data.dir));
          const td = await tr.json();
          setMaterialTags(tr.ok && td.ok && td.tags ? td.tags : {});
        } catch (err) { setMaterialTags({}); }
        if (!(options && options.silent)) setFeedback('✓ 已切换素材库：' + basename(data.dir));
        return data;
      };
      const openMaterials = async () => {
        const current = projectRef.current;
        if (!materialLibrary.current && !current.cwd) { setFeedback('⚠ 请先选择素材库文件夹'); return; }
        setMaterialQuery('');
        setMaterialSelection([]);
        setMaterialSelectMode(false);
        setMaterialPreview(null);
        setMaterialControlsOpen(false);
        setMaterialTagFilter('');
        setMaterialTagMenu(null);
        setMaterials({ dir: '', files: [], busy: true, error: '' });
        try {
          await loadMaterialDirectory(materialLibrary.current, { silent: true });
        } catch (err) { setMaterials({ dir: '', files: [], busy: false, error: String(err.message || err) }); }
      };
      const refreshMaterials = async (dirOverride) => {
        const current = projectRef.current;
        const dir = typeof dirOverride === 'string' ? dirOverride : (materials && materials.dir) || materialLibrary.current;
        if (!dir && !current.cwd) return;
        try {
          await loadMaterialDirectory(dir, { silent: true });
        } catch (err) {}
      };
      const chooseMaterialDirectory = async () => {
        try {
          const r = await fetch('/dsh-canvas/materials/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '选择失败');
          setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev);
          await loadMaterialDirectory(data.dir);
        } catch (err) {
          if (!/取消选择文件夹/.test(String(err.message || err))) setFeedback('⚠ 选择素材库失败：' + String(err.message || err));
        }
      };
      const openMaterialsFolder = async () => {
        const current = projectRef.current;
        try {
          const r = await fetch('/dsh-canvas/materials/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: materials && materials.dir, cwd: current.cwd }) });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '打开失败');
          setFeedback('✓ 已打开素材目录');
        } catch (err) { setFeedback('⚠ 无法打开素材目录：' + String(err.message || err)); }
      };
      const saveMaterialItems = async (items, sourceLabel) => {
        const current = projectRef.current;
        const dir = (materials && materials.dir) || materialLibrary.current;
        if (!dir && !current.cwd) throw new Error('请先选择素材库文件夹');
        const valid = (Array.isArray(items) ? items : []).filter((item) => item && item.dataURL);
        if (!valid.length) throw new Error('没有可保存的图片数据');
        let saved = 0;
        for (const item of valid) {
          const r = await fetch('/dsh-canvas/materials/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, cwd: current.cwd, name: item.name, dataURL: item.dataURL }) });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '保存失败');
          saved += 1;
        }
        setFeedback('✓ ' + (sourceLabel || '已存入当前素材库') + ' ' + saved + ' 项');
        if (materials) await refreshMaterials(dir);
        else await openMaterials();
        return saved;
      };
      const addSelectedToLibrary = async () => {
        const current = projectRef.current;
        if (!current.project) { setFeedback('⚠ 请先打开一个画布项目'); return; }
        setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev);
        try {
          const snapshot = await requestLiveSnapshot();
          const appState = snapshot && snapshot.appState ? snapshot.appState : {};
          const selectedIds = appState.selectedElementIds || {};
          const selected = (snapshot.elements || []).filter((x) => x && x.type === 'image' && !x.isDeleted && selectedIds[x.id]);
          if (!selected.length) throw new Error('请先在画布中选中图片');
          const items = [];
          for (const el of selected) {
            const file = (snapshot.files || {})[el.fileId];
            if (!file || !file.dataURL) continue;
            items.push({ name: (el.customData && el.customData.dshFileName) || ('素材-' + Date.now() + '-' + items.length + '.png'), dataURL: file.dataURL });
          }
          await saveMaterialItems(items, '已把画布选中图片存入当前素材库');
        } catch (err) { setMaterials((prev) => prev ? { ...prev, busy: false, error: String(err.message || err) } : prev); }
      };
      const sendMaterialToCanvas = (item) => {
        if (!item) return;
        const path = materials.dir + '/' + item.name;
        post({ type: 'add-image', explicit: true, url: '/dsh-canvas/image?path=' + encodeURIComponent(path), path, name: item.name });
        setFeedback('✓ 已发送到画布：' + item.name);
      };
      const selectedMaterials = materials ? materials.files.filter((item) => materialSelection.includes(item.name)) : [];
      // 应用标记颜色过滤与排序：默认按修改时间倒序（服务端顺序），
      // 可切换按类型（同类型内仍按时间）、像素数、文件大小、文件名整理。
      const materialPixels = (item) => (item.width && item.height ? item.width * item.height : 0);
      const materialExt = (item) => ((/\.[a-z0-9]+$/i.exec(item.name) || [''])[0] || '').toLowerCase();
      const filteredMaterials = materials ? materials.files
        .filter((item) => {
          const query = materialQuery.trim().toLocaleLowerCase();
          if (query && !item.name.toLocaleLowerCase().includes(query)) return false;
          if (materialTagFilter && (materialTags[item.name] || '') !== materialTagFilter) return false;
          return true;
        })
        .sort((materialSort === 'name'
          ? (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
          : materialSort === 'type'
            ? (a, b) => (materialExt(a) === materialExt(b) ? (b.mtime || 0) - (a.mtime || 0) : materialExt(a).localeCompare(materialExt(b)))
            : materialSort === 'pixels'
              ? (a, b) => (materialPixels(b) - materialPixels(a)) || ((b.mtime || 0) - (a.mtime || 0))
              : materialSort === 'bytes'
                ? (a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime || 0) - (a.mtime || 0))
                : (a, b) => (b.mtime || 0) - (a.mtime || 0))
        ) : [];
      const applyMaterialTag = async (names, color) => {
        if (!materials || !materials.dir || !Array.isArray(names) || !names.length) return;
        try {
          const r = await fetch('/dsh-canvas/materials/tag', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: materials.dir, names, color })
          });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '标记失败');
          setMaterialTags(data.tags || {});
          setFeedback('✓ 已' + (color ? '标记为 ' + ((MATERIAL_TAG_COLORS.find((c) => c.id === color) || {}).label || color) + '色 ' : '清除标记 ') + names.length + ' 项');
        } catch (err) { setFeedback('⚠ 更新颜色标记失败：' + String((err && err.message) || err)); }
      };
      const toggleMaterialSelection = (item) => {
        if (!item || !materialSelectMode) return;
        // “多选”本身就是显式模式：每次点击都追加或取消当前项，
        // 不再要求用户额外按住 Command/Ctrl/Shift。
        setMaterialSelection((prev) => prev.includes(item.name) ? prev.filter((name) => name !== item.name) : prev.concat(item.name));
      };
      const addSelectedMaterialsToCanvas = () => {
        if (!selectedMaterials.length) return;
        selectedMaterials.forEach(sendMaterialToCanvas);
        setFeedback('✓ 已加入画布 ' + selectedMaterials.length + ' 项');
      };
      const attachSelectedMaterialsToChat = async () => {
        if (!selectedMaterials.length) return;
        try {
          const images = [];
          for (const item of selectedMaterials) {
            const path = materials.dir + '/' + item.name;
            const response = await fetch('/dsh-canvas/image?path=' + encodeURIComponent(path));
            if (!response.ok) throw new Error(item.name + ' 读取失败');
            const blob = await response.blob();
            const dataURL = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => reject(new Error(item.name + ' 读取失败'));
              fr.readAsDataURL(blob);
            });
            images.push({ dataURL, name: item.name });
          }
          window.dispatchEvent(new CustomEvent('dsh-canvas:attach-selection', { detail: { images } }));
          setFeedback('✓ 已附加到聊天输入框 ' + images.length + ' 项');
        } catch (err) { setFeedback('⚠ 发送到聊天失败：' + String(err.message || err)); }
      };
      const deleteSelectedMaterials = async () => {
        if (!selectedMaterials.length || !window.confirm('从素材库删除选中的 ' + selectedMaterials.length + ' 项？\n不会影响已经放入画布的图片。')) return;
        const current = projectRef.current;
        setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev);
        try {
          for (const item of selectedMaterials) {
            const r = await fetch('/dsh-canvas/materials/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: materials.dir, cwd: current.cwd, name: item.name }) });
            const data = await r.json();
            if (!data.ok) throw new Error(data.error || (item.name + ' 删除失败'));
          }
          setMaterialSelection([]);
          setFeedback('✓ 已从素材库删除 ' + selectedMaterials.length + ' 项');
          await refreshMaterials();
        } catch (err) { setMaterials((prev) => prev ? { ...prev, busy: false, error: String(err.message || err) } : prev); }
      };
      const materialTransferHas = (dataTransfer, type) => Array.from(dataTransfer && dataTransfer.types || []).includes(type);
      const readDroppedFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name || ('素材-' + Date.now() + '.png'), dataURL: reader.result });
        reader.onerror = () => reject(new Error((file.name || '图片') + ' 读取失败'));
        reader.readAsDataURL(file);
      });
      const onMaterialDragOver = (event) => {
        const transfer = event.dataTransfer;
        if (!materialTransferHas(transfer, 'application/x-dsh-canvas-image') && !materialTransferHas(transfer, 'Files')) return;
        event.preventDefault();
        event.stopPropagation();
        transfer.dropEffect = 'copy';
        setMaterialDropActive(true);
      };
      const onMaterialDrop = async (event) => {
        const transfer = event.dataTransfer;
        if (!materialTransferHas(transfer, 'application/x-dsh-canvas-image') && !materialTransferHas(transfer, 'Files')) return;
        event.preventDefault();
        event.stopPropagation();
        setMaterialDropActive(false);
        try {
          let items = canvasMaterialDrag.current.slice();
          const files = Array.from(transfer.files || []).filter((file) => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(file.name || ''));
          if (files.length) items = await Promise.all(files.map(readDroppedFile));
          // 高清 Base64 从 srcdoc iframe 传到父窗口可能比拖拽手势晚几十到数百毫秒。
          // 松手后短暂等待数据到达，避免快速拖放被误判为“没有可保存的图片”。
          if (!files.length && !items.length && materialTransferHas(transfer, 'application/x-dsh-canvas-image')) {
            for (let attempt = 0; attempt < 12 && !items.length; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              items = canvasMaterialDrag.current.slice();
            }
          }
          await saveMaterialItems(items, files.length ? '已导入本地图片到当前素材库' : '已把画布图片拖入当前素材库');
          canvasMaterialDrag.current = [];
        } catch (err) {
          setFeedback('⚠ 拖入素材库失败：' + String(err.message || err));
        }
      };
      const startMaterialDrag = (event, item) => {
        const path = materials.dir + '/' + item.name;
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-dsh-material', JSON.stringify({ url: '/dsh-canvas/image?path=' + encodeURIComponent(path), path, name: item.name, size: item.size || 0 }));
        event.dataTransfer.setData('text/plain', item.name);
      };
      const frameRef = React.useRef(null);
      const frameReady = React.useRef(false);
      const stateLoaded = React.useRef(false);
      const pendingRef = React.useRef([]);
      const latestSnapshot = React.useRef(null);
      const saveTimer = React.useRef(null);
      const saveInFlight = React.useRef(null);
      const saveChain = React.useRef(Promise.resolve());
      const snapshotRequestSeq = React.useRef(0);
      const snapshotWaiters = React.useRef(new Map());
      const saveQueued = React.useRef(false);
      const projectSyncBusy = React.useRef(false);
      const missingSources = React.useRef(new Set());
      const knownDiskPaths = React.useRef(null);
      const queuedDiskPaths = React.useRef(new Set());
      const photoshopWatch = React.useRef(null);
      // 项目目录新文件的自动上画布基线：持久化到 localStorage（键含项目路径），
      // 重启不重拍——否则重启前刚生成/拷入的新文件会被当成历史、永远不再上画布。
      const autoAddBaseline = React.useRef(null);
      const materializingImages = React.useRef(new Set());
      const finderRemovingIds = React.useRef(new Set());
      const archivedImages = React.useRef(new Map());
      const restoringImages = React.useRef(new Set());
      const pendingArchiveTimers = React.useRef(new Map());
      // 重命名先更新画布快照、后更新磁盘文件；项目轮询期间不能把旧路径
      // 的短暂不存在误判成用户删除，尤其是 SVG/PDF/AI 这类源文件。
      const pendingRenames = React.useRef(new Map());
      const clearInProgress = React.useRef(false);
      const removeProgressTimer = React.useRef(null);

      React.useEffect(() => subscribeMode(setOn), []);
      // 首次挂载可能只能通过“工作目录最近项目”恢复；一旦当前会话 ID 已知，
      // 立即提升为精确绑定，后续切换到其它聊天再切回来仍能独立恢复。
      React.useEffect(() => {
        const current = projectRef.current;
        if (current.cwd && current.sessionId && current.project) {
          rememberProject(current.cwd, current.project, current.sessionId);
        }
      }, []);

      // 设计模式开：聊天内容让出右侧 width 像素（真实分栏，不遮挡）
      React.useEffect(() => {
        if (on) applyFramePadding(width);
        else applyFramePadding(0);
      }, [on, width]);
      // Host 端聊天 imagegen 代理据此决定是否接管请求，以及把生成原图
      // 归档到哪个画布项目。切换聊天、项目或设计模式后立即刷新上下文。
      React.useEffect(() => {
        if (!projectInfo.sessionId) return;
        fetch('/dsh-canvas/chat-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: projectInfo.sessionId, cwd: projectInfo.cwd || '', project: projectInfo.project || '', designMode: !!on })
        }).catch(() => {});
      }, [on, projectInfo.cwd, projectInfo.project, projectInfo.sessionId]);
      React.useEffect(() => {
        try { window.localStorage.setItem(PANEL_WIDTH_KEY, String(width)); } catch (err) {}
      }, [width]);
      React.useEffect(() => () => { applyFramePadding(0); }, []);
      React.useEffect(() => {
        const onViewportResize = () => setWidth((current) => clampPanelWidth(current));
        window.addEventListener('resize', onViewportResize);
        return () => window.removeEventListener('resize', onViewportResize);
      }, [clampPanelWidth]);

      // 所有 canvas.json 写入都串行化。特别是同一项目被两个聊天窗口
      // 先后打开时，不能让较早的旧快照在较新的快照之后完成写入。
      const queueStateSave = (snapshot, cwd, project) => {
        if (!snapshot || !project) return Promise.resolve();
        const task = saveChain.current.catch(() => {}).then(() => saveState(snapshot, cwd, project));
        saveChain.current = task.catch(() => {});
        return task;
      };
      const saveNow = () => {
        const current = projectRef.current;
        if (!latestSnapshot.current || !current.project) return;
        // 同一项目只允许一个完整 canvas.json 写入进行中；图片较多时，
        // 连续拖拽/缩放不会并发触发多次大文件序列化和磁盘写入。
        if (saveInFlight.current) {
          saveQueued.current = true;
          return;
        }
        const snapshot = latestSnapshot.current;
        const cwd = current.cwd;
        const project = current.project;
        let flight;
        flight = queueStateSave(snapshot, cwd, project).finally(() => {
          if (saveInFlight.current !== flight) return;
          saveInFlight.current = null;
          if (saveQueued.current) {
            saveQueued.current = false;
            scheduleSave();
          }
        });
        saveInFlight.current = flight;
        return flight;
      };
      const scheduleSave = () => {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(saveNow, 1500);
      };
      // 切换项目/聊天前的同步保存：等待正在进行的写入完成，再把最新快照
      // 追加到同一串行队列。这样不会出现旧请求后完成、覆盖新请求的情况。
      const flushSave = () => {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const current = projectRef.current;
        if (!latestSnapshot.current || !current.project) return Promise.resolve();
        const liveSnapshot = requestLiveSnapshot();
        const waiting = saveInFlight.current || Promise.resolve();
        saveQueued.current = false;
        let flight;
        flight = Promise.resolve(liveSnapshot).then((snapshot) => {
          if (snapshot && typeof snapshot === 'object') {
            // iframe 返回的是纯实时快照，不带父层的版本元数据；保留父层
            // 当前版本，避免切换瞬间把版本信息抹掉并绕过并发冲突检查。
            const currentMeta = latestSnapshot.current && latestSnapshot.current.dshMeta;
            latestSnapshot.current = currentMeta && typeof currentMeta === 'object'
              ? { ...snapshot, dshMeta: currentMeta }
              : snapshot;
          }
          return waiting.catch(() => {});
        }).then(() => {
          const latest = latestSnapshot.current;
          const now = projectRef.current;
          if (!latest || now.project !== current.project || now.cwd !== current.cwd) return undefined;
          return queueStateSave(latest, current.cwd, current.project);
        }).finally(() => {
          if (saveInFlight.current !== flight) return;
          saveInFlight.current = null;
          if (saveQueued.current) {
            saveQueued.current = false;
            scheduleSave();
          }
        });
        saveInFlight.current = flight;
        return flight;
      };
      // DSH 切换会话时可能卸载整个 overlay；退出/重启时也尽量把最后快照落盘。
      // 离开时同样走实时快照屏障，不能只写父页面上一次 onChange 的缓存，
      // 否则刚删除的元素可能在切换聊天时重新出现。
      React.useEffect(() => {
        const persistOnLeave = () => { void flushSave(); };
        const persistOnHidden = () => { if (document.visibilityState === 'hidden') persistOnLeave(); };
        window.addEventListener('pagehide', persistOnLeave);
        window.addEventListener('beforeunload', persistOnLeave);
        document.addEventListener('visibilitychange', persistOnHidden);
        return () => {
          window.removeEventListener('pagehide', persistOnLeave);
          window.removeEventListener('beforeunload', persistOnLeave);
          document.removeEventListener('visibilitychange', persistOnHidden);
          persistOnLeave();
        };
      }, []);
      const post = (msg) => {
        const w = frameRef.current && frameRef.current.contentWindow;
        if (w) w.postMessage(msg, '*');
      };
      // —— DSH 主题同步到画布 ——
      // iframe 是独立文档，DSH 的 CSS 变量进不去；画布背景原跟 prefers-color-scheme，
      // DSH 切浅色而系统深色时整块画布仍是黑的。这里读取 DSH 令牌的实时值推给 iframe。
      const lastPushedTheme = React.useRef('');
      const realSystemDarkRef = React.useRef(null);
      // 令牌可能挂在 html/body 或更深的 DSH 容器上，逐层找；全找不到时退回
      // body 实际背景色。暗色判定优先主题标记，缺失时按颜色亮度推断。
      const isDarkColorValue = (value) => {
        const text = String(value || '').trim();
        let r; let g; let b;
        const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
        const hex = /^#?([0-9a-f]{3,8})$/i.exec(text);
        if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
        else if (hex) {
          const digits = hex[1].length >= 6 ? hex[1].slice(0, 6) : hex[1].split('').map((c) => c + c).join('');
          r = parseInt(digits.slice(0, 2), 16); g = parseInt(digits.slice(2, 4), 16); b = parseInt(digits.slice(4, 6), 16);
        } else return false;
        return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
      };
      const dshThemeSnapshot = () => {
        try {
          let color = '';
          let fg = '';
          let surface = '';
          let line = '';
          let hover = '';
          const candidates = [document.documentElement, document.body, document.querySelector('#root')].filter(Boolean);
          for (const element of candidates) {
            const style = getComputedStyle(element);
            const read = (name) => String(style.getPropertyValue(name) || '').trim();
            if (!color) { const value = read('--dsw-alias-bg-base'); if (value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value)) color = value; }
            if (!fg) { const value = read('--dsw-alias-label-primary'); if (value) fg = value; }
            if (!surface) { const value = read('--dsw-alias-bg-layer-3'); if (value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value)) surface = value; }
            if (!line) { const value = read('--dsw-alias-border-l2'); if (value) line = value; }
            if (!hover) { const value = read('--dsw-alias-interactive-bg-hover'); if (value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value)) hover = value; }
          }
          if (!color) {
            const bodyBg = String(getComputedStyle(document.body).backgroundColor || '').trim();
            if (/^rgba?\(/i.test(bodyBg) && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(bodyBg)) color = bodyBg;
          }
          if (!color) return '';
          const dark = document.documentElement.hasAttribute('data-ds-dark-theme')
            || document.body.hasAttribute('data-ds-dark-theme')
            || isDarkColorValue(color);
          return `${dark}\u0000${color}\u0000${fg}\u0000${surface}\u0000${line}\u0000${hover}`;
        } catch (error) { return ''; }
      };
      const pushDshTheme = () => {
        if (!frameReady.current) return;
        // 跟随系统模式：真实系统外观来自主机进程（Electron 会覆盖页面里的
        // prefers-color-scheme）；主机结果未到时先用页面媒体查询兜底。
        if (bgFollowSystemRef.current) {
          const mediaDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
          const dark = realSystemDarkRef.current !== null ? realSystemDarkRef.current : mediaDark;
          const snapshot = `sys\u0000${dark}`;
          if (snapshot === lastPushedTheme.current) return;
          lastPushedTheme.current = snapshot;
          post({
            type: 'set-theme-background',
            color: dark ? '#15171c' : '#f7f8fa',
            dark,
            fg: dark ? '#f8fafc' : '#1f2937',
            surface: dark ? '#1b2028' : '#ffffff',
            line: dark ? 'rgba(255,255,255,.14)' : 'rgba(15,23,42,.14)',
            hover: dark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.06)'
          });
          return;
        }
        const snapshot = dshThemeSnapshot();
        if (!snapshot || snapshot === lastPushedTheme.current) return;
        lastPushedTheme.current = snapshot;
        const [dark, color, fg, surface, line, hover] = snapshot.split('\u0000');
        post({ type: 'set-theme-background', color, dark: dark === 'true', fg: fg || '', surface: surface || '', line: line || '', hover: hover || '' });
      };
      React.useEffect(() => {
        const observer = new MutationObserver(pushDshTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        const timer = window.setInterval(pushDshTheme, 4000);
        return () => { observer.disconnect(); window.clearInterval(timer); };
      }, []);
      // 系统外观切换与模式切换时立即重推；系统模式下另以 3 秒轮询主机进程
      // 获取真实系统外观（页面媒体查询会被 Electron 按应用主题覆盖）。
      React.useEffect(() => {
        pushDshTheme();
        if (!bgFollowSystemRef.current) return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => pushDshTheme();
        if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
        else if (typeof media.addListener === 'function') media.addListener(onChange);
        const timer = window.setInterval(() => {
          fetch('/dsh-canvas/system-appearance', { cache: 'no-store' })
            .then((response) => response.json())
            .then((data) => {
              if (data && data.ok && data.known && typeof data.dark === 'boolean' && realSystemDarkRef.current !== data.dark) {
                realSystemDarkRef.current = data.dark;
                pushDshTheme();
              }
            })
            .catch(() => {});
        }, 3000);
        return () => {
          if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
          else if (typeof media.removeListener === 'function') media.removeListener(onChange);
          window.clearInterval(timer);
        };
      }, [canvasBgFollowSystem]);
      // tldraw 的 onChange 经过短暂防抖，切换瞬间 latestSnapshot 可能还没收到
      // 最后一次删除/移动。切换前主动向 iframe 索取内存中的当前快照。
      // 大画布的 files 可能达到几十 MB；序列化并跨 iframe postMessage 需要
      // 留出时间，1.2 秒会把“正在删除后切换”误判成无响应并回退旧缓存。
      const requestLiveSnapshot = (timeoutMs = 5000) => {
        if (!frameReady.current || !frameRef.current) return Promise.resolve(null);
        const requestId = 'snapshot-' + (++snapshotRequestSeq.current);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            snapshotWaiters.current.delete(requestId);
            resolve(null);
          }, Math.max(500, Number(timeoutMs) || 5000));
          snapshotWaiters.current.set(requestId, (value) => {
            clearTimeout(timer);
            resolve(value || null);
          });
          post({ type: 'snapshot-request', requestId });
        });
      };
      const flushPending = () => {
        if (!frameReady.current) return;
        // 切换/导入项目时，iframe 还在 resetScene + restore；此时加入的图片
        // 会被后续恢复动作覆盖。保留队列，等 iframe 发出 loaded 再统一加入。
        if (switchingProject.current) return;
        if (!projectRef.current.project) {
          pendingRef.current = [];
          setFeedback('请先新建或切换画布项目');
          return;
        }
        const queue = pendingRef.current.slice().sort((a, b) => String(a.name || basename(a.path || '')).localeCompare(String(b.name || basename(b.path || '')), 'zh-CN', { numeric: true, sensitivity: 'base' }));
        pendingRef.current = [];
        const total = queue.length;
        const columns = total > 1 ? Math.min(5, Math.ceil(Math.sqrt(total * 1.35))) : 1;
        queue.forEach((item, index) => post({ type: 'add-image', explicit: true, url: item.url, path: item.path || '', name: item.name || basename(item.path || ''), mtime: item.mtime || 0, kind: item.kind || 'image', managed: item.managed, batchIndex: total > 1 ? index : undefined, batchTotal: total, batchColumns: columns, atX: item.atX, atY: item.atY, customData: item.customData && typeof item.customData === 'object' ? item.customData : undefined }));
      };
      const loadProject = (next, requireExisting) => {
        next = { ...next, sessionId: next.sessionId || projectRef.current.sessionId || activeChatSessionId };
        const token = ++projectSwitchToken.current;
        clearTimeout(saveTimer.current);
        const previous = projectRef.current;
        const previousPath = previous.project || '';
        const nextPath = next.project || '';
        const sameProject = previousPath === nextPath;
        // 同一个项目被不同聊天打开时也必须先保存当前聊天的快照；
        // 仅比较路径会跳过保存，导致 B 聊天重新读到 A 删除前的旧内容。
        const sameBinding = sameProject && previous.cwd === next.cwd && previous.sessionId === next.sessionId;
        // 必须先完成保存再 GET 新快照；否则 GET 可能先读到磁盘旧内容，
        // 随后即使保存成功，界面仍会把旧 snap 恢复回去。
        const preserve = !sameBinding && latestSnapshot.current && previous.project
          ? flushSave()
          : Promise.resolve();
        return Promise.resolve(preserve).then(() => loadState(next.cwd, next.project)).then((snap) => {
          if (token !== projectSwitchToken.current) return;
          if (requireExisting && !snap) { setFeedback('⚠ 项目中没有可加载的 canvas.json，当前画布未改变'); return; }
          return Promise.resolve().finally(() => {
            if (token !== projectSwitchToken.current) return;
            for (const timer of pendingArchiveTimers.current.values()) clearTimeout(timer);
            pendingArchiveTimers.current.clear();
            archivedImages.current.clear();
            queuedDiskPaths.current.clear();
            knownDiskPaths.current = null;
            switchingProject.current = true;
            projectRef.current = next;
            rememberProject(next.cwd, next.project, next.sessionId);
            setProjectInfo(next);
            const targetSnapshot = snap || { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground() }, files: {} };
            latestSnapshot.current = targetSnapshot;
            postSceneLoad(targetSnapshot);
            // 正常情况下由 iframe 的 loaded 信号尽快放行队列；若旧版/异常 iframe
            // 没有回传 loaded，也不能让导入文件永久滞留，超时后安全补刷一次。
            setTimeout(() => {
              if (token !== projectSwitchToken.current) return;
              switchingProject.current = false;
              flushPending();
            }, 5000);
            setFeedback(snap ? '✓ 已加载画布项目' : '新画布项目');
          });
        }).catch((err) => {
          setFeedback('⚠ 加载项目失败，当前画布未改变：' + String((err && err.message) || err));
        });
      };
      const openProjectList = () => {
        if (!projectInfo.cwd) { setFeedback('⚠ 当前聊天没有工作目录'); return; }
        setMoreMenuOpen(false);
        setProjectDialog({ mode: 'list' });
        setProjectList({ loading: true, items: [], error: '' });
        listProjects(projectInfo.cwd).then((result) => {
          setProjectList({ loading: false, items: Array.isArray(result.projects) ? result.projects : [], error: result.error || '' });
        }).catch((err) => setProjectList({ loading: false, items: [], error: String((err && err.message) || err) }));
      };
      openProjectListRefHolder.current = openProjectList;
      const browseDir = (path) => {
        setProjectDialog({ mode: 'browse', path, loading: true, entries: [], error: '' });
        fetch('/dsh-canvas/list-directories?path=' + encodeURIComponent(path)).then((r) => r.json()).then((result) => {
          const entries = ((result && result.entries) || []).filter((item) => item.type === 'directory' && !String(item.name || '').startsWith('.'));
          setProjectDialog({ mode: 'browse', path, loading: false, entries, error: result.error || '' });
        }).catch((err) => setProjectDialog({ mode: 'browse', path, loading: false, entries: [], error: String((err && err.message) || err) }));
      };
      const openProjectFolder = () => {
        const current = projectRef.current;
        setFeedback('正在系统文件管理器中打开项目目录…');
        fetch('/dsh-canvas/open-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '打开失败');
            setFeedback('✓ 已在系统文件管理器中打开项目目录');
          })
          .catch((err) => setFeedback('⚠ 无法打开项目目录：' + String((err && err.message) || err)));
      };
      const openImageSettings = () => {
        setMoreMenuOpen(false);
        setImageSettings({ loading: true, error: '' });
        fetch('/dsh-canvas/toolchain-status').then((r) => r.json()).then((d) => { if (d && d.ok) setToolchain(d.status); }).catch(() => {});
        fetch('/dsh-canvas/image-settings')
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '读取图像引擎设置失败');
            setImageSettings({ ...result.data, apiKey: '', loading: false, error: '', notice: '', test: null });
          })
          .catch((err) => setImageSettings({ loading: false, error: String((err && err.message) || err) }));
      };
      const saveImageSettings = () => {
        if (!imageSettings || imageSettings.loading || imageSettingsBusy) return;
        setImageSettingsBusy(true);
        fetch('/dsh-canvas/image-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine: imageSettings.engine, apiBaseUrl: imageSettings.apiBaseUrl, apiModel: imageSettings.apiModel, apiKey: imageSettings.apiKey || '' })
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '保存图像引擎设置失败');
            setImageSettings({ ...result.data, apiKey: '', loading: false, error: '', notice: '', test: null });
            setFeedback('✓ 图像引擎设置已保存');
            setTimeout(() => setImageSettings(null), 500);
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev))
          .finally(() => setImageSettingsBusy(false));
      };
      const refreshImageSettings = (notice) => {
        fetch('/dsh-canvas/image-settings')
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '刷新状态失败');
            setImageSettings((prev) => ({ ...result.data, apiKey: '', loading: false, error: '', notice: notice || (prev && prev.notice) || '', test: prev && prev.test || null }));
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev));
      };
      const installDshCodex = () => {
        if (imageSettingsBusy) return;
        setImageSettingsBusy(true);
        setImageSettings((prev) => prev ? { ...prev, error: '', notice: '正在检查画布套件内的 dsh-codex 兼容版…' } : prev);
        fetch('/dsh-canvas/image-setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install-dsh-codex' }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '安装失败');
            setImageSettings((prev) => prev ? { ...prev, health: result.data.health || prev.health, notice: result.data.message || '兼容版已就绪', error: '' } : prev);
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err), notice: '' } : prev))
          .finally(() => setImageSettingsBusy(false));
      };
      const startCodexLogin = () => {
        const popup = window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
        setImageSettingsBusy(true);
        setImageSettings((prev) => prev ? { ...prev, error: '', notice: '正在打开 ChatGPT 登录页…' } : prev);
        fetch('/plugins/dsh-openai-codex/auth/login', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((r) => r.json().catch(() => ({})).then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.url) throw new Error(result.data && result.data.error || 'dsh-codex 登录服务尚未加载，请重启 DSH 后重试');
            if (!popup) throw new Error('浏览器阻止了登录窗口，请允许 DSH 弹出窗口后重试');
            popup.location.replace(result.data.url);
            setImageSettings((prev) => prev ? { ...prev, notice: '请在新窗口完成 ChatGPT 授权；本页会自动刷新登录状态。', error: '' } : prev);
            let attempts = 0;
            const timer = window.setInterval(() => {
              attempts += 1;
              fetch('/dsh-canvas/image-settings').then((r) => r.json()).then((data) => {
                if (data && data.health && data.health.dshCodex && data.health.dshCodex.authenticated) {
                  window.clearInterval(timer);
                  setImageSettings({ ...data, apiKey: '', loading: false, error: '', notice: '✓ ChatGPT 登录完成，dsh-codex 图像能力已就绪。', test: null });
                } else if (attempts >= 120) {
                  window.clearInterval(timer);
                  setImageSettings((prev) => prev ? { ...prev, notice: '等待登录超时；完成授权后可点击“刷新状态”。' } : prev);
                }
              }).catch(() => {});
            }, 1500);
          })
          .catch((err) => { if (popup) popup.close(); setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err), notice: '' } : prev); })
          .finally(() => setImageSettingsBusy(false));
      };
      const testApiSettings = () => {
        if (imageSettingsBusy || !imageSettings) return;
        setImageSettingsBusy(true);
        setImageSettings((prev) => prev ? { ...prev, error: '', notice: '正在保存凭据并检测连接…', test: null } : prev);
        fetch('/dsh-canvas/image-setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'test-api', apiBaseUrl: imageSettings.apiBaseUrl, apiModel: imageSettings.apiModel, apiKey: imageSettings.apiKey || '' })
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '连接检测失败');
            const test = result.data.test || {};
            const message = test.endpointSupported === false
              ? '✓ 地址可达且凭据未被拒绝；该网关未提供 models 检测端点，首次编辑时会继续校验模型。'
              : '✓ API 连接正常，密钥分组已提供 ' + test.model + '（HTTP ' + test.status + '，' + test.latencyMs + 'ms）';
            setImageSettings((prev) => prev ? { ...prev, health: result.data.health || prev.health, apiKey: '', notice: message, error: '', test } : prev);
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err), notice: '', test: null } : prev))
          .finally(() => setImageSettingsBusy(false));
      };
      const askDshToConfigure = (engine) => {
        const prompt = engine === 'api'
          ? '请帮我配置画布插件的图像 API。先向我确认 API 地址、模型名称和 API Key；不要在聊天中回显完整密钥。配置目标是“更多 → 图像引擎设置 → API”，完成后运行连接检测并说明结果。'
          : '请帮我检查并配置画布插件的 dsh-codex 图像引擎。请检查 dsh-codex 是否安装、ChatGPT OAuth 是否登录；未安装则指导或执行 `dsh plugin --profile web add dsh-codex`，需要重启时明确提醒，最后检查图像引擎健康状态。不要改动我现有的 DSH 模型配置。';
        try {
          if (!dshConfigurationHelper || dshConfigurationHelper(prompt) === false) throw new Error('当前聊天输入服务不可用');
          setImageSettings((prev) => prev ? { ...prev, notice: '✓ 配置请求已填入左侧聊天输入框，请检查后发送。', error: '' } : prev);
        } catch (err) {
          navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(prompt).then(() => {
            setImageSettings((prev) => prev ? { ...prev, notice: '配置请求已复制，请粘贴到 DSH 聊天框发送。', error: '' } : prev);
          }).catch(() => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev)) : setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev);
        }
      };
      const importProject = () => {
        setProjectDialog(null);
        setFeedback('请选择要导入的项目文件夹…');
        fetch('/dsh-canvas/import-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '导入失败');
            const data = result.data;
            loadProject({ cwd: projectInfo.cwd, project: data.project }, false);
            setFeedback('✓ 项目已打开；请在聊天图片输出中点击“加入画布”添加图片');
          })
          .catch((err) => setFeedback('⚠ 导入项目失败：' + String((err && err.message) || err)));
      };
      const renameProject = (item, name) => {
        const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        if (!item || !item.path || !clean) return;
        setFeedback('正在重命名项目…');
        fetch('/dsh-canvas/rename-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: projectInfo.cwd, project: item.path, name: clean }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '重命名失败');
            if (projectRef.current.project === item.path) {
              const next = { ...projectRef.current, project: result.data.project };
              projectRef.current = next;
              setProjectInfo(next);
              rememberProject(next.cwd, next.project, next.sessionId);
            }
            setFeedback('✓ 项目已重命名为“' + result.data.name + '”');
            openProjectList();
          })
          .catch((err) => { setFeedback('⚠ 项目重命名失败：' + String((err && err.message) || err)); openProjectList(); });
      };
      const deleteProject = (item) => {
        if (!item || !item.path) return;
        const isCurrent = projectRef.current.project === item.path;
        const message = '删除项目“' + item.name + '”？\n\n项目文件夹不会永久删除，而会移动到同级的“已删除画布项目”文件夹。' + (isCurrent ? '\n当前画布会关闭并取消项目绑定。' : '');
        if (!window.confirm(message)) return;
        clearTimeout(saveTimer.current);
        const preserve = isCurrent && latestSnapshot.current ? flushSave() : Promise.resolve();
        setFeedback('正在移动项目到回收目录…');
        Promise.resolve(preserve).then(() => fetch('/dsh-canvas/delete-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: projectInfo.cwd, project: item.path }) }))
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '删除失败');
            if (isCurrent) {
              const next = { cwd: projectInfo.cwd, sessionId: projectInfo.sessionId, project: '' };
              projectRef.current = next;
              setProjectInfo(next);
              rememberProject(next.cwd, '', next.sessionId);
              latestSnapshot.current = { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground() }, files: {} };
              postSceneLoad(latestSnapshot.current);
            }
            setFeedback('✓ 项目已移入“已删除画布项目”，需要时可从文件管理器恢复');
            openProjectList();
          })
          .catch((err) => { setFeedback('⚠ 删除项目失败：' + String((err && err.message) || err)); openProjectList(); });
      };
      const currentProjectPath = () => {
        const current = projectRef.current;
        return current.project || '';
      };
      const materializeElement = (element, file, duplicate) => {
        if (!element || !file || !file.dataURL || materializingImages.current.has(element.id)) return;
        materializingImages.current.add(element.id);
        const current = projectRef.current;
        const name = element.customData && element.customData.dshFileName || ('画布图片-' + String(element.id).slice(-6) + '.png');
        fetch('/dsh-canvas/materialize-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, name, dataURL: file.dataURL }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '项目图片写入失败');
            const image = result.data.image;
            if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
            post({ type: 'bind-managed', elementId: element.id, path: image.path, name: image.name, mtime: image.mtime, kind: image.kind, newFileId: duplicate ? ('f_copy_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)) : '' });
            setFeedback('✓ 已同步到项目图片目录：' + image.name);
          })
          .catch((err) => setFeedback('⚠ 项目图片同步失败：' + String((err && err.message) || err)))
          .finally(() => materializingImages.current.delete(element.id));
      };
      const restoreArchivedElement = (element, record) => {
        if (!element || !record || restoringImages.current.has(element.id)) return;
        restoringImages.current.add(element.id);
        const current = projectRef.current;
        const custom = element.customData || {};
        fetch('/dsh-canvas/restore-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, ...record }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '恢复失败');
            archivedImages.current.delete(element.id);
            if (knownDiskPaths.current) knownDiskPaths.current.add(result.data.path);
            post({ type: 'refresh-source', elementId: element.id, path: result.data.path, name: custom.dshFileName || basename(result.data.path), mtime: result.data.mtime, url: result.data.url, kind: custom.dshSourceKind || 'image' });
            setFeedback('✓ 已从画布回收站恢复图片');
          })
          .catch((err) => setFeedback('⚠ 图片恢复失败：' + String((err && err.message) || err)))
          .finally(() => restoringImages.current.delete(element.id));
      };
      const archiveRemovedImages = (removed, nextLivePaths, skipRestore) => {
        const eligible = removed.filter((item) => {
          const path = item.customData && item.customData.dshSourcePath;
          // 图层编辑的临时提取图（dshScratch）不归档：它是过程中的中间产物，
          // 归档到画布回收站只会产生垃圾并弹出误导性的“已移入画布回收站”提示。
          if (item.customData && item.customData.dshScratch === true) return false;
          return path && !nextLivePaths.has(path) && !finderRemovingIds.current.has(item.id);
        });
        for (const item of removed) finderRemovingIds.current.delete(item.id);
        if (!eligible.length) return;
        const current = projectRef.current;
        const byPath = new Map(eligible.map((item) => [item.customData.dshSourcePath, item]));
        fetch('/dsh-canvas/archive-images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, paths: [...byPath.keys()] }) })
          .then((r) => r.json())
          .then((result) => {
            if (!result || !result.ok) return;
            for (const record of result.records || []) {
              const element = byPath.get(record.original);
              if (element && !skipRestore) {
                archivedImages.current.set(element.id, record);
                const currentLive = ((latestSnapshot.current && latestSnapshot.current.elements) || []).find((item) => item && item.id === element.id && item.type === 'image' && !item.isDeleted);
                if (currentLive) restoreArchivedElement(currentLive, record);
              }
              if (knownDiskPaths.current) knownDiskPaths.current.delete(record.original);
            }
            if ((result.records || []).length) setFeedback('✓ 已移入画布回收站，可随时恢复');
          })
          .catch((err) => setFeedback('⚠ 文件归档失败，磁盘原文件未删除：' + String((err && err.message) || err)));
      };
      const scheduleRemovedImages = (removed, nextLivePaths) => {
        for (const item of removed) {
          if (pendingArchiveTimers.current.has(item.id)) continue;
          const timer = setTimeout(() => {
            pendingArchiveTimers.current.delete(item.id);
            const currentSnapshot = latestSnapshot.current || {};
            const currentLive = (currentSnapshot.elements || []).filter((entry) => entry && entry.type === 'image' && !entry.isDeleted);
            if (currentLive.some((entry) => entry.id === item.id)) return;
            const currentPaths = new Set(currentLive.map((entry) => entry.customData && entry.customData.dshSourcePath).filter(Boolean));
            archiveRemovedImages([item], currentPaths, false);
          }, 1200);
          pendingArchiveTimers.current.set(item.id, timer);
        }
      };
      const backupAndClear = () => {
        const snapshot = latestSnapshot.current || {};
        const images = (snapshot.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
        const message = '将清空画布上的 ' + images.length + ' 张图片和其他元素。\n\n项目内图片不会永久删除，会移入“画布回收站”；当前 canvas.json 会先保存到“画布备份”。是否继续？';
        if (!window.confirm(message)) return;
        const current = projectRef.current;
        setFeedback('正在备份画布…');
        fetch('/dsh-canvas/backup-canvas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, snapshot }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '备份失败');
            const current = projectRef.current;
            const paths = [...new Set(images.map((item) => item.customData && item.customData.dshSourcePath).filter(Boolean))];
            clearInProgress.current = true;
            return fetch('/dsh-canvas/archive-images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, paths }) });
          })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '图片归档失败');
            for (const timer of pendingArchiveTimers.current.values()) clearTimeout(timer);
            pendingArchiveTimers.current.clear();
            archivedImages.current.clear();
            post({ type: 'clear' });
            setFeedback('✓ 已备份；图片已移入画布回收站');
          })
          .catch((err) => { clearInProgress.current = false; setFeedback('⚠ 清空前保护失败，已取消清空：' + String((err && err.message) || err)); });
      };
      const exportTextRebuild = (blocks, openPhotoshop, selectedRegions, format) => {
        const current = projectRef.current;
        const active = textRebuild;
        if (!active || active.busy) return;
        const regions = Array.isArray(selectedRegions) ? selectedRegions : (Array.isArray(active.selections) ? active.selections : []);
        // 字体值在数据层归一：识别来源（OCR/模型/旧会话）可能仍带着 PingFang
        // 等不可商用默认值，下拉框只在显示层掩盖它；不归一会让 PSD 拿到与
        // 界面所见不一致的字体。
        const normalizedBlocks = (blocks || []).map((item) => {
          const font = textRebuildFontValue(item);
          return { ...item, fontPostScript: font, fontFamily: font };
        });
        setTextRebuild({ ...active, busy: true, error: '' });
        fetch('/dsh-canvas/export-text-psd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...current, format: format || 'psd', openPhotoshop: format === 'psd' ? openPhotoshop : false, openIllustrator: (format === 'svg' || format === 'ai') ? openPhotoshop !== false : undefined, elementId: active.elementId, name: active.name, imageData: active.dataURL, width: Number(active.width || 0), height: Number(active.height || 0), selection: regions.length === 1 ? regions[0] : null, selections: regions, blocks: normalizedBlocks, erasePrompt: active.erasePrompt || '', cleanBackground: true, openPhotoshop: openPhotoshop !== false })
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || (format === 'psd' ? 'PSD 生成失败' : 'AI/SVG 生成失败'));
            const image = result.data.image;
            queuedDiskPaths.current.add(image.path);
            if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
            pendingRef.current.push({ ...image, explicit: true });
            flushPending();
            setTextRebuild(null);
            const cleanup = result.data.cleanedBackground ? ('；背景已由 ' + (result.data.cleanupEngine || 'image2') + ' 局部清理') : '；未完成背景清理，已保留原图';
            const suffix = format === 'svg' || format === 'ai'
              ? (result.data.ai
                  ? ('已生成原生 .ai（Illustrator 原生文字层，' + (result.data.texts || 0) + ' 个文字对象）')
                  : (result.data.illustrator ? ('已生成 SVG 并尝试用 Illustrator 打开（' + (result.data.texts || 0) + ' 个文字对象）') : ('已生成 SVG（' + (result.data.texts || 0) + ' 个文字对象，可在 Illustrator 中编辑文字）')))
              : (result.data.photoshop ? '已写入 Photoshop 文字层' : '已生成 PSD 草稿（文字层需在 Photoshop 中继续整理）');
            setFeedback('✓ ' + suffix + cleanup + '，文件已加入画布：' + image.name + (result.data.warning ? '；' + result.data.warning : ''));
          })
          .catch((err) => setTextRebuild((prev) => prev ? { ...prev, busy: false, error: '⚠ ' + (format === 'psd' ? 'PSD' : 'AI/SVG') + ' 生成失败：' + String((err && err.message) || err) } : prev));
      };
      const detectTextRebuild = (selectedRegions) => {
        const active = textRebuild;
        if (!active || active.busy || active.loading) return;
        const regions = (Array.isArray(selectedRegions) ? selectedRegions : (active.selections || [])).filter((item) => item && Number(item.width || 0) >= 6 && Number(item.height || 0) >= 6).slice(0, 24);
        if (!regions.length) {
          setTextRebuild((prev) => prev ? { ...prev, error: '请先框选需要识别和移除的文字区域' } : prev);
          return;
        }
        const current = projectRef.current;
        setTextRebuild((prev) => prev && prev.elementId === active.elementId
          ? { ...prev, loading: true, hasDetected: false, error: '', blocks: [], erasePrompt: '' }
          : prev);
        setFeedback('正在让当前聊天模型理解 ' + regions.length + ' 个文字选区…');
        const requestBody = { ...current, imageData: active.dataURL, name: active.name, crops: regions, ...(activeChatModelSelection || {}) };
        fetch('/dsh-canvas/ocr-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || 'OCR 识别失败');
            setTextRebuild((prev) => prev && prev.elementId === active.elementId
              ? { ...prev, loading: false, hasDetected: true, blocks: Array.isArray(result.data.blocks) ? result.data.blocks : [], erasePrompt: result.data.erasePrompt || '', engine: result.data.engine || 'tesseract', width: Number(result.data.width || prev.width || 0), height: Number(result.data.height || prev.height || 0) }
              : prev);
            const engineLabel = result.data.engine === 'current-chat-model' ? ('当前聊天模型 ' + (result.data.model || '')) : '本地 OCR 兜底';
            setFeedback('✓ ' + engineLabel + ' 已理解选区内 ' + Number((result.data.blocks || []).length) + ' 个文字对象，请确认后执行' + (result.data.warning ? '；' + result.data.warning : ''));
          })
          .catch((err) => setTextRebuild((prev) => prev && prev.elementId === active.elementId
            ? { ...prev, loading: false, error: '⚠ OCR 失败：' + String((err && err.message) || err) }
            : prev));
      };
      const updateTextRebuildSelections = (regions) => {
        const normalized = (Array.isArray(regions) ? regions : []).filter((item) => item && Number(item.width || 0) >= 6 && Number(item.height || 0) >= 6).slice(0, 24);
        setTextRebuild((prev) => prev ? { ...prev, selection: normalized.length === 1 ? normalized[0] : null, selections: normalized } : prev);
      };
      const onFrameMessage = (event) => {
        const frame = frameRef.current;
        if (!frame || event.source !== frame.contentWindow) return;
        const d = event.data || {};
        // 画布尚未就绪时创建占位被延后:移出待办,下一轮轮询(2s 后)自动重建,
        // 生成中的占位不会因为撞上画布冷启动窗口而丢失。
        if (d.type === 'chat-gen-placeholder-deferred' && d.id) {
          chatPendingRef.current = chatPendingRef.current.filter((id) => id !== d.id);
          return;
        }
        if (d.type === 'ready') {
          frameReady.current = true;
          setStatus('ready');
          pushDshTheme();
          if (!stateLoaded.current) {
            stateLoaded.current = true;
            const current = projectRef.current;
            if (current.project) {
              switchingProject.current = true;
              loadState(current.cwd, current.project).then((snap) => {
                if (snap) {
                  latestSnapshot.current = snap;
                  postSceneLoad(snap);
                } else {
                  switchingProject.current = false;
                  setFeedback('⚠ 已选择的项目没有 canvas.json');
                }
                setTimeout(() => { switchingProject.current = false; }, 5000);
              });
            } else {
              latestSnapshot.current = { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground(), openMenu: null }, files: {} };
              setFeedback('请选择、新建或导入画布项目');
            }
          }
          flushPending();
        } else if (d.type === 'size') {
          if (d.w < 100 || d.h < 100) console.error('canvas too small — tldraw CSS likely missing');
        } else if (d.type === 'snapshot-response') {
          const key = String(d.requestId || '');
          const resolve = snapshotWaiters.current.get(key);
          if (resolve) {
            snapshotWaiters.current.delete(key);
            let snapshot = d.snapshot || null;
            if (typeof snapshot === 'string') {
              try { snapshot = JSON.parse(snapshot); } catch (err) { snapshot = null; }
            }
            resolve(snapshot);
          }
        } else if (d.type === 'loaded') {
          switchingProject.current = false;
          // 水合会用 canvas.json 保存的旧背景色覆盖此前的主题推送；
          // 清空快照让定时器在下一拍重新推送 DSH 主题。
          lastPushedTheme.current = '';
          pushDshTheme();
          if (d.snapshot) {
            // loaded 只是“已恢复”的确认，不是一次用户编辑；保留从
            // canvas.json 读出的版本标记，避免把旧加载快照重新盖回项目。
            const loadedMeta = latestSnapshot.current && latestSnapshot.current.dshMeta;
            latestSnapshot.current = loadedMeta && typeof loadedMeta === 'object'
              ? { ...d.snapshot, dshMeta: loadedMeta }
              : d.snapshot;
          }
          setFeedback(projectRef.current.project ? '✓ 画布内容已恢复' : '请选择、新建或导入画布项目');
          flushPending();
        } else if (d.type === 'diagnostic') {
          setFeedback(d.error || ('恢复检查：元素 ' + d.elements + '/' + d.expected + '，文件 ' + d.files + '，DOM ' + d.dom + '，canvas ' + d.canvas + '，按钮 ' + d.buttons));
        } else if (d.type === 'added') {
          setFeedback('✓ 已加入画布' + (d.name ? '：' + d.name : ''));
        } else if (d.type === 'rename-image') {
          const current = projectRef.current;
          pendingRenames.current.set(d.id, { oldPath: d.sourcePath || '', requestedName: d.newName || '' });
          fetch('/dsh-canvas/rename-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, fileId: d.fileId, oldName: d.oldName, newName: d.newName, sourcePath: d.sourcePath || '' }) })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '重命名失败');
              const resultPath = result.data.sourcePath || result.data.path || d.sourcePath || '';
              // 先修补父页面缓存，再通知 iframe 更新 Excalidraw。这样
              // saveNow() 即使早于 iframe 的 changed 事件执行，也不会把旧源
              // 路径写回 canvas.json。
              if (latestSnapshot.current && Array.isArray(latestSnapshot.current.elements)) {
                latestSnapshot.current = {
                  ...latestSnapshot.current,
                  elements: latestSnapshot.current.elements.map((item) => item && item.id === d.id
                    ? { ...item, customData: { ...(item.customData || {}), dshFileName: result.data.name || d.newName, dshSourcePath: resultPath } }
                    : item)
                };
              }
              // 保留短暂保护窗口，覆盖“磁盘已改名、iframe 尚未收到
              // rename-result、项目轮询先返回”的最后一个竞态。
              pendingRenames.current.set(d.id, { oldPath: d.sourcePath || '', requestedName: d.newName || '', expiresAt: Date.now() + 5000 });
              setFeedback('✓ 图片已重命名：' + result.data.name);
              post({ type: 'rename-result', id: d.id, name: result.data.name, sourcePath: resultPath });
              saveNow();
            })
            .catch((err) => { pendingRenames.current.delete(d.id); setFeedback('⚠ 图片重命名失败：' + String((err && err.message) || err)); });
        } else if (d.type === 'source-refreshed') {
          setFeedback('✓ 已同步源文件更新：' + String(d.name || '图片'));
        } else if (d.type === 'aspect-ratio-repaired') {
          setFeedback('✓ 已自动修复 ' + Number(d.count || 0) + ' 张 PSD 的显示比例');
        } else if (d.type === 'arranged') {
          const orderLabels = { name: '文件名', type: '文件类型', time: '修改时间', pixels: '图片尺寸', bytes: '文件大小' };
          setFeedback(d.count ? ('✓ 已按' + (orderLabels[d.order] || '文件名') + '整理 ' + d.count + ' 张图片' + (d.groups > 1 ? '，分成 ' + d.groups + ' 个格式区块' : '') + (d.tag ? '（仅整理标记图片）' : '')) : '画布中没有符合条件的可整理图片');
        } else if (d.type === 'tag-images') {
          setFeedback('✓ 已' + (d.color ? '更新 ' : '清除 ') + Number(d.count || 0) + ' 张图片的颜色标记');
        } else if (d.type === 'duplicated') {
          setFeedback('✓ 已在画布中复制 ' + Number(d.count || 0) + ' 张图片');
        } else if (d.type === 'deleted-selection') {
          // 删除操作会先于 Excalidraw 的常规 onChange 通知到达；优先使用
          // 删除事件携带的即时快照，并立刻刷新到项目文件，避免切聊天时复活。
          let deletedSnapshot = d.snapshot || null;
          if (typeof deletedSnapshot === 'string') {
            try { deletedSnapshot = JSON.parse(deletedSnapshot); } catch (err) { deletedSnapshot = null; }
          }
          if (deletedSnapshot && typeof deletedSnapshot === 'object') latestSnapshot.current = markCanvasChanged(deletedSnapshot, latestSnapshot.current || {});
          void flushSave();
          setFeedback('✓ 已删除 ' + Number(d.count || 0) + ' 张图片，可用撤销恢复');
        } else if (d.type === 'request-photoshop-edit') {
          const current = projectRef.current;
          setFeedback('正在 Photoshop 中打开链接图片…');
          fetch('/dsh-canvas/open-in-photoshop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: d.elementId, fileId: d.fileId, name: d.name, sourcePath: d.sourcePath, sourceKind: d.sourceKind, dataURL: d.dataURL })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || 'Photoshop 打开失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              post({ type: 'bind-managed', elementId: d.elementId, path: image.path, name: image.name, mtime: image.mtime, size: image.size, kind: image.kind, managed: image.managed });
              photoshopWatch.current = result.data.photoshopWatch || null;
              setFeedback('✓ 已在 Photoshop 打开' + (image.kind === 'psd' ? ' PSD 母版' : '链接图片') + '；保存后切回画布即自动检查更新');
            })
            .catch((err) => setFeedback('⚠ Photoshop 打开失败：' + String((err && err.message) || err)));
        } else if (d.type === 'request-illustrator-edit') {
          const current = projectRef.current;
          setFeedback('正在 Illustrator 中打开源文件…');
          fetch('/dsh-canvas/open-in-illustrator', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: d.elementId, name: d.name, sourcePath: d.sourcePath, sourceKind: d.sourceKind })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || 'Illustrator 打开失败');
              setFeedback('✓ 已在 Illustrator 中打开 ' + String(result.data.kind || d.sourceKind || '源文件') + '；保存后画布约 8 秒内更新');
            })
            .catch((err) => setFeedback('⚠ Illustrator 打开失败：' + String((err && err.message) || err)));
        } else if (d.type === 'request-bridge-return') {
          // 画布「→Ps / →Ai」：写入项目 ADOBE桥接/发件箱，由 PS/AI 的 DSH画布桥接 面板置入（adobe-bridge/PROTOCOL.md §4）。
          void requestAdobeBridgeReturn(projectRef.current, d, setFeedback);
        } else if (d.type === 'material-drag-start') {
          canvasMaterialDrag.current = Array.isArray(d.items) ? d.items.filter((item) => item && item.dataURL) : [];
          setMaterialDropActive(false);
        } else if (d.type === 'material-drag-end') {
          setTimeout(() => { canvasMaterialDrag.current = []; setMaterialDropActive(false); }, 1200);
        } else if (d.type === 'save-to-materials') {
          saveMaterialItems(d.items || [], d.source === 'context-menu' ? '右键所选图片已加入当前素材库' : '画布所选图片已加入当前素材库')
            .catch((err) => setFeedback('⚠ 加入当前素材库失败：' + String(err.message || err)));
        } else if (d.type === 'request-text-rebuild') {
          const base = { elementId: d.elementId, name: d.name || '当前图片', dataURL: d.imageData || '', loading: false, busy: false, hasDetected: false, blocks: [], erasePrompt: '', selection: null, selections: [], width: 0, height: 0, error: '' };
          setTextRebuild(base);
          setFeedback('请先框选需要移除并重建的文字区域，再点击“识别选区”');
        } else if (d.type === 'request-text-rebuild-export') {
          const current = projectRef.current;
          const active = textRebuild;
          if (!active || active.busy) return;
          setTextRebuild({ ...active, busy: true, error: '' });
          fetch('/dsh-canvas/export-text-psd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: active.elementId, name: active.name, imageData: active.dataURL, width: Number(active.width || 0), height: Number(active.height || 0), selection: active.selection || null, selections: Array.isArray(active.selections) ? active.selections : [], blocks: d.blocks || [], erasePrompt: active.erasePrompt || '', cleanBackground: true, openPhotoshop: d.openPhotoshop !== false })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || 'PSD 生成失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              pendingRef.current.push({ ...image, explicit: true });
              flushPending();
              setTextRebuild(null);
              const cleanup = result.data.cleanedBackground ? ('；背景已由 ' + (result.data.cleanupEngine || 'image2') + ' 局部清理') : '；未完成背景清理，已保留原图';
              const suffix = result.data.photoshop ? '已写入 Photoshop 文字层' : '已生成 PSD 草稿（文字层需在 Photoshop 中继续整理）';
              setFeedback('✓ ' + suffix + cleanup + '，文件已加入画布：' + image.name + (result.data.warning ? '；' + result.data.warning : ''));
            })
            .catch((err) => setTextRebuild((prev) => prev ? { ...prev, busy: false, error: '⚠ PSD 生成失败：' + String((err && err.message) || err) } : prev));
        } else if (d.type === 'request-remove-background') {
          const current = projectRef.current;
          if (removeProgressTimer.current) {
            setFeedback('已有去背景任务正在进行，请稍候…');
            return;
          }
          const jobId = 'bg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          const progressUrl = '/dsh-canvas/remove-background-progress?cwd=' + encodeURIComponent(current.cwd || '') + '&project=' + encodeURIComponent(current.project || '') + '&jobId=' + encodeURIComponent(jobId);
          const updateProgress = (progress) => {
            if (!progress) return;
            setRemoveProgress(progress);
            post({ type: 'placeholder-progress', placeholderId: d.placeholderId, percent: progress.percent, stage: progress.stage, message: progress.message });
            const value = Number(progress.percent);
            const suffix = Number.isFinite(value) ? ' ' + Math.round(Math.max(0, Math.min(100, value))) + '%' : '';
            if (progress.stage !== 'complete' && progress.stage !== 'error') setFeedback(String(progress.message || '本地去背景处理中…') + suffix);
          };
          setRemoveProgress({ ok: true, jobId, stage: 'starting', message: '正在启动本地 rembg…', percent: 1 });
          setFeedback('正在准备本地 rembg… 1%');
          removeProgressTimer.current = window.setInterval(() => {
            fetch(progressUrl, { cache: 'no-store' })
              .then((r) => r.json())
              .then(updateProgress)
              .catch(() => {});
          }, 700);
          fetch('/dsh-canvas/remove-background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, jobId, elementId: d.elementId, fileId: d.fileId, name: d.name, imageData: d.imageData, imagePath: d.imagePath })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '本地去背景失败');
              clearInterval(removeProgressTimer.current);
              removeProgressTimer.current = null;
              setRemoveProgress({ ok: true, jobId, stage: 'complete', message: '去背景完成', percent: 100 });
              if (result.data.image && result.data.image.path) {
                queuedDiskPaths.current.add(result.data.image.path);
                if (knownDiskPaths.current) knownDiskPaths.current.add(result.data.image.path);
              }
              post({ type: 'image-remove-bg-result', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, ...result.data });
              setFeedback('✓ 去背景完成（rembg isnet-general-use），已生成透明 PNG');
              window.setTimeout(() => setRemoveProgress(null), 1600);
            })
            .catch((err) => {
              clearInterval(removeProgressTimer.current);
              removeProgressTimer.current = null;
              const message = String((err && err.message) || err);
              setRemoveProgress({ ok: false, jobId, stage: 'error', message, percent: null });
              post({ type: 'image-remove-bg-error', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, message });
              setFeedback('⚠ 去背景失败：' + message);
              window.setTimeout(() => setRemoveProgress(null), 5000);
            });
        } else if (d.type === 'request-vectorize') {
          const current = projectRef.current;
          setFeedback('正在分析图片复杂度并选择本地矢量化程序…');
          fetch('/dsh-canvas/vectorize-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: d.elementId, fileId: d.fileId, name: d.name, imageData: d.imageData, imagePath: d.imagePath, backend: d.backend || 'auto', vectorMode: d.vectorMode || 'flat' })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || '本地矢量化失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              post({ type: 'image-vectorized-result', requestId: d.requestId, elementId: d.elementId, ...result.data });
              const complexity = result.data.complexity && result.data.complexity.class ? '（' + result.data.complexity.class + '）' : '';
              const modeLabel = result.data.vectorMode === 'flat' ? '结构化模式' : (result.data.vectorMode === 'silhouette' ? '轮廓模式' : '全量模式');
              const quality = result.data.quality || {};
              const qualityLabel = quality.pathCount ? '（' + quality.pathCount + ' 条路径）' : '';
              const qualityWarning = Array.isArray(quality.warnings) && quality.warnings.length ? '；' + quality.warnings[0] : '';
              setFeedback('✓ 已用 ' + modeLabel + ' + ' + String(result.data.backend || '本地程序') + ' 生成 SVG' + complexity + qualityLabel + '，已加入画布' + qualityWarning);
            })
            .catch((err) => setFeedback('⚠ 转矢量失败：' + String((err && err.message) || err)));
        } else if (d.type === 'import-external-file') {
          // 外部拖入是用户明确操作，允许导入；普通 agent 工具结果不会发送此消息。
          if (d.explicit !== true) {
            setFeedback('已忽略非用户发起的文件导入');
            return;
          }
          const current = projectRef.current;
          if (!current.project) {
            setFeedback('请先新建或切换画布项目，再导入 SVG/PDF/AI');
            return;
          }
          setFeedback('正在导入 ' + String(d.name || '文件') + ' 并生成预览…');
          fetch('/dsh-canvas/import-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, sourcePath: d.sourcePath || '', name: d.name || '', kind: d.kind || '', dataURL: d.dataURL || '' })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || '文件导入失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              pendingRef.current.push({ ...image, explicit: true });
              flushPending();
              setFeedback('✓ 已导入 ' + image.name + '，画布会随文件修改自动刷新');
            })
            .catch((err) => setFeedback('⚠ 导入文件失败：' + String((err && err.message) || err)));
        } else if (d.type === 'request-image-edit') {
          const current = projectRef.current;
          setFeedback(d.mode === 'erase' ? '智能擦除处理中：优先 Codex，失败自动切换 image2 API…' : '图片编辑处理中：不占用聊天上下文…');
          fetch('/dsh-canvas/edit-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(20 * 60 * 1000),
            body: JSON.stringify({ ...current, elementId: d.elementId, fileId: d.fileId, name: d.name, imageData: d.imageData, imagePath: d.imagePath, editRootPath: d.editRootPath, editHistory: d.editHistory, editDepth: d.editDepth, mode: d.mode, prompt: d.prompt, maskData: d.maskData, width: d.width, height: d.height })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '图片编辑失败');
              if (result.data.image && result.data.image.path) {
                queuedDiskPaths.current.add(result.data.image.path);
                if (knownDiskPaths.current) knownDiskPaths.current.add(result.data.image.path);
              }
              post({ type: 'image-edit-result', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, ...result.data });
              const engineLabel = result.data.engine === 'image2-api' ? 'image2 API 兜底' : 'Codex';
              setFeedback('✓ ' + (d.mode === 'erase' ? '智能擦除' : '图片编辑') + '完成（' + engineLabel + '），已生成新图');
            })
            .catch((err) => {
              const message = String((err && err.message) || err);
              post({ type: 'image-edit-error', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, message, retryItem: { mode: d.mode, id: d.elementId, fileId: d.fileId, name: d.name, dataURL: d.imageData, width: d.width, height: d.height, sourcePath: d.imagePath, editRootPath: d.editRootPath, editHistory: d.editHistory, editDepth: d.editDepth, prompt: d.prompt, maskData: d.maskData, retryToken: Date.now() } });
              setFeedback('⚠ 图片编辑失败：' + message);
            });
        } else if (d.type === 'image-edit-added') {
          setFeedback('✓ 新图片已加入画布：' + String(d.name || '编辑结果'));
        } else if (d.type === 'request-send-selection-item') {
          if (d.image && d.image.dataURL) {
            window.dispatchEvent(new CustomEvent('dsh-canvas:attach-selection', {
              detail: { images: [d.image], batchId: d.batchId || '', index: Number(d.index || 1), total: Number(d.total || 1) }
            }));
            setFeedback('✓ 正在发送图片到聊天输入框：' + Number(d.index || 1) + '/' + Number(d.total || 1));
          } else {
            setFeedback('⚠ 第 ' + Number(d.index || 1) + ' 张所选图片无法读取');
          }
        } else if (d.type === 'request-send-selection') {
          // 优先使用 iframe 从当前 Excalidraw 实例直接读取的数据。旧逻辑仅凭
          // element id 查询节流后的 latestSnapshot，刚导入、刚刷新 PSD 或切换
          // 项目时快照可能尚未带上 files，导致“发送至聊天”无响应。
          let images = Array.isArray(d.images) ? d.images.filter((item) => item && item.dataURL) : [];
          if (!images.length) {
            const ids = new Set(Array.isArray(d.ids) ? d.ids : []);
            const snap = latestSnapshot.current || {};
            const imageEls = (snap.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted && ids.has(item.id));
            images = imageEls.map((item, index) => {
              const selectedFile = snap.files && snap.files[item.fileId];
              const fileName = item.customData && item.customData.dshFileName;
              return selectedFile && selectedFile.dataURL ? { dataURL: selectedFile.dataURL, name: fileName || ('canvas-selection-' + (index + 1) + '-' + String(item.id).slice(-6)) } : null;
            }).filter(Boolean);
          }
          if (images.length) {
            window.dispatchEvent(new CustomEvent('dsh-canvas:attach-selection', { detail: { images } }));
            setFeedback('✓ 已发送 ' + images.length + ' 张到聊天输入框');
          } else {
            setFeedback('⚠ 所选图片暂时无法读取，请稍后重试');
          }
        } else if (d.type === 'chat-gen-resolve-failed' && d.path) {
          // 占位替换失败(占位被删/画布重载等):立即把成图按兜底路径放上画布
          // (视口锚点 + 240 盒装,与其它生成图同规格),不再等文件扫描慢半拍地救回。
          dispatchGeneratedToCanvas(String(d.path));
          setFeedback('⚠ ' + (d.message || '占位替换失败') + '，成图已放到画布当前视野');
        } else if (d.type === 'chat-gen-soft-error') {
          // 聊天生图占位/上画布的可恢复失败:只提示,不打成全局「加载失败」
          setFeedback('⚠ ' + (d.message || '聊天生图未能上画布'));
        } else if (d.type === 'error') {
          setStatus('error');
          setFeedback('⚠ ' + (d.message || 'iframe 错误'));
          console.error('canvas iframe error:', d.message);
        } else if (d.type === 'changed') {
          if (switchingProject.current) return;
          if (!d.token || d.token !== canvasLoadToken.current) { console.warn('[canvas] 丢弃跨场景迟到 changed，token 不匹配'); return; }
          const previous = latestSnapshot.current || {};
          // files 增量合并：iframe 的 changed 快照只带 usedFileIds 与新增/变化
          // 文件，与父层已有 files 按“在用集合”合并成完整文件表；旧版全量
          // 快照（无 usedFileIds 字段）保持原行为兼容。删除图片时 usedFileIds
          // 不再包含其 fileId，合并结果自动收缩，与旧全量语义一致。
          const incomingSnapshot = d.snapshot || {};
          if (!Array.isArray(incomingSnapshot.usedFileIds)) {
            // 旧版全量快照兼容 + 防清空守卫：任何"存活图片元素"的 fileId 若在
            // incoming.files 中缺失（如还原失败/部分场景），一律从 previous.files
            // 补齐——文件表只允许因元素被删除而收缩，不允许因数据缺失而收缩。
            const prevFiles = previous.files || {};
            const incFiles = incomingSnapshot.files || {};
            let filled = false;
            (incomingSnapshot.elements || []).forEach((item) => {
              if (!item || item.type !== 'image' || item.isDeleted || !item.fileId) return;
              if (!incFiles[item.fileId] && prevFiles[item.fileId]) { incFiles[item.fileId] = prevFiles[item.fileId]; filled = true; }
            });
            if (filled) incomingSnapshot.files = incFiles;
          }
          if (Array.isArray(incomingSnapshot.usedFileIds)) {
            const mergedFiles = {};
            const previousFiles = previous.files || {};
            for (const usedId of incomingSnapshot.usedFileIds) {
              if (previousFiles[usedId]) mergedFiles[usedId] = previousFiles[usedId];
            }
            Object.assign(mergedFiles, incomingSnapshot.files || {});
            incomingSnapshot.files = mergedFiles;
          }
          const snap = markCanvasChanged(incomingSnapshot, previous);
          const previousLive = (previous.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
          const liveImages = (snap.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
          const liveIds = new Set(liveImages.map((item) => item.id));
          const nextLivePaths = new Set(liveImages.map((item) => item.customData && item.customData.dshSourcePath).filter(Boolean));
          const removed = previousLive.filter((item) => !liveIds.has(item.id));
          if (removed.length && !clearInProgress.current) scheduleRemovedImages(removed, nextLivePaths);

          const projectPath = currentProjectPath();
          const assetsRoot = projectPath ? projectPath.replace(/[\\/]+$/, '') + '/assets' : '';
          const seenPaths = new Set();
          const seenFiles = new Set();
          for (const item of liveImages) {
            const pendingTimer = pendingArchiveTimers.current.get(item.id);
            if (pendingTimer) { clearTimeout(pendingTimer); pendingArchiveTimers.current.delete(item.id); }
            const custom = item.customData || {};
            const path = custom.dshSourcePath || '';
            const sourceKind = String(custom.dshSourceKind || '').toLowerCase();
            const sourceExtMatch = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
            const sourceExt = sourceExtMatch ? sourceExtMatch[1] : '';
            const isDocumentSource = ['svg', 'pdf', 'ai'].indexOf(sourceKind) >= 0 || ['svg', 'pdf', 'ai'].indexOf(sourceExt) >= 0;
            const fileDataURL = snap.files && snap.files[item.fileId] && snap.files[item.fileId].dataURL || '';
            const fileMimeMatch = String(fileDataURL).match(/^data:([^;]+)/i);
            const fileMime = fileMimeMatch ? String(fileMimeMatch[1]).toLowerCase() : '';
            const isRasterFile = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].indexOf(fileMime) >= 0;
            const duplicate = (path && seenPaths.has(path)) || (item.fileId && seenFiles.has(item.fileId));
            const needsManagedFile = custom.dshManaged === true && (!path || !canvasPathWithin(assetsRoot, path));
            const archived = archivedImages.current.get(item.id);
            if (archived) {
              restoreArchivedElement(item, archived);
            } else if (!isDocumentSource && isRasterFile && (duplicate || needsManagedFile)) {
              // SVG/PDF/AI 的 file.dataURL 是预览或矢量内容，不是栅格图片；
              // 不能再送进 materialize-image 的栅格解码器，否则会报“图片数据无效”。
              // 这些源文件已经由导入/矢量化流程落在项目 assets 中，直接保留源路径。
              materializeElement(item, snap.files && snap.files[item.fileId], duplicate);
            }
            if (path) seenPaths.add(path);
            if (item.fileId) seenFiles.add(item.fileId);
          }
          latestSnapshot.current = snap;
          if (clearInProgress.current && !liveImages.length) clearInProgress.current = false;
          // 删除必须立即进入写入队列；仅靠 1.5 秒防抖会给切换聊天/卸载
          // 留出窗口，导致另一个聊天读到删除前的旧快照。
          if (removed.length) saveNow();
          else scheduleSave();
        } else if (d.type === 'exported') {
          if (d.dataUrl) {
            const a = document.createElement('a');
            a.href = d.dataUrl;
            a.download = 'canvas.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
          } else if (d.error && d.error !== 'empty') {
            console.error('canvas export failed:', d.error);
          }
        }
      };

      React.useEffect(() => {
        const onAdd = (e) => {
          const detail = e.detail || {};
          if (!detail.url || detail.explicit !== true || detail.token !== CANVAS_ADD_TOKEN) return;
          setMode(true);
          if (!projectRef.current.project) {
            setFeedback('请先新建或切换画布项目，再加入图片');
            return;
          }
          pendingRef.current.push(detail);
          flushPending();
        };
        window.addEventListener('dsh-canvas:add-image', onAdd);
        const openProjectListRef = { current: null };
        const onProjectPick = () => { if (openProjectListRefHolder.current) openProjectListRefHolder.current(); };
        const onProjectNew = () => { setMoreMenuOpen(false); setProjectDialog({ mode: 'new', value: '新画布项目' }); };
        const onProjectDismiss = () => {
          const current = projectRef.current || {};
          chatProjectAskedRef.current = { sessionId: current.sessionId || '', dismissed: true };
          window.__dshCanvasGenAskState = '';
          window.dispatchEvent(new CustomEvent('dsh-canvas:gen-state', { detail: { show: false } }));
        };
        window.addEventListener('dsh-canvas:project-pick', onProjectPick);
        window.addEventListener('dsh-canvas:project-new', onProjectNew);
        window.addEventListener('dsh-canvas:project-dismiss', onProjectDismiss);
        const onProjectContext = (event) => {
          // 会话切换会重新挂载聊天输入区，即使 cwd 未变也必须重新测量分栏。
          notifySplitLayout();
          const cwd = event.detail && typeof event.detail.cwd === 'string' ? event.detail.cwd : '';
          const sessionId = event.detail && event.detail.sessionId ? String(event.detail.sessionId) : '';
          if (!cwd) return;
          const current = projectRef.current;
          if (current.cwd === cwd && current.sessionId === sessionId) return;
          const project = chosenProject(cwd, sessionId, !current.cwd && !current.sessionId);
          if (project) {
            loadProject({ cwd, sessionId, project }, true);
            return;
          }
          clearTimeout(saveTimer.current);
          const preserve = latestSnapshot.current && current.project ? flushSave() : Promise.resolve();
          // 即使目标聊天没有绑定项目，也必须等当前项目写入完成后再清空界面。
          // 否则用户马上切回原聊天时，loadState 可能先读到删除前的旧快照。
          Promise.resolve(preserve).then(() => {
            // 保存期间可能又切回了原聊天；过期的清空动作不能覆盖当前画布。
            if (activeChatCwd !== cwd || activeChatSessionId !== sessionId) return;
            const emptySnapshot = { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground(), openMenu: null }, files: {} };
            projectRef.current = { cwd, sessionId, project: '' };
            setProjectInfo({ cwd, sessionId, project: '' });
            latestSnapshot.current = emptySnapshot;
            switchingProject.current = true;
            postSceneLoad(emptySnapshot);
            setTimeout(() => { switchingProject.current = false; }, 1000);
            setFeedback('已切换聊天；请选择、新建或导入画布项目');
          });
        };
        window.addEventListener('dsh-canvas:project-context', onProjectContext);
        window.addEventListener('message', onFrameMessage);
        // 不依赖两个独立 React 插槽的 effect 执行先后；画布晚挂载时主动补领当前会话上下文。
        if (activeChatCwd) onProjectContext({ detail: { cwd: activeChatCwd, sessionId: activeChatSessionId } });
        return () => {
          window.removeEventListener('dsh-canvas:add-image', onAdd);
          window.removeEventListener('dsh-canvas:project-pick', onProjectPick);
          window.removeEventListener('dsh-canvas:project-new', onProjectNew);
          window.removeEventListener('dsh-canvas:project-dismiss', onProjectDismiss);
          window.removeEventListener('dsh-canvas:project-context', onProjectContext);
          window.removeEventListener('message', onFrameMessage);
          clearTimeout(saveTimer.current);
          clearInterval(removeProgressTimer.current);
          removeProgressTimer.current = null;
          saveQueued.current = false;
          for (const timer of pendingArchiveTimers.current.values()) clearTimeout(timer);
          pendingArchiveTimers.current.clear();
        };
      }, []);

      React.useEffect(() => {
        if (!on) return undefined;
        let disposed = false;
        let pollTimer = 0;
        let activeController = null;
        knownDiskPaths.current = null;
        queuedDiskPaths.current.clear();
        const scheduleNext = () => {
          clearTimeout(pollTimer);
          pollTimer = 0;
          if (disposed || document.visibilityState !== 'visible' || !currentProjectPath()) return;
          pollTimer = setTimeout(() => {
            pollTimer = 0;
            syncProjectFiles();
          }, PROJECT_SYNC_INTERVAL);
        };
        const syncProjectFiles = () => {
          clearTimeout(pollTimer);
          pollTimer = 0;
          if (disposed || document.visibilityState !== 'visible') return;
          if (projectSyncBusy.current || clearInProgress.current) { scheduleNext(); return; }
          const current = projectRef.current;
          if (!currentProjectPath()) return;
          const snapshot = latestSnapshot.current || {};
          const liveImages = (snapshot.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
          const projectRoot = currentProjectPath();
          const sourceElements = liveImages.filter((item) => item.customData && canvasPathWithin(projectRoot, item.customData.dshSourcePath || ''));
          const externalSourceElements = liveImages.filter((item) => item.customData && item.customData.dshSourcePath && !canvasPathWithin(projectRoot, item.customData.dshSourcePath));
          const sourcePaths = new Set(sourceElements.map((item) => item.customData.dshSourcePath));
          for (const path of sourcePaths) queuedDiskPaths.current.delete(path);
          projectSyncBusy.current = true;
          activeController = new AbortController();
          const requestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current), signal: activeController.signal };
          const collectPhotoshopOutputs = () => {
            const watch = photoshopWatch.current;
            if (!watch || !watch.directory) return Promise.resolve();
            return fetch('/dsh-canvas/photoshop-outputs', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...current, directory: watch.directory, baseline: watch.baseline || [] }),
              signal: activeController && activeController.signal
            }).then((r) => r.json()).then((checked) => {
              if (disposed || !checked || !checked.ok || !Array.isArray(checked.outputs)) return;
              const projectRoot = currentProjectPath();
              const linkedPaths = new Set(((latestSnapshot.current && latestSnapshot.current.elements) || []).filter((item) => item && item.type === 'image' && !item.isDeleted).map((item) => item.customData && item.customData.dshSourcePath).filter(Boolean));
              checked.outputs.forEach((output) => {
                // Existing linked PSDs are refreshed by refresh-source above.
                // This watcher is only responsible for a new Photoshop Save As
                // result, otherwise saving an already-linked PSD would duplicate it.
                if (!output || !output.path || linkedPaths.has(output.path) || queuedDiskPaths.current.has(output.path)) return;
                queuedDiskPaths.current.add(output.path);
                // Update the baseline immediately so the same Save As result is
                // never enqueued twice while its preview is loading.
                const baseline = Array.isArray(watch.baseline) ? watch.baseline : [];
                const previous = baseline.find((item) => item && item.path === output.path);
                if (previous) { previous.mtime = output.mtime; previous.size = output.size; }
                else baseline.push({ path: output.path, mtime: output.mtime, size: output.size });
                watch.baseline = baseline;
                if (canvasPathWithin(projectRoot, output.path)) {
                  pendingRef.current.push({ ...output, explicit: true });
                  flushPending();
                  setFeedback('✓ Photoshop 新建/保存的 PSD 已加入画布：' + output.name);
                  return;
                }
                fetch('/dsh-canvas/import-file', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...current, sourcePath: output.path, name: output.name, kind: 'psd' })
                }).then((r) => r.json().then((data) => ({ ok: r.ok, data }))).then((result) => {
                  if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || 'PSD 导入失败');
                  const image = result.data.image;
                  queuedDiskPaths.current.add(image.path);
                  if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
                  pendingRef.current.push({ ...image, explicit: true });
                  flushPending();
                  setFeedback('✓ Photoshop 新建/保存的 PSD 已加入画布：' + image.name);
                }).catch((err) => {
                  queuedDiskPaths.current.delete(output.path);
                  setFeedback('⚠ Photoshop PSD 同步失败：' + String((err && err.message) || err));
                });
              });
            });
          };
          fetch('/dsh-canvas/project-files', requestInit)
            .then((r) => r.json())
            .then((result) => {
              if (disposed || !result || !result.ok || !Array.isArray(result.images)) return;
              const filesByPath = new Map(result.images.map((item) => [item.path, item]));
              const diskPaths = new Set(filesByPath.keys());
              for (const path of [...queuedDiskPaths.current]) if (!diskPaths.has(path)) queuedDiskPaths.current.delete(path);
              const updates = new Map();
              const missingIds = [];
              for (const element of sourceElements) {
                const source = element.customData || {};
                // 图层编辑的临时提取图（dshScratch）落在 outputs/ 下，而项目素材扫描在 depth 0
                // 就跳过 outputs/，它永远不会出现在 project-files 列表里。若不跳过，这里的
                // “访达删除对账”会在加入画布约 2 秒后就把元素移除，提交编辑时报“原图已不在画布中”。
                // 图层编辑的两类残留自愈：占位图（dshEditState=processing）与临时提取图
                // （dshScratch）的源文件都在 outputs/.图片编辑临时/ 下、不在 project-files
                // 列表里（扫描跳过 outputs/）。写回成功的清理消息偶尔被时序吞掉——这里
                // 兜底：占位图存活超过 10 分钟直接移除；临时提取图超过 30 分钟也移除。
                const nowMs = Date.now();
                if (source.dshEditState === 'processing') {
                  const started = Number(source.dshEditStartedAt || 0);
                  if (!started || nowMs - started > 10 * 60 * 1000) { finderRemovingIds.current.add(element.id); missingIds.push(element.id); continue; }
                }
                if (source.dshScratch === true) {
                  const born = Number(source.dshSourceMtime || 0);
                  if (!born || nowMs - born > 30 * 60 * 1000) { finderRemovingIds.current.add(element.id); missingIds.push(element.id); continue; }
                  continue;
                }
                const disk = filesByPath.get(source.dshSourcePath);
                if (!disk) {
                  const pendingRename = pendingRenames.current.get(element.id);
                  if (pendingRename && (!pendingRename.expiresAt || pendingRename.expiresAt > Date.now())) continue;
                  if (pendingRename) pendingRenames.current.delete(element.id);
                  finderRemovingIds.current.add(element.id);
                  missingIds.push(element.id);
                  continue;
                }
                if (Math.abs(Number(disk.mtime || 0) - Number(source.dshSourceMtime || 0)) > 1 || (Number(source.dshSourceSize || 0) > 0 && Number(disk.size || 0) !== Number(source.dshSourceSize || 0))) {
                  updates.set(element.id, disk.mtime);
                  post({ type: 'refresh-source', elementId: element.id, ...disk });
                }
              }
              if (missingIds.length) {
                post({ type: 'remove-sources', ids: missingIds });
                setFeedback('✓ 已同步访达删除：画布移除 ' + missingIds.length + ' 张图片');
              }
              // 项目目录新增文件 → 自动加入画布（对齐「文件夹实时刷新」的心智模型：
              // Illustrator/Photoshop 另存、访达拷贝进项目的新图，画布自动长出来）。
              // 基线快照法：首轮只建立基线不加；之后仅“基线外 + mtime 近 15 分钟 + 画布未挂”的才加，
              // 避免把历史文件一次性全倒上画布，也避免复活用户刚从画布删掉的旧图。
              try {
                const linked = new Set();
                for (const el of (latestSnapshot.current || {}).elements || []) {
                  if (el && el.type === 'image' && !el.isDeleted && el.customData && el.customData.dshSourcePath) linked.add(el.customData.dshSourcePath);
                }
                if (!autoAddBaseline.current) {
                  try {
                    const stored = localStorage.getItem('dsh-canvas-autoadd-baseline:' + currentProjectPath());
                    autoAddBaseline.current = stored ? new Set(JSON.parse(stored)) : new Set(diskPaths);
                  } catch (errBase) { autoAddBaseline.current = new Set(diskPaths); }
                } else {
                  const fresh = [];
                  for (const item of result.images || []) {
                    if (!item || !item.path) continue;
                    // ADOBE桥接/ 下的文件由桥接轮询器按清单上画布（要打出处印、要 ack），这里跳过以免重复添加。
                    if (isAdobeBridgePath(item.path)) continue;
                    if (autoAddBaseline.current.has(item.path) || linked.has(item.path) || queuedDiskPaths.current.has(item.path)) continue;
                    autoAddBaseline.current.add(item.path);
                    if (Number(item.mtime || 0) > Date.now() - 15 * 60 * 1000) fresh.push(item);
                  }
                  try { localStorage.setItem('dsh-canvas-autoadd-baseline:' + currentProjectPath(), JSON.stringify([...autoAddBaseline.current])); } catch (errSave) {}
                  if (fresh.length) {
                    for (const item of fresh) {
                      queuedDiskPaths.current.add(item.path);
                      if (knownDiskPaths.current) knownDiskPaths.current.add(item.path);
                      pendingRef.current.push({ ...item, explicit: true });
                    }
                    flushPending();
                    setFeedback('✓ 检测到项目新增文件，已加入画布：' + fresh.map((f) => f.name || f.path.split('/').pop()).join('、'));
                  }
                }
              } catch (errAuto) {}
              // 只有 iframe 成功读取新预览并更新场景后，changed 快照才会写入
              // 新 mtime。不能在这里乐观标记，否则 Photoshop 保存期间若预览
              // 暂时读取失败，后续轮询会误以为已经刷新而永不重试。
              knownDiskPaths.current = diskPaths;
            })
            .then(() => collectPhotoshopOutputs())
            .then(() => {
              if (disposed || !externalSourceElements.length) return undefined;
              const sources = externalSourceElements.map((item) => ({ elementId: item.id, path: item.customData.dshSourcePath, name: item.customData.dshFileName || '', mtime: Number(item.customData.dshSourceMtime || 0), size: Number(item.customData.dshSourceSize || 0) }));
              return fetch('/dsh-canvas/check-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources }), signal: activeController && activeController.signal })
                .then((r) => r.json())
                .then((checked) => {
                  if (disposed || !checked || !checked.ok || !Array.isArray(checked.changed)) return;
                  const missingIds = [];
                  for (const changed of checked.changed) {
                    if (changed.missing) missingIds.push(changed.elementId);
                    else post({ type: 'refresh-source', ...changed });
                  }
                  if (missingIds.length) post({ type: 'remove-sources', ids: missingIds });
                });
            })
            .catch(() => {})
            .finally(() => {
              projectSyncBusy.current = false;
              activeController = null;
              scheduleNext();
            });
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') syncProjectFiles();
          else {
            clearTimeout(pollTimer);
            pollTimer = 0;
            if (activeController) activeController.abort();
          }
        };
        const onWindowFocus = () => syncProjectFiles();
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('focus', onWindowFocus);
        syncProjectFiles();
        return () => {
          disposed = true;
          clearTimeout(pollTimer);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          window.removeEventListener('focus', onWindowFocus);
          if (activeController) activeController.abort();
          activeController = null;
          projectSyncBusy.current = false;
          knownDiskPaths.current = null;
          queuedDiskPaths.current.clear();
        };
      }, [on, projectInfo.cwd, projectInfo.project]);

      // Adobe 桥接轮询：心跳握手 + 把 PS/AI 面板送来的图层放上画布（features/adobe-bridge/00-bridge.js）。
      // 与上面的项目轮询互不干扰：桥接文件由这里按清单添加，通用自动上画布已跳过 ADOBE桥接/。
      React.useEffect(() => {
        if (!on) return undefined;
        const poller = createAdobeBridgePoller({
          getProject: () => projectRef.current,
          isLinked: (path) => ((latestSnapshot.current && latestSnapshot.current.elements) || []).some((el) => el && el.type === 'image' && !el.isDeleted && el.customData && el.customData.dshSourcePath === path),
          isQueued: (path) => queuedDiskPaths.current.has(path),
          addImages: (items) => {
            for (const item of items) {
              queuedDiskPaths.current.add(item.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(item.path);
              pendingRef.current.push(item);
            }
            flushPending();
          },
          setFeedback
        });
        poller.start();
        return () => poller.stop();
      }, [on, projectInfo.cwd, projectInfo.project]);

      // 「更多」菜单打开时查桥接安装状态：缺什么才显示对应安装按钮（features/adobe-bridge/00-bridge.js）。
      React.useEffect(() => {
        if (!on || !moreMenuOpen) return undefined;
        let cancelled = false;
        fetchAdobeBridgeInstallStatus().then((state) => { if (!cancelled) setAdobeInstall(state); });
        return () => { cancelled = true; };
      }, [on, moreMenuOpen]);

      const startResize = (e) => {
        e.preventDefault();
        const target = e.currentTarget;
        // Pointer Capture：拖拽期间所有指针事件（含 pointerup）强制发给分隔条，
        // 不会被面板内的 iframe / 其它元素吞掉，松开必然结束拖拽。
        try { target.setPointerCapture(e.pointerId); } catch (err) {}
        const pointerId = e.pointerId;
        const onMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const w = window.innerWidth - ev.clientX;
          setWidth(clampPanelWidth(w));
        };
        const onUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          try { target.releasePointerCapture(pointerId); } catch (err) {}
          target.removeEventListener('pointermove', onMove);
          target.removeEventListener('pointerup', onUp);
          target.removeEventListener('pointercancel', onUp);
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
        target.addEventListener('pointercancel', onUp);
      };

      const progressPercent = removeProgress && Number.isFinite(Number(removeProgress.percent))
        ? Math.max(0, Math.min(100, Number(removeProgress.percent)))
        : null;
      const style = { width: width + 'px' };
      const iframe = React.createElement('iframe', {
        ref: frameRef,
        srcDoc: EXCALIDRAW_SRCDOC_CLEAN,
        className: 'dsh-canvas-frame',
        title: 'Infinite Canvas'
      });
      const hidden = !on ? ' dsh-canvas-overlay-hidden' : '';
      const titlebarSafe = IS_WINDOWS_UI ? ' dsh-canvas-overlay-below-titlebar' : '';
      // Windows:每 2 秒实测一次标题栏高度写进内联样式(应用布局稳定前可能量不到)。
      React.useEffect(() => {
        if (!IS_WINDOWS_UI) return undefined;
        let stopped = false;
        const apply = () => {
          const measured = measureWindowsTitlebar();
          const root = document.querySelector('.dsh-canvas-overlay');
          if (root && !stopped) root.style.top = measured.height + 'px';
          return measured;
        };
        const first = apply();
        fetch('/dsh-canvas/client-debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: navigator.platform,
            ua: navigator.userAgent,
            isWindowsUI: IS_WINDOWS_UI,
            titlebar: first,
            at: Date.now()
          })
        }).catch(() => {});
        const timer = window.setInterval(apply, 2000);
        return () => { stopped = true; window.clearInterval(timer); };
      }, []);

      return React.createElement('div', { className: 'dsh-canvas-overlay' + titlebarSafe + hidden, style },
        React.createElement('div', {
          className: 'dsh-canvas-resizer',
          onPointerDown: startResize,
          title: '拖动调整宽度'
        }),
        React.createElement('div', { className: 'dsh-canvas-toolbar' },
          React.createElement('span', { className: 'dsh-canvas-title' }, '无限画布'),
          React.createElement('button', { className: 'dsh-canvas-project', title: '打开项目管理', onClick: openProjectList },
            React.createElement('span', { className: 'dsh-canvas-project-label' }, '项目：' + (projectInfo.project ? basename(projectInfo.project) : (projectInfo.cwd ? '未选择' : '未绑定'))),
            React.createElement('span', { className: 'dsh-canvas-project-chevron' }, '⌄')
          ),
          React.createElement('span', { className: 'dsh-canvas-status dsh-canvas-status-' + status },
            status === 'ready' ? '已就绪' : (status === 'error' ? '加载失败' : '加载中…')),

          removeProgress ? React.createElement('span', { className: 'dsh-canvas-operation-progress', title: String(removeProgress.message || '') },
            React.createElement('span', { className: 'dsh-canvas-operation-progress-track' },
              React.createElement('span', {
                className: 'dsh-canvas-operation-progress-fill' + (progressPercent === null ? ' is-indeterminate' : ''),
                style: progressPercent === null ? undefined : { width: progressPercent + '%' }
              })
            ),
            React.createElement('span', { className: 'dsh-canvas-operation-progress-label' }, progressPercent === null ? '处理中…' : Math.round(progressPercent) + '%')
          ) : null,
          feedback
            ? React.createElement('span', { className: 'dsh-canvas-feedback' }, feedback)
            : React.createElement('span', { className: 'dsh-canvas-hint' }, '图片可移动/缩放/旋转/裁剪 · 画笔标注'),
          React.createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
            React.createElement('button', { className: 'dsh-canvas-tb', title: '按类型/时间/尺寸/大小/名称或颜色标记整理画布图片，可撤销', onClick: () => setCanvasArrangeOpen((value) => !value) }, '整理图片'),
            canvasArrangeOpen ? React.createElement('div', { className: 'dsh-arrange-pop' },
              React.createElement('label', { className: 'dsh-arrange-field' }, '排序',
                React.createElement('select', { value: canvasArrangeOrder, onChange: (event) => setCanvasArrangeOrder(event.target.value) },
                  React.createElement('option', { value: 'name' }, '文件名称'),
                  React.createElement('option', { value: 'type' }, '文件类型'),
                  React.createElement('option', { value: 'time' }, '修改时间'),
                  React.createElement('option', { value: 'pixels' }, '图片尺寸'),
                  React.createElement('option', { value: 'bytes' }, '文件大小')
                )
              ),
              React.createElement('label', { className: 'dsh-arrange-field' }, '范围',
                React.createElement('select', { value: canvasArrangeTag, onChange: (event) => setCanvasArrangeTag(event.target.value) },
                  React.createElement('option', { value: '' }, '全部图片'),
                  React.createElement('option', { value: 'none' }, '仅未标记'),
                  MATERIAL_TAG_COLORS.map((color) => React.createElement('option', { key: color.id, value: color.id }, '仅' + color.label + '色标记'))
                )
              ),
              React.createElement('button', { className: 'dsh-arrange-run', onClick: () => { setCanvasArrangeOpen(false); post({ type: 'arrange-images', order: canvasArrangeOrder, tag: canvasArrangeTag }); } }, '整理'),
              React.createElement('button', { onClick: () => setCanvasArrangeOpen(false) }, '取消')
            ) : null
          ),
          React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => post({ type: 'export' }) }, '导出 PNG'),
          React.createElement('button', { className: 'dsh-canvas-tb', title: '本地素材库：常用图片发送到画布或聊天', onClick: () => openMaterials() }, '素材库'),
          React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-tb-adobe', title: '把 Photoshop 里当前选中的图层拉到画布（PS 需已打开文档并选中图层；不用在 PS 里点任何面板）', disabled: !projectInfo.project, onClick: () => { void pullFromAdobe(projectRef.current, 'photoshop', setFeedback); } }, '取 Ps 图层'),
          React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-tb-adobe', title: '把 Illustrator 里当前选中的对象拉到画布（AI 需已打开文档并选中对象；150 dpi 透明 PNG）', disabled: !projectInfo.project, onClick: () => { void pullFromAdobe(projectRef.current, 'illustrator', setFeedback, { dpi: 150 }); } }, '取 Ai 对象'),
          React.createElement('button', {
            className: 'dsh-canvas-tb dsh-canvas-more',
            title: '更多画布操作',
            onClick: () => setMoreMenuOpen((value) => !value)
          }, '更多 ···'),
          React.createElement('button', {
            className: 'dsh-canvas-tb dsh-canvas-tb-close',
            title: '收起画布面板，画布内容会保存',
            onClick: () => { saveNow(); clearTimeout(saveTimer.current); setMode(false); }
          }, '收起画布'),
          moreMenuOpen ? React.createElement('div', { className: 'dsh-canvas-more-menu' },
            updateInfo && updateInfo.supported === false ? null : React.createElement('button', {
              title: updateInfo && updateInfo.hasUpdate ? '一键更新到 ' + updateInfo.latest + '（应用自带安装器，完成后需重启 DSH）' : '检查 npm 上的最新版本（官方源/大陆镜像自动切换）',
              disabled: updating || (updateInfo && updateInfo.hasUpdate === false && updateInfo.latest),
              onClick: () => {
                if (!(updateInfo && updateInfo.hasUpdate)) { refreshUpdateInfo(false); return; }
                setUpdating(true);
                setFeedback('⏳ 正在更新到 ' + updateInfo.latest + '，完成后需重启 DSH…');
                fetch('/dsh-canvas/self-update', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
                  .then((r) => r.json())
                  .then((result) => {
                    setUpdating(false);
                    if (result && result.ok && result.installed) {
                      setFeedback('✓ 已更新到 ' + result.installed + '，请完全退出并重启 DSH 生效');
                      setMoreMenuOpen(false);
                    } else if (result && result.upToDate) {
                      setFeedback('✓ 已是最新版');
                    } else {
                      setFeedback('⚠ ' + String((result && result.error) || '更新失败').slice(0, 220));
                    }
                  })
                  .catch((err) => { setUpdating(false); setFeedback('⚠ 更新请求失败:' + String((err && err.message) || err)); });
              }
            }, updating ? '⏳ 更新中…' : (updateInfo && updateInfo.hasUpdate ? '🔄 更新到 ' + updateInfo.latest + '（当前 ' + updateInfo.current + '）' : '🔄 检查更新')),
            React.createElement('button', {
              title: '开启后画布背景跟随 macOS 系统外观，关闭则跟随 DSH 的主题设置',
              onClick: () => {
                const next = !canvasBgFollowSystem;
                bgFollowSystemRef.current = next;
                setCanvasBgFollowSystem(next);
                try { window.localStorage.setItem('dsh-canvas-bg-follow-system', next ? '1' : '0'); } catch (error) {}
                setFeedback(next ? '✓ 画布背景已改为跟随系统外观' : '✓ 画布背景已改为跟随 DSH 主题');
              }
            }, (canvasBgFollowSystem ? '☑' : '☐') + ' 画布背景跟随系统'),
            React.createElement('button', { onClick: () => { setMoreMenuOpen(false); openProjectFolder(); }, disabled: !projectInfo.project }, '📁 打开项目文件夹'),
            React.createElement('button', { onClick: openImageSettings }, '⚙ 图像引擎设置'),
            adobeInstall.scriptsInstalled ? null : React.createElement('button', { title: '检测到 Photoshop / Illustrator 的「文件 → 脚本」菜单里还没有 DSH 桥接入口。两款应用的脚本目录都属于系统管理员，会弹出 macOS 密码对话框（密码由系统收集，插件接触不到），只需一次；装完重启 PS/AI 生效，此按钮随之消失。不装也不影响画布里的「取 Ps 图层」「→Ps」', onClick: () => { setMoreMenuOpen(false); void installAdobeBridgeScripts(setFeedback, true).then(() => fetchAdobeBridgeInstallStatus()).then(setAdobeInstall); } }, '🔐 安装 PS / AI 菜单面板（需 Mac 密码）'),
            adobeInstall.cepInstalled ? null : React.createElement('button', { title: '检测到常驻桥接面板未安装。CEP 扩展装在用户级目录不需要管理员密码，可停靠、自动轮询发件箱；适用 Illustrator（各版本，入口「窗口 → 扩展功能」）与 Photoshop ≤2024（入口「窗口 → 扩展（旧版）」）。Photoshop 2025 起 Adobe 已移除旧扩展系统，PS 2025+ 请用画布上的「取 Ps 图层」「→Ps」或菜单里的一键脚本。装好后此按钮自动消失', onClick: () => { setMoreMenuOpen(false); void installAdobeBridgeCepPanel(setFeedback).then(() => fetchAdobeBridgeInstallStatus()).then(setAdobeInstall); } }, '🧩 安装常驻面板（Illustrator / PS≤2024）'),
            React.createElement('button', { onClick: () => { setMoreMenuOpen(false); saveNow(); setFeedback('✓ 已保存当前画布'); }, disabled: !projectInfo.project }, '保存当前画布'),
            React.createElement('button', { className: 'dsh-canvas-more-danger', title: '先备份画布，再把项目图片移入画布回收站', onClick: () => { setMoreMenuOpen(false); backupAndClear(); }, disabled: !projectInfo.project }, '清空当前画布')
          ) : null
        ),
        imageSettings ? React.createElement('div', { className: 'dsh-canvas-engine-dialog' },
          React.createElement('div', { className: 'dsh-canvas-engine-card' },
            React.createElement('div', { className: 'dsh-canvas-project-dialog-heading' },
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '图像生成引擎'),
                React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '选择一种图片生成路线；状态、安装、登录、密钥与连接检测都可在这里完成。')
              ),
              React.createElement('button', { className: 'dsh-canvas-project-dialog-close', onClick: () => { if (!imageSettingsBusy) setImageSettings(null); } }, '×')
            ),
            imageSettings.loading ? React.createElement('div', { className: 'dsh-canvas-engine-loading' }, '正在读取本机引擎状态…') : React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'dsh-canvas-engine-options' },
                React.createElement('label', { className: 'dsh-canvas-engine-option' },
                  React.createElement('input', { type: 'radio', name: 'dsh-image-engine', checked: imageSettings.engine === 'dsh-codex', onChange: () => setImageSettings({ ...imageSettings, engine: 'dsh-codex' }) }),
                  React.createElement('span', null,
                    React.createElement('strong', null, 'Codex 统一路由 ', React.createElement('em', { className: 'dsh-canvas-engine-badge ' + (imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.ready ? 'is-ready' : '') }, imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.ready ? '可用' : '待配置')),
                    React.createElement('small', null, '与当前 DSH 的 dsh-codex 共用 ChatGPT OAuth、订阅额度和 gpt-image-2 图片能力。')
                  )
                ),
                React.createElement('label', { className: 'dsh-canvas-engine-option' },
                  React.createElement('input', { type: 'radio', name: 'dsh-image-engine', checked: imageSettings.engine === 'api', onChange: () => setImageSettings({ ...imageSettings, engine: 'api' }) }),
                  React.createElement('span', null,
                    React.createElement('strong', null, 'API ', React.createElement('em', { className: 'dsh-canvas-engine-badge ' + (imageSettings.health && imageSettings.health.api && imageSettings.health.api.ready ? 'is-ready' : '') }, imageSettings.health && imageSettings.health.api && imageSettings.health.api.ready ? '已配置' : '待配置')),
                    React.createElement('small', null, '连接 OpenAI 兼容图片接口，适合企业网关或独立 image2 服务。')
                  )
                )
              ),
              React.createElement('div', { className: 'dsh-canvas-engine-autoadd' },
                React.createElement('label', { className: 'dsh-canvas-engine-autoadd-row' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: autoAddOn,
                    onChange: (e) => {
                      const next = Boolean(e.target.checked);
                      setCanvasAutoAddEnabled(next);
                      setAutoAddOnState(next);
                    }
                  }),
                  React.createElement('span', null, '聊天生图完成后自动上画布',
                    React.createElement('small', null, '默认开启:生成中在画布显示占位提示,完成后自动加入,无需逐张点「加入画布」。批量生图或大量抽卡重跑时建议关闭,改回卡片手动加入,避免画布被占满。')
                  )
                )
              ),
              imageSettings.engine === 'dsh-codex' ? React.createElement('div', { className: 'dsh-canvas-engine-setup' },
                React.createElement('div', { className: 'dsh-canvas-engine-steps' },
                  React.createElement('div', { className: imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed ? 'is-done' : '' }, React.createElement('b', null, '1'), React.createElement('span', null, '兼容组件', React.createElement('small', null, imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed ? '当前 profile 已加载兼容版' : (imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.detail ? imageSettings.health.dshCodex.detail : '请运行画布套件安装/修复')))),
                  React.createElement('div', { className: imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.authenticated ? 'is-done' : '' }, React.createElement('b', null, '2'), React.createElement('span', null, '登录 ChatGPT', React.createElement('small', null, imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.authenticated ? 'OAuth 已登录，令牌会自动刷新' : '在浏览器完成独立 OAuth 授权'))),
                  React.createElement('div', { className: imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.ready ? 'is-done' : '' }, React.createElement('b', null, '3'), React.createElement('span', null, '开始使用', React.createElement('small', null, '保存后用于编辑、擦除与文字背景清理')))
                ),
                React.createElement('div', { className: 'dsh-canvas-engine-inline-actions' },
                  !(imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed) ? React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy, onClick: installDshCodex }, imageSettingsBusy ? '检查中…' : '检查兼容组件') : null,
                  imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed && !imageSettings.health.dshCodex.authenticated ? React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy, onClick: startCodexLogin }, imageSettingsBusy ? '处理中…' : '使用 ChatGPT 登录') : null,
                  React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => refreshImageSettings('状态已刷新') }, '刷新状态'),
                  React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => askDshToConfigure('dsh-codex') }, '让 DSH 帮我配置')
                )
              ) : React.createElement('div', { className: 'dsh-canvas-engine-setup' },
                React.createElement('div', { className: 'dsh-canvas-engine-api-grid' },
                  React.createElement('label', { className: 'dsh-canvas-engine-field' }, React.createElement('span', null, 'API 地址', React.createElement('small', null, '须为 HTTPS；带或不带 /v1 均可')), React.createElement('input', { value: imageSettings.apiBaseUrl || '', onChange: (e) => setImageSettings({ ...imageSettings, apiBaseUrl: e.target.value }), placeholder: 'https://api.example.com' })),
                  React.createElement('label', { className: 'dsh-canvas-engine-field' }, React.createElement('span', null, '模型名称', React.createElement('small', null, '服务商提供的图片编辑模型 ID')), React.createElement('input', { value: imageSettings.apiModel || '', onChange: (e) => setImageSettings({ ...imageSettings, apiModel: e.target.value }), placeholder: 'gpt-image-2' })),
                  React.createElement('label', { className: 'dsh-canvas-engine-field dsh-canvas-engine-key' }, React.createElement('span', null, 'API Key', React.createElement('small', null, imageSettings.health && imageSettings.health.api && imageSettings.health.api.configured ? '已安全保存；留空保持原密钥' : '仅保存到本机用户目录，不进入项目')), React.createElement('input', { type: 'password', autoComplete: 'new-password', value: imageSettings.apiKey || '', onChange: (e) => setImageSettings({ ...imageSettings, apiKey: e.target.value }), placeholder: imageSettings.health && imageSettings.health.api && imageSettings.health.api.configured ? '••••••••（已配置）' : 'sk-…' }))
                ),
                React.createElement('div', { className: 'dsh-canvas-engine-inline-actions' },
                  React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy || (!(imageSettings.health && imageSettings.health.api && imageSettings.health.api.configured) && !String(imageSettings.apiKey || '').trim()), onClick: testApiSettings }, imageSettingsBusy ? '检测中…' : '保存并检测连接'),
                  React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => askDshToConfigure('api') }, '让 DSH 帮我配置')
                )
              ),
              imageSettings.error ? React.createElement('div', { className: 'dsh-canvas-engine-error' }, '⚠ ' + imageSettings.error) : null,
              imageSettings.notice ? React.createElement('div', { className: 'dsh-canvas-engine-notice' }, imageSettings.notice) : null,
              React.createElement(ToolchainCard, { toolchain, onRefresh: () => { fetch('/dsh-canvas/toolchain-status').then((r) => r.json()).then((d) => { if (d && d.ok) setToolchain(d.status); }).catch(() => {}); } }),
              React.createElement('div', { className: 'dsh-canvas-engine-note' }, '安全说明：OAuth 与 API Key 分开保存，前端永远读不到完整凭据；不会写入画布项目、聊天消息或 Git 仓库。'),
              React.createElement('div', { className: 'dsh-canvas-project-actions' },
                React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => setImageSettings(null) }, '取消'),
                React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy, onClick: saveImageSettings }, imageSettingsBusy ? '保存中…' : '保存设置')
              )
            )
          )
        ) : null,
        projectDialog ? React.createElement('div', { className: 'dsh-canvas-project-dialog' },
          projectDialog.mode === 'new' ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '新建画布项目'),
            React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '项目会创建在当前聊天工作目录中，不需要选择路径。'),
            React.createElement('input', { className: 'dsh-canvas-project-input', autoFocus: true, value: projectDialog.value, placeholder: '例如：橄榄球滤材主图', onChange: (e) => setProjectDialog({ ...projectDialog, value: e.target.value }), onKeyDown: (e) => { if (e.key === 'Escape') setProjectDialog(null); } }),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => setProjectDialog(null) }, '取消'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => { const clean = projectDialog.value.replace(/[\\/:*?"<>|]/g, '-').trim(); if (!clean) return; loadProject({ cwd: projectInfo.cwd, project: projectInfo.cwd.replace(/[\\/]+$/, '') + '/' + clean }, false); setProjectDialog(null); } }, '创建并打开')
            )
          ) : projectDialog.mode === 'rename' ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '重命名项目'),
            React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '项目文件夹会同步改名，画布内容和图片不会改变。'),
            React.createElement('input', { className: 'dsh-canvas-project-input', autoFocus: true, value: projectDialog.value, placeholder: '输入新的项目名称', onChange: (e) => setProjectDialog({ ...projectDialog, value: e.target.value }), onKeyDown: (e) => { if (e.key === 'Escape') openProjectList(); if (e.key === 'Enter') renameProject(projectDialog.item, projectDialog.value); } }),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: openProjectList }, '取消'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => renameProject(projectDialog.item, projectDialog.value) }, '保存名称')
            )
          ) : projectDialog.mode === 'list' ? React.createElement(React.Fragment, null,
            projectDialog.reason === 'auto-add' ? React.createElement('div', { className: 'dsh-canvas-project-reason' }, '🎨 本聊天还没绑定画布项目——选择已有项目或新建一个,生成的图片会自动上画布;直接关闭则本次改回手动加入。') : null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-heading' },
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, projectDialog.reason === 'auto-add' ? '选择画布项目' : '管理项目'),
                React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '项目独立保存，切换聊天后仍可重新打开。')
              ),
              React.createElement('button', { className: 'dsh-canvas-project-dialog-close', title: '关闭', onClick: () => setProjectDialog(null) }, '×')
            ),
            projectInfo.project ? React.createElement('div', { className: 'dsh-canvas-project-current' },
              React.createElement('span', { className: 'dsh-canvas-project-current-icon' }, '▣'),
              React.createElement('span', { className: 'dsh-canvas-project-current-main' },
                React.createElement('small', null, '当前项目 · 已自动保存'),
                React.createElement('strong', null, basename(projectInfo.project)),
                React.createElement('code', { title: projectInfo.project }, projectInfo.project)
              ),
            React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-open-folder', onClick: openProjectFolder }, '打开项目文件夹')
            ) : React.createElement('div', { className: 'dsh-canvas-project-current dsh-canvas-project-current-empty' }, '尚未选择项目，可新建或从文件夹导入。'),
            React.createElement('div', { className: 'dsh-canvas-project-section-title' }, '最近项目'),
            React.createElement('div', { className: 'dsh-canvas-project-list' },
              projectList.loading ? React.createElement('div', { className: 'dsh-canvas-project-empty' }, '正在查找项目…') : null,
              projectList.error ? React.createElement('div', { className: 'dsh-canvas-project-empty dsh-canvas-project-error' }, projectList.error) : null,
              !projectList.loading && !projectList.error && !projectList.items.length ? React.createElement('div', { className: 'dsh-canvas-project-empty' }, '当前目录还没有画布项目') : null,
              projectList.items.map((item) => React.createElement('div', { key: item.path, className: 'dsh-canvas-project-card' + (projectInfo.project === item.path ? ' dsh-canvas-project-card-current' : '') },
                React.createElement('button', { className: 'dsh-canvas-project-card-open', title: '打开“' + item.name + '”', onClick: () => { loadProject({ cwd: projectInfo.cwd, sessionId: projectInfo.sessionId, project: item.path }, true); setProjectDialog(null); } },
                  React.createElement('span', { className: 'dsh-canvas-project-card-icon' }, '▣'),
                  React.createElement('span', { className: 'dsh-canvas-project-card-main' }, React.createElement('strong', null, item.name), React.createElement('small', null, item.images + ' 张图片 · ' + item.elements + ' 个元素')),
                  React.createElement('time', null, new Date(item.updatedAt).toLocaleString())
                ),
                React.createElement('span', { className: 'dsh-canvas-project-card-actions' },
                  React.createElement('button', { title: '重命名项目', onClick: () => setProjectDialog({ mode: 'rename', item, value: item.name }) }, '重命名'),
                  React.createElement('button', { className: 'dsh-canvas-project-card-delete', title: '删除项目', onClick: () => deleteProject(item) }, '删除')
                )
              ))
            ),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: importProject }, '导入项目'),
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => browseDir(projectInfo.cwd) }, '浏览其他文件夹'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => setProjectDialog({ mode: 'new', value: '新画布项目' }) }, '新建项目')
            )
          ) : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '选择项目文件夹'),
            React.createElement('div', { className: 'dsh-canvas-browser-path', title: projectDialog.path }, projectDialog.path),
            React.createElement('div', { className: 'dsh-canvas-project-list' },
              projectDialog.loading ? React.createElement('div', { className: 'dsh-canvas-project-empty' }, '加载文件夹…') : null,
              projectDialog.error ? React.createElement('div', { className: 'dsh-canvas-project-empty dsh-canvas-project-error' }, projectDialog.error) : null,
              (projectDialog.entries || []).map((item) => React.createElement('button', { key: item.path, className: 'dsh-canvas-folder-card', onClick: () => browseDir(item.path) }, React.createElement('span', null, '📁'), React.createElement('span', null, item.name), React.createElement('span', null, '›')))
            ),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: openProjectList }, '返回项目列表'),
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => { const clean = projectDialog.path.replace(/[\\/]+$/, ''); const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')); const parent = cut > 2 ? clean.slice(0, cut) : clean.slice(0, 3); browseDir(parent || '/'); } }, '上一级'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => { loadProject({ cwd: projectInfo.cwd, project: projectDialog.path }, true); setProjectDialog(null); } }, '选择此文件夹')
            )
          )
        ) : null,
        materials ? React.createElement('div', { className: 'dsh-materials-overlay' },
          React.createElement('aside', {
            className: 'dsh-materials-panel' + (materialDropActive ? ' is-drop-active' : ''),
            onDragOver: onMaterialDragOver,
            onDragEnter: onMaterialDragOver,
            onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMaterialDropActive(false); },
            onDrop: onMaterialDrop
          },
            React.createElement('div', { className: 'dsh-materials-head' },
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-materials-title' }, '素材库', React.createElement('span', { className: 'dsh-materials-count' }, materials.files.length + ' 项'))
              ),
              React.createElement('button', { className: 'dsh-materials-close', title: '关闭素材库', 'aria-label': '关闭素材库', onClick: () => setMaterials(null) }, '×')
            ),
            React.createElement('div', { className: 'dsh-materials-location' + (materialControlsOpen ? ' is-expanded' : '') },
              React.createElement('div', { className: 'dsh-materials-location-current', title: materials.dir || '' },
                React.createElement('span', { className: 'dsh-materials-location-icon', 'aria-hidden': true }, '⌂'),
                React.createElement('span', null,
                  React.createElement('strong', null, materials.dir ? basename(materials.dir) : '未选择目录'),
                  React.createElement('small', null, materials.dir || '选择一个独立文件夹作为素材库')
                )
              ),
              React.createElement('button', { onClick: chooseMaterialDirectory, disabled: !!materials.busy }, '切换'),
              React.createElement('button', { className: 'dsh-materials-location-toggle', title: materialControlsOpen ? '收起目录选项' : '展开目录选项', 'aria-expanded': materialControlsOpen ? 'true' : 'false', onClick: () => setMaterialControlsOpen((value) => !value) }, materialControlsOpen ? '⌃' : '⌄')
            ),
            materialControlsOpen || materialDropActive ? React.createElement('div', { className: 'dsh-materials-extra' },
              materialLibrary.recent.length ? React.createElement('label', { className: 'dsh-materials-recent' },
                React.createElement('span', null, '最近访问'),
                React.createElement('select', { value: materials.dir || '', disabled: !!materials.busy, onChange: (event) => { if (event.target.value && event.target.value !== materials.dir) { setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev); loadMaterialDirectory(event.target.value).catch((err) => setMaterials((prev) => prev ? { ...prev, busy: false, error: String(err.message || err) } : prev)); } } },
                  materialLibrary.recent.map((path) => React.createElement('option', { key: path, value: path }, basename(path) + ' — ' + path))
                )
              ) : null,
              React.createElement('div', { className: 'dsh-materials-dropzone' },
                React.createElement('strong', null, materialDropActive ? '松开即可存入当前素材库' : '拖入画布图片或本地图片'),
                React.createElement('span', null, '也可把下方素材拖到左侧画布')
              )
            ) : null,
            React.createElement('div', { className: 'dsh-materials-toolbar' },
              React.createElement('label', { className: 'dsh-materials-search' },
                React.createElement('span', null, '⌕'),
                React.createElement('input', { value: materialQuery, placeholder: '搜索文件名', onChange: (e) => setMaterialQuery(e.target.value), autoFocus: true })
              ),
              React.createElement('div', { className: 'dsh-materials-toolbar-actions' },
                React.createElement('button', { className: materialSelectMode ? 'is-active' : '', onClick: () => { setMaterialSelectMode((value) => !value); setMaterialSelection([]); }, title: materialSelectMode ? '退出多选' : '批量选择素材' }, materialSelectMode ? '完成' : '多选'),
                React.createElement('button', { onClick: addSelectedToLibrary, disabled: !!materials.busy || !projectInfo.project, title: '把当前画布中选中的一张或多张图片保存到当前素材库目录' }, '＋'),
                React.createElement('button', { onClick: refreshMaterials, disabled: !!materials.busy, title: '刷新素材' }, '↻'),
                React.createElement('button', { onClick: openMaterialsFolder, disabled: !materials.dir, title: '打开素材目录' }, '⌁')
              )
            ),
            React.createElement('div', { className: 'dsh-materials-organize' },
              React.createElement('label', { className: 'dsh-materials-sort' },
                React.createElement('span', null, '整理'),
                React.createElement('select', { value: materialSort, onChange: (event) => { const next = event.target.value; setMaterialSort(next); try { window.localStorage.setItem(MATERIAL_SORT_KEY, JSON.stringify(next)); } catch (err) {} } },
                  React.createElement('option', { value: 'time' }, '修改时间'),
                  React.createElement('option', { value: 'type' }, '文件类型'),
                  React.createElement('option', { value: 'pixels' }, '图片尺寸'),
                  React.createElement('option', { value: 'bytes' }, '文件大小'),
                  React.createElement('option', { value: 'name' }, '文件名称')
                )
              ),
              React.createElement('div', { className: 'dsh-materials-tagfilter' },
                React.createElement('span', { className: 'dsh-materials-tagfilter-label' }, '标记'),
                React.createElement('button', { className: 'dsh-materials-tagall' + (materialTagFilter ? '' : ' is-active'), title: '显示全部素材', onClick: () => setMaterialTagFilter('') }, '全部'),
                MATERIAL_TAG_COLORS.map((color) => React.createElement('button', {
                  key: color.id,
                  className: 'dsh-materials-tagdot' + (materialTagFilter === color.id ? ' is-active' : ''),
                  style: { background: color.hex },
                  title: (materialTagFilter === color.id ? '取消' : '只看') + color.label + '色标记',
                  'aria-label': (materialTagFilter === color.id ? '取消' : '只看') + color.label + '色标记',
                  onClick: () => setMaterialTagFilter(materialTagFilter === color.id ? '' : color.id)
                })),
                Object.values(materialTags).length
                  ? React.createElement('span', { className: 'dsh-materials-tagfilter-count' }, Object.values(materialTags).filter(Boolean).length + ' 项已标记')
                  : null
              )
            ),
            materials.error ? React.createElement('div', { className: 'dsh-materials-error' }, materials.error) : null,
            React.createElement('div', { className: 'dsh-materials-body' },
              materials.busy && !materials.files.length
                ? React.createElement('div', { className: 'dsh-materials-empty' }, React.createElement('strong', null, '正在读取素材…'))
                : !materials.files.length
                ? React.createElement('div', { className: 'dsh-materials-empty' }, React.createElement('strong', null, '还没有常用素材'), React.createElement('span', null, '在画布中选中图片，再点击“保存画布选中项”；也可以直接把图片放进素材目录。'))
                : !filteredMaterials.length
                ? React.createElement('div', { className: 'dsh-materials-empty' }, React.createElement('strong', null, '没有匹配的素材'), React.createElement('span', null, '换个关键词，或清空搜索条件。'))
                : React.createElement('div', { className: 'dsh-materials-grid' },
                    filteredMaterials.map((item) => {
                      const tagColor = MATERIAL_TAG_COLORS.find((c) => c.id === materialTags[item.name]) || null;
                      return React.createElement('div', {
                        key: item.name,
                        className: 'dsh-materials-item' + (materialSelection.includes(item.name) ? ' is-selected' : '') + (tagColor ? ' is-tagged is-tag-' + tagColor.id : ''),
                        role: 'button', tabIndex: 0, draggable: true,
                        onDragStart: (event) => startMaterialDrag(event, item),
                        onClick: () => materialSelectMode ? toggleMaterialSelection(item) : setMaterialPreview(item),
                        onDoubleClick: () => sendMaterialToCanvas(item),
                        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); materialSelectMode ? toggleMaterialSelection(item) : setMaterialPreview(item); } },
                        title: (materialSelectMode ? '点击勾选或取消，可连续选择多张' : '拖入画布；单击预览；双击加入画布') + '\n' + (item.width && item.height ? item.width + '×' + item.height + ' · ' : '') + Math.max(1, Math.round((item.size || 0) / 1024)) + ' KB · ' + (item.mtime ? new Date(item.mtime).toLocaleString() : '')
                      },
                        React.createElement('button', {
                          className: 'dsh-materials-tagset' + (tagColor ? ' is-set' : ''),
                          style: tagColor ? { background: tagColor.hex } : undefined,
                          title: tagColor ? '当前' + tagColor.label + '色标记，点击修改' : '设置颜色标记',
                          'aria-label': '设置颜色标记 ' + item.name,
                          onClick: (event) => { event.preventDefault(); event.stopPropagation(); setMaterialTagMenu(materialTagMenu && materialTagMenu.names.length === 1 && materialTagMenu.names[0] === item.name ? null : { names: [item.name] }); }
                        }, tagColor ? '' : '⌗'),
                        materialSelectMode
                          ? React.createElement('span', { className: 'dsh-materials-check', 'aria-hidden': true }, materialSelection.includes(item.name) ? '✓' : '')
                          : React.createElement('button', { className: 'dsh-materials-zoom', title: '放大查看', 'aria-label': '放大查看 ' + item.name, onClick: (event) => { event.preventDefault(); event.stopPropagation(); setMaterialPreview(item); } }, '↗'),
                        React.createElement('span', { className: 'dsh-materials-thumb' },
                          React.createElement('img', { src: '/dsh-canvas/image?path=' + encodeURIComponent(materials.dir + '/' + item.name), loading: 'lazy', alt: item.name })
                        ),
                        React.createElement('span', { className: 'dsh-materials-meta' },
                          React.createElement('span', { className: 'dsh-materials-item-name' }, item.name.replace(/\.[^.]+$/, '')),
                          React.createElement('span', { className: 'dsh-materials-item-info' }, (item.width && item.height ? item.width + '×' + item.height + ' · ' : '') + Math.max(1, Math.round((item.size || 0) / 1024)) + ' KB')
                        )
                      );
                    })
                  )
            ),
            materialSelectMode ? React.createElement('div', { className: 'dsh-materials-selectionbar is-visible' },
              React.createElement('div', { className: 'dsh-materials-selection-summary' },
                React.createElement('strong', null, '已选 ' + selectedMaterials.length + ' 项'),
                React.createElement('button', { onClick: () => setMaterialSelection([]), disabled: !selectedMaterials.length }, '取消选择')
              ),
              React.createElement('div', { className: 'dsh-materials-selection-actions' },
                React.createElement('button', { onClick: () => setMaterialTagMenu({ names: materialSelection.slice() }), disabled: !selectedMaterials.length, title: '为选中的素材设置 Mac 式颜色标记' }, '标记'),
                React.createElement('button', { className: 'is-primary', onClick: addSelectedMaterialsToCanvas, disabled: !selectedMaterials.length }, '加入画布'),
                React.createElement('button', { onClick: attachSelectedMaterialsToChat, disabled: !selectedMaterials.length }, '附加到聊天'),
                React.createElement('button', { className: 'is-danger', onClick: deleteSelectedMaterials, disabled: !selectedMaterials.length || !!materials.busy }, '删除')
              )
            ) : null,
            materialTagMenu ? React.createElement('div', { className: 'dsh-materials-tagmenu', role: 'dialog', 'aria-label': '颜色标记' },
              React.createElement('div', { className: 'dsh-materials-tagmenu-title' }, '标记 ' + materialTagMenu.names.length + ' 项'),
              React.createElement('div', { className: 'dsh-materials-tagmenu-row' },
                MATERIAL_TAG_COLORS.map((color) => React.createElement('button', {
                  key: color.id,
                  className: 'dsh-materials-tagdot',
                  style: { background: color.hex },
                  title: '标记为' + color.label + '色',
                  'aria-label': '标记为' + color.label + '色',
                  onClick: () => { const names = materialTagMenu.names.slice(); setMaterialTagMenu(null); applyMaterialTag(names, color.id); }
                }))
              ),
              React.createElement('div', { className: 'dsh-materials-tagmenu-actions' },
                React.createElement('button', { onClick: () => { const names = materialTagMenu.names.slice(); setMaterialTagMenu(null); applyMaterialTag(names, ''); } }, '清除标记'),
                React.createElement('button', { onClick: () => setMaterialTagMenu(null) }, '取消')
              )
            ) : null
          )
        ) : null,
        materialPreview && materials ? React.createElement('div', { className: 'dsh-materials-preview', role: 'dialog', 'aria-modal': 'true', onClick: () => setMaterialPreview(null) },
          React.createElement('div', { className: 'dsh-materials-preview-card', onClick: (event) => event.stopPropagation() },
            React.createElement('img', { src: '/dsh-canvas/image?path=' + encodeURIComponent(materials.dir + '/' + materialPreview.name), alt: materialPreview.name }),
            React.createElement('div', { className: 'dsh-materials-preview-bar' },
              React.createElement('strong', null, materialPreview.name.replace(/\.[^.]+$/, '')),
              React.createElement('span', { className: 'dsh-materials-preview-info' },
                (materialPreview.width && materialPreview.height ? materialPreview.width + '×' + materialPreview.height + ' · ' : '')
                + Math.max(1, Math.round((materialPreview.size || 0) / 1024)) + ' KB'
                + (materialPreview.mtime ? ' · ' + new Date(materialPreview.mtime).toLocaleString() : '')
              ),
              React.createElement('button', { onClick: () => { sendMaterialToCanvas(materialPreview); setMaterialPreview(null); } }, '加入画布'),
              React.createElement('button', { onClick: () => setMaterialPreview(null) }, '关闭')
            )
          )
        ) : null,
        textRebuild ? React.createElement(TextRebuildPanel, {
          data: textRebuild,
          onClose: () => { if (!textRebuild.busy) setTextRebuild(null); },
          onDetect: detectTextRebuild,
          onSelectionsChange: updateTextRebuildSelections,
          onExport: exportTextRebuild
        }) : null,
        React.createElement('div', { className: 'dsh-canvas-frame-wrap' }, iframe)
      );
    }

