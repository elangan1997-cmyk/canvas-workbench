    // ---- turn-tail inline images ----
    function ImageTail(props) {
      // 新版 DSH(官方桌面)不再调用插槽 select:turnTail 列表项组件直接收到
      // {turn, seq, openFile} 插槽载荷,数据要从 turn.data 里自取;
      // 旧版把 select 结果作为 props.matched 传入。两条路都保留。
      let matched = Array.isArray(props.matched) ? props.matched : null;
      if (!matched && props.turn && props.turn.data && typeof props.turn.data.get === 'function') {
        try {
          const data = props.turn.data.get('canvas-images');
          const scoped = data && Array.isArray(data.images) ? data.images.filter((i) => i && props.seq != null ? i.seq <= props.seq : true) : [];
          matched = scoped.length ? scoped : null;
        } catch (error) { matched = null; }
      }
      const images = matched || [];
      // 本轮开始时间由聚合节点写进每个条目；旧会话条目没有该字段时为 0，跳过新旧过滤。
      const turnStart = (images.length && images[0] && images[0].startTime) || 0;
      const [preview, setPreview] = React.useState(null);
      const [failed, setFailed] = React.useState({});
      const [swapped, setSwapped] = React.useState({});
      // 回退候选链的进度（path → 已尝试到第几级）、主机按名找回的真实路径、全部候选耗尽
      const [fallbackStep, setFallbackStep] = React.useState({});
      const [remap, setRemap] = React.useState({});
      const [exhausted, setExhausted] = React.useState({});
      const resolveAttempts = React.useRef({});
      const [hidden, setHidden] = React.useState({});
      const [resolvedSources, setResolvedSources] = React.useState({});
      const [contextRevision, setContextRevision] = React.useState(activeChatContextRevision);
      const key = images.map((i) => i.path).join('|');
      const archivedOutputPath = (path) => activeCanvasProjectPath
        ? String(activeCanvasProjectPath).replace(/[\\/]+$/, '') + '/DSH聊天生成图片/' + imageName(path)
        : '';
      const canonicalOutputPath = (path) => {
        if (!path || attachmentFromPath(path) || isDirectImageSource(path) || !activeCanvasProjectPath) return path;
        const normalized = String(path).replace(/\\/g, '/');
        if (normalized.indexOf('/') < 0 || normalized.indexOf('/DSH聊天生成图片/') >= 0) {
          return String(activeCanvasProjectPath).replace(/[\\/]+$/, '') + '/DSH聊天生成图片/' + imageName(path);
        }
        return path;
      };
      // 最后一级回退：让主机按文件名在当前项目 / 工作区常见目录里找回同名图片。
      // 覆盖两类真实故障：AI 文字里写的“计划路径”从未落盘；附件记录的 sourcePath 事后被移走。
      // 同一条目只请求一次；找到后写入 remap，成为候选链首项。
      const resolveByName = (img) => {
        const path = img && img.path;
        if (!path) return Promise.resolve('');
        if (remap[path]) return Promise.resolve(remap[path]);
        if (resolveAttempts.current[path]) return Promise.resolve('');
        resolveAttempts.current[path] = true;
        const nameSource = img.sourcePath && !attachmentFromPath(img.sourcePath) ? img.sourcePath : path;
        const url = '/dsh-canvas/resolve-image?name=' + encodeURIComponent(imageName(nameSource))
          + '&cwd=' + encodeURIComponent(activeChatCwd || '') + '&project=' + encodeURIComponent(activeCanvasProjectPath || '');
        return fetch(url, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            const found = data && data.ok && data.data && data.data.path ? String(data.data.path) : '';
            if (found) setRemap((prev) => (prev[path] === found ? prev : { ...prev, [path]: found }));
            return found;
          })
          .catch(() => '');
      };
      React.useEffect(() => {
        const onContext = () => setContextRevision(activeChatContextRevision);
        window.addEventListener('dsh-canvas:project-context', onContext);
        return () => window.removeEventListener('dsh-canvas:project-context', onContext);
      }, []);
      React.useEffect(() => {
        // 原生 DSH 的 resolveImage 缓存键包含 sessionId；切换会话时也要清掉
        // 组件本地的 Blob URL，避免不同会话复用同名 attachmentId。
        setResolvedSources({});
        setFailed({});
        setSwapped({});
        setFallbackStep({});
        setRemap({});
        setExhausted({});
        resolveAttempts.current = {};
        setHidden({});
        setPreview(null);
      }, [key, activeChatSessionId, contextRevision]);
      React.useEffect(() => {
        // 只校验本地路径；会话附件和远程/data URL 由各自的加载逻辑处理。
        // 文件刚由模型写入时可能有短暂竞态，因此最多重试 4 次，再隐藏确实
        // 不存在的引用。这样不会把“模型提到但没有生成”的路径渲染成破图卡片。
        // 存在性通过后还做新旧判定：源文件 mtime 早于本轮开始时间（留 2 秒
        // 文件系统时间戳容差）说明只是本轮引用的旧图（read_image 对比、文字
        // 提及旧版本），不属于本轮图片输出，同样隐藏。
        let cancelled = false;
        const hide = (path) => setHidden((prev) => (prev[path] ? prev : { ...prev, [path]: true }));
        const isStale = (data) => !!turnStart && !!data && data.ok === true && typeof data.mtime === 'number' && data.mtime < turnStart - 2000;
        const localImages = images.filter((img) => img && !attachmentFromPath(img.path) && !isDirectImageSource(img.path));
        const check = (img, attempt = 0) => {
          if (cancelled || !img) return;
          const resolved = resolveImagePath(canonicalOutputPath(img.path));
          // 事件可能早于当前会话 cwd 到达；等 project-context 事件触发后再检查。
          if (!resolved || !isLocalAbsolutePath(resolved)) return;
          const url = '/dsh-canvas/image-status?path=' + encodeURIComponent(resolved);
          fetch(url, { cache: 'no-store' }).then((response) => {
            if (cancelled) return;
            if (!response.ok) {
              if (attempt < 3) {
                setTimeout(() => check(img, attempt + 1), 250 * (attempt + 1));
                return;
              }
              // 路径确实不存在：同名文件可能在项目归档/assets 里（AI 写了计划路径）；找不到才隐藏。
              resolveByName(img).then((found) => { if (!cancelled && !found) hide(img.path); });
              return;
            }
            response.json().then((data) => {
              if (cancelled || !data || !data.ok) return;
              if (isStale(data)) hide(img.path);
            }).catch(() => {});
          }).catch(() => {
            if (cancelled) return;
            if (attempt < 3) {
              setTimeout(() => check(img, attempt + 1), 250 * (attempt + 1));
            } else {
              resolveByName(img).then((found) => { if (!cancelled && !found) hide(img.path); });
            }
          });
        };
        // 附件条目（imagegen / read_image 结果）用同名 sourcePath 做同样的新旧判定；
        // 没有文件可查的纯附件（DSH 原生 imagegen）无法判定，保持显示。
        const checkAttachmentAge = (img) => {
          if (cancelled || !img || !img.sourcePath || attachmentFromPath(img.sourcePath) || !turnStart) return;
          const resolved = resolveImagePath(canonicalOutputPath(img.sourcePath));
          if (!resolved || !isLocalAbsolutePath(resolved)) return;
          fetch('/dsh-canvas/image-status?path=' + encodeURIComponent(resolved), { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              if (cancelled || !data) return;
              if (isStale(data)) hide(img.path);
            })
            .catch(() => {});
        };
        localImages.forEach((img) => {
          if (!hidden[img.path]) check(img);
        });
        images.forEach((img) => {
          if (img && img.sourcePath && !hidden[img.path]) checkAttachmentAge(img);
        });
        return () => { cancelled = true; };
      }, [key, activeChatSessionId, contextRevision, turnStart]);
      const visibleImages = images.filter((img) => !hidden[img.path]);
      React.useEffect(() => {
        let cancelled = false;
        const pending = visibleImages.filter((img) => attachmentFromPath(img.path) && !resolvedSources[img.path] && !failed[img.path]);
        if (!pending.length) return () => { cancelled = true; };
        Promise.all(pending.map((img) => resolveAttachmentSource(img.path)
          .then((url) => ({ path: img.path, url }))
          .catch(() => ({ path: img.path, error: true }))))
          .then((results) => {
            if (cancelled) return;
            const next = {};
            const errors = {};
            for (const result of results) {
              if (result.url) next[result.path] = result.url;
              if (result.error) errors[result.path] = true;
            }
            if (Object.keys(next).length) setResolvedSources((prev) => ({ ...prev, ...next }));
            if (Object.keys(errors).length) setFailed((prev) => ({ ...prev, ...errors }));
          });
        return () => { cancelled = true; };
      }, [key, activeChatSessionId, contextRevision]);
      if (!visibleImages.length) return null;
      // 附件条目的可操作文件路径：优先条目自带 sourcePath（归档真实文件），
      // 其次当前画布项目拼接路径，最后退回附件引用本身（交给附件解析）。
      const actionPathOf = (img) => {
        if (!img) return '';
        if (remap[img.path]) return remap[img.path];
        if (!attachmentFromPath(img.path)) return canonicalOutputPath(img.path);
        return (img.sourcePath && !attachmentFromPath(img.sourcePath) && img.sourcePath) || archivedOutputPath(img.path) || img.path;
      };
      // 回退候选链：**逐级尝试**而不是取第一个非空，且本地文件优先（即时、可靠），
      // DSH 附件 blob 解析经常悬而不决，只作为附件条目的末级。
      //   附件条目：（主机找回的路径）→ 条目 sourcePath → 当前项目归档同名 → 附件 blob
      //   普通路径：（主机找回的路径）→ 原路径 → 条目 sourcePath → 当前项目归档同名；远程/data URL 直通
      // 链耗尽后再向主机按文件名找回一次；仍无则标记 exhausted，渲染整洁的失败卡。
      const sourceStateOf = (img) => {
        const isAttachment = attachmentFromPath(img.path);
        const canonicalPath = canonicalOutputPath(img.path);
        const chain = [];
        const pushLocal = (candidate) => {
          if (!candidate || attachmentFromPath(candidate) || isDirectImageSource(candidate)) return;
          const resolvedCandidate = resolveImagePath(candidate);
          if (!resolvedCandidate || !isLocalAbsolutePath(resolvedCandidate)) return;
          if (chain.some((entry) => entry.kind === 'local' && entry.path === candidate)) return;
          chain.push({ kind: 'local', path: candidate });
        };
        pushLocal(remap[img.path]);
        if (!isAttachment) pushLocal(canonicalPath);
        if (img.sourcePath) pushLocal(img.sourcePath);
        pushLocal(archivedOutputPath(img.path));
        if (isAttachment) chain.push({ kind: 'blob' });
        if (!isAttachment && !chain.length) {
          // 远程 / data URL：没有本地候选，直通显示
          const direct = displaySourceUrl(canonicalPath);
          return { isAttachment, chain, step: 0, entry: null, src: direct, actionPath: canonicalPath, loading: false, waitingBlob: false };
        }
        const step = Math.min(fallbackStep[img.path] || 0, Math.max(0, chain.length - 1));
        const entry = chain[step];
        const blobUrl = resolvedSources[img.path] || '';
        const src = entry.kind === 'local' ? displaySourceUrl(entry.path) : blobUrl;
        const waitingBlob = entry.kind === 'blob' && !blobUrl && !failed[img.path];
        const actionPath = entry.kind === 'local' ? entry.path : actionPathOf(img);
        return { isAttachment, chain, step, entry, src, actionPath, loading: !exhausted[img.path] && (!src || waitingBlob), waitingBlob };
      };
      const advanceFallback = (img, state) => {
        if (!state.chain.length) { setExhausted((prev) => (prev[img.path] ? prev : { ...prev, [img.path]: true })); return; }
        const next = state.step + 1;
        if (next < state.chain.length) {
          setFallbackStep((prev) => ({ ...prev, [img.path]: next }));
          return;
        }
        resolveByName(img).then((found) => {
          const alreadyTried = state.chain.some((entry) => entry.kind === 'local' && entry.path === found);
          if (found && !alreadyTried) {
            // remap 成为候选链首项：回到第 0 级重新加载
            setFallbackStep((prev) => ({ ...prev, [img.path]: 0 }));
            return;
          }
          setExhausted((prev) => (prev[img.path] ? prev : { ...prev, [img.path]: true }));
        });
      };
      // 附件 blob 解析报错（failed）或超过 6 秒仍未返回时，末级不再等待：
      // 降级到主机按名找回，仍无则渲染失败卡。DSH 旧会话的 resolveImage 可能永远不结算。
      React.useEffect(() => {
        const timers = [];
        visibleImages.forEach((img) => {
          if (!attachmentFromPath(img.path) || exhausted[img.path]) return;
          const state = sourceStateOf(img);
          if (!state.entry || state.entry.kind !== 'blob' || resolvedSources[img.path]) return;
          if (failed[img.path]) { advanceFallback(img, state); return; }
          timers.push(setTimeout(() => {
            const fresh = sourceStateOf(img);
            if (fresh.entry && fresh.entry.kind === 'blob' && !resolvedSources[img.path] && !exhausted[img.path]) advanceFallback(img, fresh);
          }, 6000));
        });
        return () => { timers.forEach((t) => clearTimeout(t)); };
      }, [failed, fallbackStep, remap, resolvedSources, key]);
      const send = (path) => dispatchResolvedImage(canonicalOutputPath(path));
      const rows = visibleImages.map((img) => {
        // 旧会话的 attachmentId 可能随 DSH 更新或会话回放失效，附件记录的 sourcePath 也可能事后被移走；
        // 画布路由已把原图归档到项目目录。sourceStateOf 给出当前应尝试的源与剩余候选。
        const state = sourceStateOf(img);
        const src = state.src;
        const actionPath = state.actionPath;
        const loading = state.loading;
        return React.createElement('div', { key: img.path, className: 'dsh-canvas-image' },
          React.createElement('button', {
            className: 'dsh-canvas-image-box dsh-canvas-image-send',
            title: '点击查看大图',
            onClick: () => setPreview(img)
          },
            exhausted[img.path]
              ? React.createElement('span', { className: 'dsh-canvas-image-loading' }, '图片加载失败')
              : loading
                ? React.createElement('span', { className: 'dsh-canvas-image-loading' }, '图片加载中…')
              : React.createElement('img', {
                src,
                alt: imageName(img.path),
                className: 'dsh-canvas-image-img',
                loading: 'lazy',
                decoding: 'async',
                referrerPolicy: 'no-referrer',
                onLoad: () => { if (exhausted[img.path]) setExhausted((prev) => ({ ...prev, [img.path]: false })); },
                onError: () => { advanceFallback(img, state); }
              })
          ),
          React.createElement('div', { className: 'dsh-canvas-image-meta' },
            React.createElement('span', { className: 'dsh-canvas-image-name', title: actionPath }, imageName(img.path)),
            React.createElement('div', { className: 'dsh-canvas-image-actions' },
              React.createElement('button', { className: 'dsh-canvas-add-btn', title: '在系统文件管理器中选中这个文件', onClick: () => revealImageInFinder(actionPath) }, '在文件夹中显示'),
              React.createElement('button', { className: 'dsh-canvas-add-btn', onClick: () => dispatchResolvedImage(actionPath) }, '加入画布')
            )
          )
        );
      });
      const columns = visibleImages.length === 1 ? 1 : (visibleImages.length <= 4 ? 2 : 3);
      return React.createElement(React.Fragment, null,
        React.createElement('div', { key, className: 'dsh-canvas-tool-output' },
          React.createElement('div', { className: 'dsh-canvas-tool-bar' },
            React.createElement('span', { className: 'dsh-canvas-tool-title' }, '图片输出'),
            React.createElement('span', { className: 'dsh-canvas-tool-count' }, visibleImages.length + ' 张'),
            React.createElement('button', { className: 'dsh-canvas-tool-btn', onClick: () => visibleImages.forEach((img) => send(actionPathOf(img))) }, '全部加入画布')
          ),
          React.createElement('div', { className: 'dsh-canvas-images dsh-canvas-images-cols-' + columns }, rows)
        ),
        preview ? React.createElement('div', { className: 'dsh-canvas-lightbox', role: 'dialog', 'aria-modal': 'true', onClick: () => setPreview(null) },
          React.createElement('div', { className: 'dsh-canvas-lightbox-inner', onClick: (event) => event.stopPropagation() },
            (() => {
              // 大图与缩略图同源：附件优先归档文件（sourcePath 回退），避免
              // 项目未绑定时大图永远“加载中”。
              const previewState = sourceStateOf(preview);
              const previewSrc = previewState.src;
              return previewSrc && !exhausted[preview.path]
                ? React.createElement('img', { src: previewSrc, alt: imageName(preview.path), className: 'dsh-canvas-lightbox-image', decoding: 'async', referrerPolicy: 'no-referrer', onError: () => advanceFallback(preview, previewState) })
                : React.createElement('span', { className: 'dsh-canvas-image-loading' }, exhausted[preview.path] ? '图片加载失败' : '图片加载中…');
            })(),
            React.createElement('div', { className: 'dsh-canvas-lightbox-bar' },
              React.createElement('span', { title: actionPathOf(preview) }, imageName(preview.path)),
              React.createElement('button', { onClick: () => revealImageInFinder(actionPathOf(preview)) }, '在文件夹中显示'),
              React.createElement('button', { onClick: () => send(actionPathOf(preview)) }, '加入画布'),
              React.createElement('button', { onClick: () => setPreview(null) }, '关闭')
            )
          )
        ) : null
      );
    }

