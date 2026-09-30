    // 每次完整快照写入都带单调递增的时间戳。不同聊天/旧版插件同时
    // 写入同一 canvas.json 时，host 可据此拒绝迟到的旧快照，避免删除内容
    // 被另一个聊天的旧状态“复活”。
    const CANVAS_CLIENT_ID = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    let lastCanvasSaveAt = 0;
    let lastCanvasChangeAt = 0;
    function markCanvasChanged(snapshot, previous) {
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      const previousMeta = previous && previous.dshMeta && typeof previous.dshMeta === 'object' ? previous.dshMeta : {};
      const changedAt = Math.max(Date.now(), lastCanvasChangeAt + 1);
      lastCanvasChangeAt = changedAt;
      const previousRevision = Number(previousMeta.revision || previousMeta.savedAt || 0);
      return {
        ...snapshot,
        dshMeta: {
          ...previousMeta,
          ...(snapshot.dshMeta && typeof snapshot.dshMeta === 'object' ? snapshot.dshMeta : {}),
          // 保存时携带“我基于哪个服务器版本修改”。另一个聊天若仍停留在
          // 旧版本，即使它稍后才触发 onChange，也不能把旧元素重新写回项目。
          baseRevision: previousRevision > 0 ? previousRevision : Number(previousMeta.baseRevision || 0),
          revision: changedAt,
          savedAt: changedAt,
          clientId: CANVAS_CLIENT_ID
        }
      };
    }
    function versionedCanvasState(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      const existingMeta = snapshot.dshMeta && typeof snapshot.dshMeta === 'object' ? snapshot.dshMeta : {};
      const existingRevision = Number(existingMeta.revision || existingMeta.savedAt || 0);
      const savedAt = existingRevision > 0 ? existingRevision : Math.max(Date.now(), lastCanvasSaveAt + 1);
      lastCanvasSaveAt = savedAt;
      // 瞬时态绝不随快照复活(与 1.9.2 加载时清扫同一原则,这里在落盘侧根治):
      // 聊天生图的「生成中/失败」占位卡是会话内 UI 状态——曾出现用户删除失败卡
      // 后切换画布/重启,删除在保存竞赛中丢失、失败卡随旧快照整批复活。落盘时
      // 直接剥离(生成中 processing / 失败 failed);完成态 complete 是真实图片,
      // 保留。图片编辑失败卡(无 dshChatGenState 标记)不受影响。
      const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
      const liveElements = elements.filter((item) => {
        if (!item || item.type !== 'image') return true;
        const cd = item.customData;
        const genState = cd && cd.dshChatGenState;
        return genState !== 'processing' && genState !== 'failed';
      });
      return {
        ...snapshot,
        elements: liveElements,
        // 性能 v3（治本）：磁盘快照不再内嵌图片 base64。凡 fileId 能映射到
        // 元素 customData.dshSourcePath 的文件，落盘时只存 dshPath 引用；
        // 运行时快照（latestSnapshot）保持完整 dataURL，行为与归档/发送
        // 到聊天等管线无关。iframe 在 load 时按需还原（见 load 分支）。
        // 无磁盘路径的文件（如刚粘贴、尚未归档）继续内嵌，后续保存自愈。
        files: stripInlineFileData({ ...snapshot, elements: liveElements }),
        dshMeta: {
          ...existingMeta,
          revision: existingRevision > 0 ? existingRevision : savedAt,
          savedAt,
          clientId: CANVAS_CLIENT_ID
        }
      };
    }
    // 与服务端 IMAGE_MIME 白名单一致：只有 /dsh-canvas/image 能取回的
    // 扩展名才允许剥离（pdf/ai 文档源的预览路径不在其中，保持内嵌）。
    function restorablePathExt(path) {
      const m = /\.([a-z0-9]+)$/i.exec(String(path || ''));
      return m && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].indexOf(m[1].toLowerCase()) >= 0;
    }
    function stripInlineFileData(snapshot) {
      const files = snapshot.files && typeof snapshot.files === 'object' ? snapshot.files : null;
      if (!files) return snapshot.files;
      const pathByFileId = {};
      (snapshot.elements || []).forEach((item) => {
        if (!item || item.type !== 'image' || item.isDeleted || !item.fileId) return;
        const p = item.customData && item.customData.dshSourcePath;
        if (p && !pathByFileId[item.fileId] && restorablePathExt(p)) pathByFileId[item.fileId] = String(p);
      });
      let changed = false;
      const next = {};
      Object.keys(files).forEach((id) => {
        const f = files[id];
        const path = pathByFileId[id];
        if (f && typeof f.dataURL === 'string' && f.dataURL.startsWith('data:') && path) {
          next[id] = { id: f.id || id, mimeType: f.mimeType, dshPath: path, created: f.created, lastRetrieved: f.lastRetrieved };
          changed = true;
        } else {
          next[id] = f;
        }
      });
      return changed ? next : files;
    }
    function loadState(cwd, project) {
      return fetch(stateEndpoint(cwd, project), { method: 'GET', cache: 'no-store' })
        .then((r) => r.text())
        .then((t) => { try { return t && t !== 'null' ? JSON.parse(t) : null; } catch (e) { return null; } })
        .catch(() => null);
    }
    function saveState(json, cwd, project) {
      if (!json) return Promise.resolve();
      const body = typeof json === 'string' ? json : JSON.stringify(versionedCanvasState(json));
      return fetch(stateEndpoint(cwd, project), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        .catch(() => {});
    }
    function listProjects(cwd) {
      return fetch('/dsh-canvas/projects?cwd=' + encodeURIComponent(cwd), { cache: 'no-store' }).then((r) => r.json());
    }

