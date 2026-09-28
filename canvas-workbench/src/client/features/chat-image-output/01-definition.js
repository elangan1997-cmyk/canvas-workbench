    // ---- turn-scoped accumulation ----
    const canvasImagesDefinition = {
      kind: 'canvas-images',
      match(event) {
        if (!event || !event.data || event.data.turn == null) return null;
        if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' };
        // 与 DSH/Codex 原生会话视图一致：替换型 assistant 消息只供模型内部使用，
        // 不应再次出现在用户可见的图片输出里。旧版本没有 surfaceOp 时保持兼容。
        if (event.type === 'assistant/message' && event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null;
        // 不同模型/流式适配器可能在工具结果、消息收尾或 turn/end 携带图片；统一纳入同一轮去重。
        // assistant/chunk 仅处理 block-end，避免高频流式片段增加渲染和解析开销。
        if (event.type === 'assistant/chunk') {
          const chunkType = event.data.chunk && event.data.chunk.type;
          if (chunkType !== 'block-end') return null;
        }
        if (event.type === 'tool/result' || event.type === 'assistant/message' || event.type === 'assistant/chunk' || event.type === 'turn/end' || event.type === 'tool/end') return { id: String(event.data.turn), role: 'update' };
        return null;
      },
      start(_context, match) {
        // turn/start 的 time 是本轮开始的墙钟时间；图片输出卡片用它区分
        // “本轮新生成的文件”与“本轮只是读取/提及的旧文件”（按文件 mtime 判定）。
        return { turn: match.event.data.turn, images: [], finalImagesSeen: false, startTime: match.event.time || 0 };
      },
      update(context, match) {
        const found = extractGeneratedImagePaths(match.event);
        if (!found.length) return context.state;
        const images = [...context.state.images];
        const seen = new Set(images.map((i) => i.path));
        const additions = [];
        for (const entry of found) {
          const p = entry.path;
          if (seen.has(p)) continue;
          const incomingRef = attachmentFromPath(p);
          const incomingName = imageName(p).toLowerCase();
          // Codex wrapper 可能先输出“/ private/tmp/…”的文本路径，随后 read_image
          // 再返回同一图片的持久化附件。附件更可靠，替换掉先到的临时路径。
          if (incomingRef && incomingRef.name) {
            const staleIndex = images.findIndex((item) => !attachmentFromPath(item.path) && imageName(item.path).toLowerCase() === incomingName);
            if (staleIndex >= 0) {
              seen.delete(images[staleIndex].path);
              images.splice(staleIndex, 1);
            }
          } else {
            const attachmentIndex = images.findIndex((item) => {
              const ref = attachmentFromPath(item.path);
              return !!(ref && ref.name && ref.name.toLowerCase() === incomingName);
            });
            if (attachmentIndex >= 0) continue;
          }
          seen.add(p);
          const item = { path: p, seq: match.event.seq, startTime: context.state.startTime || 0, sourcePath: entry.sourcePath || '', producer: 'imagegen' };
          images.push(item);
          additions.push(item);
        }
        if (!additions.length) return context.state;
        return { ...context.state, images };
      },
      buildLocationData(context, scope) {
        if (scope !== 'turn' || !context.state) return null;
        return { kind: 'turn', turn: context.state.turn, key: 'canvas-images', value: { images: context.state.images } };
      }
    };

    // 只有图片输出卡片的“加入画布”按钮能拿到这个闭包内令牌。
    // 其它扫描、工具结果、项目文件同步都不能伪造加入事件。
    const CANVAS_ADD_TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);
    function dispatchAddImage(path, url) {
      window.dispatchEvent(new CustomEvent('dsh-canvas:add-image', {
        detail: { path, url: url || displaySourceUrl(path), explicit: true, token: CANVAS_ADD_TOKEN }
      }));
    }
    // ---- 聊天生图自动上画布(1.9)----
    // 开关默认开启;批量生图或大量抽卡重跑时建议关闭,改回卡片上的手动「加入画布」。
    // 自动上画布只认宿主 /dsh-canvas/generation-status 登记的本轮产出路径,
    // 复用与手动按钮完全相同的令牌通道,不新增任何旁路。
    const autoAddDispatched = new Set();
    function canvasAutoAddEnabled() {
      try { return window.localStorage.getItem(AUTO_ADD_KEY) !== 'off'; } catch (err) { return true; }
    }
    function setCanvasAutoAddEnabled(value) {
      try { window.localStorage.setItem(AUTO_ADD_KEY, value ? 'on' : 'off'); } catch (err) {}
    }
    function dispatchGeneratedToCanvas(path) {
      if (!path || autoAddDispatched.has(path)) return false;
      autoAddDispatched.add(path);
      // 宿主登记的产出路径本身就是绝对归档路径,与手动按钮点击时
      // dispatchResolvedImage 拿到的 actionPath 同构,直接派发即可。
      dispatchResolvedImage(path);
      return true;
    }
    function revealImageInFinder(path) {
      if (attachmentFromPath(path)) {
        window.alert('这张图片是聊天历史附件，无法直接在系统文件管理器中定位');
        return;
      }
      const resolved = resolveImagePath(path);
      if (!resolved || resolved.indexOf('data:image/') === 0) {
        window.alert('这张图片没有可定位的本地文件');
        return;
      }
      fetch('/dsh-canvas/reveal-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: resolved })
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((result) => {
          if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '无法在文件夹中显示');
        })
        .catch((err) => window.alert('无法在文件夹中显示：' + String((err && err.message) || err)));
    }
