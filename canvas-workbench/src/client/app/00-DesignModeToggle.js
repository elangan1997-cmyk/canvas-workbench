    // 聊天输入区的生图比例选择：值域与宿主 image-engine-settings 白名单一一对应。
    // 编辑/擦除不经过这里（跟随原图尺寸）；生成数量仅 API 引擎生效。
    const IMAGE_RATIO_OPTIONS = [
      { value: '1024x1024', label: '1:1', px: '1024', icon: [15, 15] },
      { value: '1536x1024', label: '3:2', px: '1536×1024', icon: [18, 12] },
      { value: '1024x1536', label: '2:3', px: '1024×1536', icon: [12, 18] },
      { value: '1280x960', label: '4:3', px: '1280×960', icon: [18, 13.5] },
      { value: '960x1280', label: '3:4', px: '960×1280', icon: [13.5, 18] },
      { value: '1920x1080', label: '16:9', px: '1920×1080', icon: [20, 11.25] },
      { value: '1080x1920', label: '9:16', px: '1080×1920', icon: [11.25, 20] },
      { value: '2560x1080', label: '21:9', px: '2560×1080', icon: [21, 9] },
      { value: '1080x2560', label: '9:21', px: '1080×2560', icon: [9, 21] },
      { value: '2048x1024', label: '2:1', px: '2048×1024', icon: [20, 10] },
      { value: '1024x2048', label: '1:2', px: '1024×2048', icon: [10, 20] },
      { value: '1280x1024', label: '5:4', px: '1280×1024', icon: [17, 13.6] },
      { value: '1024x1280', label: '4:5', px: '1024×1280', icon: [13.6, 17] }
    ];
    const IMAGE_COUNT_OPTIONS = [1, 2, 4, 8];
    function ratioOptionLabel(option) {
      return option.label + (option.tag ? ' ' + option.tag : '');
    }

    function DesignModeToggle(props) {
      const [on, setOn] = React.useState(getMode());
      const [attachState, setAttachState] = React.useState('');
      const [genAsk, setGenAsk] = React.useState({ show: false, active: 0 });
      const [imageRatio, setImageRatio] = React.useState('auto');
      const [imageCount, setImageCount] = React.useState(1);
      const [ratioOpen, setRatioOpen] = React.useState(false);
      const [ratioAnchor, setRatioAnchor] = React.useState(null);
      const ratioWrapRef = React.useRef(null);
      const [modelCapabilityRevision, setModelCapabilityRevision] = React.useState(0);
      const sessionSummary = props.useSessions((state) => state && state.byId ? state.byId[props.sessionId] : undefined);
      React.useEffect(() => {
        const update = () => setModelCapabilityRevision((value) => value + 1);
        window.addEventListener('dsh-canvas:model-directories-ready', update);
        return () => window.removeEventListener('dsh-canvas:model-directories-ready', update);
      }, []);
      React.useEffect(() => {
        activeChatModelSelection = null;
        // 模型追踪诊断:分级上报断点(无 API/无会话/无目录/正常),与标题栏探针同通道。
        const reportModelStage = (stage, extra) => {
          fetch('/dsh-canvas/client-debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelTracking: { stage, ...extra }, at: Date.now() })
          }).catch(() => {});
        };
        if (!modelDirectoriesApi) { reportModelStage('no-api'); return; }
        if (!props.sessionId) { reportModelStage('no-session'); return; }
        if (typeof modelDirectoriesApi.directoryFor !== 'function') { reportModelStage('api-shape'); return; }
        let directory;
        try { directory = modelDirectoriesApi.directoryFor(props.sessionId); } catch (e) { reportModelStage('directoryFor-threw', { error: String(e && e.message || e) }); return; }
        if (!directory) { reportModelStage('no-directory'); return; }
        const update = () => {
          try {
            const snapshot = directory.store.getSnapshot();
            if (snapshot && snapshot.current) activeChatModelSelection = { ...snapshot.current };
            // 模型追踪诊断:与标题栏探针同一通道,远程可读(Win 模型识别走不通排查用)。
            reportModelStage('ok', {
              snapshotKeys: snapshot ? Object.keys(snapshot) : null,
              current: snapshot && snapshot.current
                ? { provider: snapshot.current.provider || null, model: snapshot.current.model || snapshot.current.id || null }
                : null
            });
          } catch (e) {}
        };
        update();
        try { directory.load().then(update).catch(() => {}); } catch (e) {}
        return directory.store && typeof directory.store.subscribe === 'function' ? directory.store.subscribe(update) : undefined;
      }, [props.sessionId, modelCapabilityRevision]);
      React.useEffect(() => subscribeMode(setOn), []);
      React.useEffect(() => {
        fetch('/dsh-canvas/image-settings').then((r) => r.json()).then((d) => {
          if (d && d.ok) {
            if (d.imageSize) setImageRatio(String(d.imageSize));
            if (d.imageCount) setImageCount(Number(d.imageCount) || 1);
          }
        }).catch(() => {});
      }, []);
      React.useEffect(() => {
        if (!ratioOpen) return;
        const onDocDown = (e) => {
          if (ratioWrapRef.current && !ratioWrapRef.current.contains(e.target)) setRatioOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setRatioOpen(false); };
        document.addEventListener('mousedown', onDocDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDocDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [ratioOpen]);
      const applyImageRatio = (value) => {
        setRatioOpen(false);
        if (value === imageRatio) return;
        setImageRatio(value);
        fetch('/dsh-canvas/image-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageSize: value })
        }).catch(() => {});
      };
      const applyImageCount = (value) => {
        if (value === imageCount) return;
        setImageCount(value);
        fetch('/dsh-canvas/image-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageCount: value })
        }).catch(() => {});
      };
      React.useEffect(() => {
        const onGenState = (event) => {
          const detail = event.detail || {};
          setGenAsk({ show: Boolean(detail.show), active: Number(detail.active) || 0 });
        };
        window.addEventListener('dsh-canvas:gen-state', onGenState);
        return () => window.removeEventListener('dsh-canvas:gen-state', onGenState);
      }, []);
      React.useEffect(() => {
        if (sessionSummary && sessionSummary.cwd) {
          setActiveChatContext(sessionSummary.cwd, props.sessionId || '');
        }
      }, [sessionSummary && sessionSummary.cwd, props.sessionId]);
      React.useEffect(() => {
        const receive = async (event) => {
          const images = event.detail && Array.isArray(event.detail.images) ? event.detail.images : [];
          const batchIndex = Number(event.detail && event.detail.index || 0);
          const batchTotal = Number(event.detail && event.detail.total || images.length);
          if (!images.length) { setAttachState('⚠ 没有取得所选图片数据'); return; }
          // 新版官方桌面把 addImages 改名为 addAttachments;旧版保留原名。
          const attachToInput = props.inputActions
            ? (props.inputActions.addAttachments || props.inputActions.addImages)
            : null;
          if (typeof attachToInput !== 'function') { setAttachState('⚠ 当前聊天输入框暂不可附加图片'); return; }
          const attachmentApi = await waitForConversationService();
          if (!attachmentApi) { setAttachState('⚠ DSH 会话附件服务尚未就绪，请稍后再点一次'); return; }
          try {
            const files = await Promise.all(images.map((item, index) => rasterizeSVGForChat(item, index)));
            // createDrafts(新) 需要 sessionId;createDraftImages(旧) 只收文件列表。
            const drafts = typeof attachmentApi.createDrafts === 'function'
              ? attachmentApi.createDrafts(props.sessionId || activeChatSessionId || '', files)
              : attachmentApi.createDraftImages(files);
            if (!attachToInput.call(props.inputActions, drafts.map((item) => item.id))) {
              const release = attachmentApi.releaseDraftAttachments || attachmentApi.releaseDraftImages;
              if (typeof release === 'function') release.call(attachmentApi, drafts);
              setAttachState('图片附件数量或大小超出限制');
              return;
            }
            setAttachState(batchTotal > 1
              ? '✓ 已附加 ' + Math.min(batchTotal, batchIndex || drafts.length) + '/' + batchTotal + ' 张画布图片'
              : '✓ 已附加 ' + drafts.length + ' 张画布图片，请输入修改要求');
          } catch (err) {
            setAttachState('⚠ ' + String((err && err.message) || err));
          }
        };
        window.addEventListener('dsh-canvas:attach-selection', receive);
        return () => window.removeEventListener('dsh-canvas:attach-selection', receive);
      }, [props.inputActions, props.sessionId]);
      const toggleRatioPopover = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const viewportWidth = window.innerWidth || 1024;
        setRatioAnchor({ left: Math.max(8, Math.min(rect.left, viewportWidth - 336)), top: rect.top });
        setRatioOpen((v) => !v);
      };
      const currentRatioOption = IMAGE_RATIO_OPTIONS.find((option) => option.value === imageRatio);
      const countSuffix = imageCount > 1 ? ' ×' + imageCount : '';
      const ratioPopover = ratioOpen && ratioAnchor ? React.createElement('div', {
        className: 'dsh-canvas-ratio-pop',
        style: { left: ratioAnchor.left + 'px', top: ratioAnchor.top + 'px' }
      },
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-title' }, '生图比例'),
        React.createElement('div', { className: 'dsh-canvas-ratio-grid' },
          IMAGE_RATIO_OPTIONS.map((option) => React.createElement('button', {
            key: option.value,
            className: 'dsh-canvas-ratio-card' + (imageRatio === option.value ? ' is-selected' : ''),
            title: option.px,
            onClick: () => applyImageRatio(option.value)
          },
            React.createElement('span', {
              className: 'dsh-canvas-ratio-card-icon',
              style: { width: option.icon[0] + 'px', height: option.icon[1] + 'px' }
            }),
            React.createElement('span', { className: 'dsh-canvas-ratio-card-label' }, ratioOptionLabel(option)),
            React.createElement('span', { className: 'dsh-canvas-ratio-card-px' }, option.px)
          ))
        ),
        React.createElement('button', {
          className: 'dsh-canvas-ratio-auto' + (imageRatio === 'auto' ? ' is-selected' : ''),
          onClick: () => applyImageRatio('auto')
        }, '✦ 自动 · 由模型决定'),
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-title' }, '生成数量'),
        React.createElement('div', { className: 'dsh-canvas-ratio-count-row' },
          IMAGE_COUNT_OPTIONS.map((count) => React.createElement('button', {
            key: count,
            className: 'dsh-canvas-ratio-count' + (imageCount === count ? ' is-selected' : ''),
            onClick: () => applyImageCount(count)
          }, '×' + count))
        ),
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-note' }, '聊天生图与聊天编辑生效（dsh-codex 引擎按所选比例居中裁切）；画布编辑 / 智能擦除跟随原图尺寸，数量恒为 1')
      ) : null;
      return React.createElement('div', { className: 'dsh-canvas-dock' },
        React.createElement('button', {
          className: 'dsh-canvas-mode' + (on ? ' dsh-canvas-mode-on' : ''),
          title: on ? '关闭设计模式（隐藏右侧画布）' : '开启设计模式（右侧显示无限画布）',
          onClick: toggleMode
        },
          React.createElement('span', { className: 'dsh-canvas-mode-dot' }),
          React.createElement('span', null, '设计模式'),
          React.createElement('span', { className: 'dsh-canvas-mode-state' }, on ? '开' : '关')
        ),
        // 比例芯片跟随设计模式:关闭时整组隐藏(生图回到纯手动/原生行为)。
        on ? React.createElement('div', { className: 'dsh-canvas-ratio-wrap', ref: ratioWrapRef },
          React.createElement('button', {
            className: 'dsh-canvas-ratio-chip' + (imageRatio !== 'auto' ? ' dsh-canvas-ratio-chip-set' : ''),
            title: '生图比例与数量：选择后聊天生图优先使用',
            onClick: toggleRatioPopover
          },
            React.createElement('span', null, (currentRatioOption ? ratioOptionLabel(currentRatioOption) : '自动比例') + countSuffix),
            React.createElement('span', { className: 'dsh-canvas-ratio-chip-caret' }, '⌄')
          ),
          ratioPopover
        ) : null,
        attachState ? React.createElement('span', { className: 'dsh-canvas-attach-state' }, attachState) : null,
        on && genAsk.show ? React.createElement('span', { className: 'dsh-canvas-gen-ask' },
          React.createElement('span', { className: 'dsh-canvas-gen-ask-text' },
            genAsk.active > 0 ? '🎨 正在生成图片，本聊天还没绑定画布项目：' : '🎨 生成的图片还没上画布——本聊天未绑定画布项目：'),
          React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('dsh-canvas:project-pick')) }, '选择已有项目'),
          React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('dsh-canvas:project-new')) }, '新建画布'),
          React.createElement('button', { className: 'dsh-canvas-gen-ask-dismiss', onClick: () => window.dispatchEvent(new CustomEvent('dsh-canvas:project-dismiss')) }, '本次手动加入')
        ) : null
      );
    }

