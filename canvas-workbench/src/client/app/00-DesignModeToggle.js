    // 聊天输入区的生图比例选择：值域与宿主 image-engine-settings 白名单一一对应。
    // 2K/4K 变体的长边走网关支持的高清档；编辑/擦除不经过这里（跟随原图尺寸）。
    const IMAGE_RATIO_OPTIONS = [
      { value: '1024x1024', label: '1:1', px: '1024', icon: [15, 15] },
      { value: '1536x1024', label: '3:2', px: '1536×1024', icon: [18, 12] },
      { value: '1024x1536', label: '2:3', px: '1024×1536', icon: [12, 18] },
      { value: '1280x960', label: '4:3', px: '1280×960', icon: [18, 13.5] },
      { value: '960x1280', label: '3:4', px: '960×1280', icon: [13.5, 18] },
      { value: '1920x1080', label: '16:9', px: '1920×1080', icon: [20, 11.25] },
      { value: '1080x1920', label: '9:16', px: '1080×1920', icon: [11.25, 20] },
      { value: '2048x2048', label: '1:1', tag: '2K', px: '2048', icon: [15, 15] },
      { value: '2048x1152', label: '16:9', tag: '2K', px: '2048×1152', icon: [20, 11.25] },
      { value: '1152x2048', label: '9:16', tag: '2K', px: '1152×2048', icon: [11.25, 20] },
      { value: '3840x2160', label: '16:9', tag: '4K', px: '3840×2160', icon: [20, 11.25] },
      { value: '2160x3840', label: '9:16', tag: '4K', px: '2160×3840', icon: [11.25, 20] }
    ];
    function ratioOptionLabel(option) {
      return option.label + (option.tag ? ' ' + option.tag : '');
    }

    function DesignModeToggle(props) {
      const [on, setOn] = React.useState(getMode());
      const [attachState, setAttachState] = React.useState('');
      const [genAsk, setGenAsk] = React.useState({ show: false, active: 0 });
      const [imageRatio, setImageRatio] = React.useState('auto');
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
        if (!modelDirectoriesApi || !props.sessionId || typeof modelDirectoriesApi.directoryFor !== 'function') return;
        let directory;
        try { directory = modelDirectoriesApi.directoryFor(props.sessionId); } catch (e) { return; }
        const update = () => {
          try {
            const snapshot = directory.store.getSnapshot();
            if (snapshot && snapshot.current) activeChatModelSelection = { ...snapshot.current };
          } catch (e) {}
        };
        update();
        try { directory.load().then(update).catch(() => {}); } catch (e) {}
        return directory.store && typeof directory.store.subscribe === 'function' ? directory.store.subscribe(update) : undefined;
      }, [props.sessionId, modelCapabilityRevision]);
      React.useEffect(() => subscribeMode(setOn), []);
      React.useEffect(() => {
        fetch('/dsh-canvas/image-settings').then((r) => r.json()).then((d) => {
          if (d && d.ok && d.imageSize) setImageRatio(String(d.imageSize));
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
          if (!props.inputActions || typeof props.inputActions.addImages !== 'function') { setAttachState('⚠ 当前聊天输入框暂不可附加图片'); return; }
          const attachmentApi = await waitForConversationService();
          if (!attachmentApi) { setAttachState('⚠ DSH 会话附件服务尚未就绪，请稍后再点一次'); return; }
          try {
            const files = await Promise.all(images.map((item, index) => rasterizeSVGForChat(item, index)));
            const drafts = attachmentApi.createDraftImages(files);
            if (!props.inputActions.addImages(drafts.map((item) => item.id))) {
              attachmentApi.releaseDraftImages(drafts);
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
      }, [props.inputActions]);
      const toggleRatioPopover = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const viewportWidth = window.innerWidth || 1024;
        setRatioAnchor({ left: Math.max(8, Math.min(rect.left, viewportWidth - 336)), top: rect.top });
        setRatioOpen((v) => !v);
      };
      const currentRatioOption = IMAGE_RATIO_OPTIONS.find((option) => option.value === imageRatio);
      const ratioChipIcon = currentRatioOption
        ? React.createElement('span', {
            className: 'dsh-canvas-ratio-card-icon',
            style: { width: currentRatioOption.icon[0] + 'px', height: currentRatioOption.icon[1] + 'px' }
          })
        : React.createElement('span', { className: 'dsh-canvas-ratio-card-icon dsh-canvas-ratio-icon-auto' });
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
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-note' }, '仅 API 生图引擎生效；编辑 / 智能擦除跟随原图尺寸')
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
        React.createElement('div', { className: 'dsh-canvas-ratio-wrap', ref: ratioWrapRef },
          React.createElement('button', {
            className: 'dsh-canvas-ratio-chip' + (imageRatio !== 'auto' ? ' dsh-canvas-ratio-chip-set' : ''),
            title: '生图比例：选择后聊天生图优先使用该尺寸（仅 API 引擎生效）',
            onClick: toggleRatioPopover
          },
            ratioChipIcon,
            React.createElement('span', null, currentRatioOption ? ratioOptionLabel(currentRatioOption) : '自动比例'),
            React.createElement('span', { className: 'dsh-canvas-ratio-chip-caret' }, '⌄')
          ),
          ratioPopover
        ),
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

