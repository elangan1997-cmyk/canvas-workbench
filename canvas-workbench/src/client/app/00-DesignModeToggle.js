    function DesignModeToggle(props) {
      const [on, setOn] = React.useState(getMode());
      const [attachState, setAttachState] = React.useState('');
      const [genAsk, setGenAsk] = React.useState({ show: false, active: 0 });
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

