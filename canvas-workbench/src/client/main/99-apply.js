    function apply(ctx) {
      clientRootContext = ctx;
      // DSH 的会话服务和插槽在不同桌面版本中并不完全一致。它们全部是
      // 可选增强能力：缺少某一项时只关闭对应 UI，绝不能阻断 renderer。
      // DSH 2.0.4/rc.7 将浏览器会话附件服务注册为 `conversation`；部分
      // 旧构建曾使用 `uiConversation`。通过 Cordis 的 get/inject 取服务，
      // 不再直接访问未声明属性，保证两个命名都能兼容。
      let conversationEventsApi = null;
      let conversationEventDispose = null;
      const installConfigurationHelper = () => {
        dshConfigurationHelper = (prompt) => {
          const sessions = ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : null);
          const conversation = conversationApi || (typeof ctx.get === 'function' ? (ctx.get('conversation') || ctx.get('uiConversation')) : null);
          const sessionId = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().current : activeChatSessionId;
          const scope = sessions && typeof sessions.scope === 'function' && sessionId ? sessions.scope(sessionId) : null;
          if (!conversation || !conversation.input || typeof conversation.input.for !== 'function' || !scope) return false;
          const input = conversation.input.for(scope);
          if (!input || typeof input.setDraft !== 'function') return false;
          const snapshot = input.state && typeof input.state.getSnapshot === 'function' ? input.state.getSnapshot() : {};
          const draft = String(snapshot && snapshot.draft || '');
          input.setDraft(draft.trim() ? draft + '\n\n' + prompt : prompt);
          const textarea = document.querySelector('[data-composer-card] textarea');
          if (textarea && typeof textarea.focus === 'function') requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
          return true;
        };
      };
      const installConversationEvents = (api) => {
        if (!api || conversationEventsApi === api || !api.events || typeof api.events.register !== 'function') return false;
        try {
          if (typeof conversationEventDispose === 'function') conversationEventDispose();
          const result = api.events.register(canvasImagesDefinition);
          conversationEventsApi = api;
          conversationEventDispose = typeof result === 'function' ? result : null;
          return true;
        } catch (error) {
          compatibilityLogger(ctx, 'warn', '会话图片事件已停用', error);
          return false;
        }
      };
      try {
        conversationApi = typeof ctx.get === 'function' ? (ctx.get('conversation') || ctx.get('uiConversation') || null) : null;
        installConversationEvents(conversationApi);
        installConfigurationHelper();
      } catch (error) { conversationApi = null; }
      try {
        ctx.inject(['conversation'], (scope) => {
          conversationApi = scope.conversation || conversationApi;
          installConversationEvents(conversationApi);
          installConfigurationHelper();
          return () => { if (conversationApi === scope.conversation) conversationApi = null; };
        });
      } catch (error) { compatibilityLogger(ctx, 'warn', '当前 DSH 暂未提供 conversation 服务', error); }
      try {
        ctx.inject(['uiConversation'], (scope) => {
          conversationApi = scope.uiConversation || conversationApi;
          installConversationEvents(conversationApi);
          installConfigurationHelper();
          return () => { if (conversationApi === scope.uiConversation) conversationApi = null; };
        });
      } catch (error) { /* 新版没有旧别名是正常情况 */ }
      safeEffect(ctx, '会话图片事件清理', () => () => {
        if (typeof conversationEventDispose === 'function') conversationEventDispose();
        conversationEventDispose = null;
        conversationEventsApi = null;
        dshConfigurationHelper = null;
        clientRootContext = null;
      });
      // modelDirectories 在旧 DSH 版本中不存在，因此不声明为插件硬依赖。
      // 通过 Cordis 的延迟 inject 获取：新版可精确跟随聊天模型，
      // 旧版则仅失去该增强能力，画布仍可加载并回退本地 OCR。
      try {
        ctx.inject(['modelDirectories'], (scope) => {
          modelDirectoriesApi = scope.modelDirectories || null;
          window.dispatchEvent(new CustomEvent('dsh-canvas:model-directories-ready'));
          return () => { if (modelDirectoriesApi === scope.modelDirectories) modelDirectoriesApi = null; };
        });
      } catch (error) { compatibilityLogger(ctx, 'warn', '当前 DSH 不提供会话模型目录，文字识别将使用本地兜底', error); }
      const styleTag = document.createElement('style');
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      // ctx.effect 立即执行回调；回调返回清理函数（不执行），卸载时才移除样式
      safeEffect(ctx, '样式清理', () => () => styleTag.remove());

      // 会话服务可能在插件 apply 之后才出现。上面的幂等安装器会在
      // get 或延迟 inject 任一路径就绪时注册，避免重启后旧对话图片卡片消失。
      if (!conversationEventsApi) compatibilityLogger(ctx, 'warn', '会话图片事件正在等待 conversation 服务');

      safeEffect(ctx, '本地图片回退', () => installLocalMarkdownImageFallback());

      // 与 DSH 2.x 官方 deliverables 插件保持同一注册时序。
      // turnTail 是会话回放的结构插槽，不应再包一层 effect，
      // 否则已完成回合可能在插槽注册前已经物化。
      // 结构插槽只依赖 slots，不应被 conversation 服务的启动时序阻断。
      safeSlot(ctx, 'conversation.chat.turnTail', {
        options: {
          name: 'conversation.chat.turnTail',
          // 新版官方桌面的列表插槽要求条目带稳定 id,缺 id 的注册会被静默忽略
          // (对照官方 schedule-created 条目)。数据获取双保险:select(旧版宿主调用)
          // + ImageTail 组件内从 props.turn 自取(新版宿主直接传插槽载荷)。
          id: 'dsh-canvas-image-tail',
          order: 10,
          select: (owner) => {
            try {
              const data = owner && owner.turn && owner.turn.data && typeof owner.turn.data.get === 'function' ? owner.turn.data.get('canvas-images') : null;
              const images = data && Array.isArray(data.images) ? data.images.filter((i) => i.seq <= owner.seq) : [];
              // 不再截取最后 9 张：每轮的全部图片输出都要显示，
              // 网格列数逻辑本身能自适应任意数量。
              return images.length ? images : null;
            } catch (error) { return null; }
          }
        },
        component: ImageTail
      }, false);

      safeSlot(ctx, 'conversation.input.dock', {
        options: { name: 'conversation.input.dock', id: 'dsh-canvas-mode', order: 30, label: 'Design Mode' },
        component: DesignModeToggle
      });

      safeSlot(ctx, 'shell.overlay', {
        options: { name: 'shell.overlay', id: 'dsh-canvas-overlay', order: 0 },
        component: CanvasOverlayBoundary
      });
    }

    exports.apply = apply;
    // conversation 在不同 DSH 版本中的注册时序和别名不同，使用上面的
    // 延迟注入兼容；这里只把稳定的 slots 设为硬依赖。
    exports.inject = ['slots'];
    return module.exports;
  }
});
