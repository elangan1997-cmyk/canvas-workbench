    // ---- design-mode toggle in the composer dock ----
    let conversationApi = null;
    let clientRootContext = null;
    let modelDirectoriesApi = null;
    let dshConfigurationHelper = null;
    let activeChatModelSelection = null;
    let activeChatCwd = '';
    let activeChatSessionId = '';
    let activeCanvasProjectPath = '';
    let activeChatContextRevision = 0;
    function conversationServiceUsable(service) {
      // 新版官方桌面把 createDraftImages(sessionId, files) 改名为 createDrafts;
      // 两条签名都认,旧版 DSH 不受影响。
      return Boolean(service) && (typeof service.createDrafts === 'function' || typeof service.createDraftImages === 'function');
    }
    function currentConversationService() {
      if (conversationApi && conversationServiceUsable(conversationApi)) return conversationApi;
      var root = clientRootContext;
      var candidate = null;
      try { candidate = root && typeof root.get === 'function' ? (root.get('conversation') || root.get('uiConversation')) : null; } catch (e) {}
      if (!candidate) {
        try { candidate = root && (root.conversation || root.uiConversation) || null; } catch (e) {}
      }
      if (candidate) conversationApi = candidate;
      return candidate;
    }
    async function waitForConversationService() {
      for (var attempt = 0; attempt < 12; attempt += 1) {
        var service = currentConversationService();
        if (service && conversationServiceUsable(service)) return service;
        await new Promise(function(resolve){setTimeout(resolve,100);});
      }
      return null;
    }
    function setActiveChatContext(cwd, sessionId) {
      const nextCwd = String(cwd || '').trim();
      const nextSessionId = String(sessionId || '');
      if (activeChatCwd === nextCwd && activeChatSessionId === nextSessionId) return;
      activeChatCwd = nextCwd;
      activeChatSessionId = nextSessionId;
      activeChatContextRevision += 1;
      window.dispatchEvent(new CustomEvent('dsh-canvas:project-context', {
        detail: { cwd: activeChatCwd, sessionId: activeChatSessionId }
      }));
    }
    async function resolveAttachmentSource(path) {
      const ref = attachmentFromPath(path);
      const service = await waitForConversationService();
      if (!ref || !service || !activeChatSessionId || typeof service.imageUrl !== 'function') {
        return Promise.reject(new Error('图片附件暂不可用'));
      }
      return Promise.resolve(service.imageUrl(activeChatSessionId, ref));
    }
    function dispatchResolvedImage(path) {
      if (attachmentFromPath(path)) {
        resolveAttachmentSource(path)
          .then((url) => dispatchAddImage(path, url))
          .catch(() => {});
        return;
      }
      dispatchAddImage(path, displaySourceUrl(path));
    }
