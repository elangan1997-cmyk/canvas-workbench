    // 引擎设置弹窗里的「本地工具链」状态卡:后台预置(python/rembg/模型/矢量/dsh-codex)
    // 的实时状态 + 手动「立即准备」。预置在插件启动时自动开始,这里只是可视化与兜底入口。
    const TOOLCHAIN_LABELS = {
      python: 'Python 运行时',
      rembg: '去背景引擎',
      vectorize: '转矢量引擎',
      rembgModel: '识别模型(约170MB)',
      ocr: 'OCR 文字识别',
      dshCodex: 'dsh-codex 引擎'
    };

    function ToolchainCard(props) {
      const status = props.toolchain;
      const [busy, setBusy] = React.useState(false);
      // 打开期间 3s 轮询刷新(有 downloading/preparing 时进度会动)
      React.useEffect(() => {
        if (!status) return undefined;
        const items = (status && status.items) || {};
        const active = Object.values(items).some((item) => item && (item.state === 'downloading' || item.state === 'preparing' || item.state === 'extracting'));
        if (!active) return undefined;
        const timer = window.setInterval(() => {
          if (typeof props.onRefresh === 'function') props.onRefresh();
        }, 3000);
        return () => window.clearInterval(timer);
      }, [status]);
      if (!status || !status.items) return null;
      const entries = Object.keys(TOOLCHAIN_LABELS)
        .map((key) => ({ key, label: TOOLCHAIN_LABELS[key], item: status.items[key] }))
        .filter((entry) => entry.item);
      if (!entries.length) return null;
      const stateText = (item) => {
        switch (item.state) {
          case 'ready': return '已就绪';
          case 'downloading': return item.percent ? '下载中 ' + item.percent + '%' : '下载中…';
          case 'extracting': return '解压中…';
          case 'preparing': return '安装依赖中…';
          case 'error': return '失败:' + String(item.error || '').slice(0, 40);
          case 'skipped': return '本机不可用:' + String(item.reason || '');
          default: return item.state || '…';
        }
      };
      const allReady = entries.every((entry) => entry.item.state === 'ready');
      const prepareNow = () => {
        setBusy(true);
        fetch('/dsh-canvas/toolchain-prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
          .catch(() => {})
          .finally(() => { setBusy(false); if (typeof props.onRefresh === 'function') props.onRefresh(); });
      };
      return React.createElement('div', { className: 'dsh-canvas-toolchain' },
        React.createElement('div', { className: 'dsh-canvas-toolchain-head' },
          React.createElement('span', null, '本地工具链'),
          React.createElement('small', null, allReady ? '全部就绪，无需等待' : '后台自动准备，首次使用前无需手动操作'),
          allReady ? null : React.createElement('button', { className: 'dsh-canvas-tb', disabled: busy, onClick: prepareNow }, busy ? '准备中…' : '立即准备')
        ),
        React.createElement('div', { className: 'dsh-canvas-toolchain-rows' },
          entries.map((entry) => React.createElement('div', { key: entry.key, className: 'dsh-canvas-toolchain-row' },
            React.createElement('span', { className: 'dsh-canvas-toolchain-name' }, entry.label),
            React.createElement('span', { className: 'dsh-canvas-toolchain-state is-' + entry.item.state }, stateText(entry.item))
          ))
        )
      );
    }

