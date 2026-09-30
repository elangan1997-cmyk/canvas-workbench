    // ---- 原生图片展示带(0.2.0 桌面 imagegen 输出)「加入画布」----
    // 新版 DSH 把部分 imagegen 产物渲染成"文件卡片"(data-presented-file),
    // 卡片右上角的「打开方式」菜单(应用列表 + 显示文件位置)由宿主 Menu
    // 原语 portal 渲染。按用户取舍,这里只在菜单内注入一条「加入画布」行
    // (插在「显示文件位置」上方),不在缩略图上放角标按钮。
    // 实测要点:行类名是 CSS-module 哈希,必须运行时克隆原生行保证零差异;
    // 菜单打开时宿主会异步刷新应用列表并重渲染,注入行由子树看护补插;
    // 点击后按卡片文件名匹配缩略图——缩略图 alt 自带完整文件名(含扩展
    // 名),blob 字节在主页面与画布 iframe 均可直接取;上画布走与图片输出
    // 卡片相同的令牌通道(dispatchAddImage),点击后以 Escape 优雅关菜单。
    (function () {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
      // 文件卡片文本是"文件名+说明"连写,文件名只是前缀,不能用 $ 锚定。
      const NAME_IN_TEXT = /[^\s:：()（）「」《》*?'"|<>，,]+\.(?:png|jpe?g|webp|gif|avif|bmp)(?![\w.])/i;
      const MIME_OF_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
      const srcOf = (img) => String(img.currentSrc || img.getAttribute('src') || '');
      const attachmentPathOf = (name) => {
        const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || 'png';
        return 'dsh-attachment:native-strip:' + (MIME_OF_EXT[ext] || 'image/png') + ':' + name;
      };
      const dispatchStripImage = (name, url) => {
        try { dispatchAddImage(attachmentPathOf(name), url); } catch (err) {}
      };

      // 菜单锚点(展开的 chevron)→ 文件卡片 → 文件名 → 可派发引用。
      // 解析三级:①会话级登记表(事件流里的路径/附件,覆盖"只有文件卡片、
      // 没有缩略图"的其他渠道产出)→ 走 dispatchResolvedImage;②同域缩略
      // 图按 alt 精确同名匹配(alt 自带完整文件名)→ 取已加载 blob 字节;
      // ③都没有则不注入,不给用户一个点了没反应的行。
      const fileCardOf = (chevron) => {
        const ctrl = chevron.closest('[data-open-target="file"]');
        if (!ctrl) return null;
        return ctrl.closest('[data-presented-file]') || ctrl.parentElement;
      };
      const resolveCardImage = (card) => {
        if (!card) return null;
        const m = String(card.textContent || '').match(NAME_IN_TEXT);
        if (!m) return null;
        const name = m[0];
        const ref = nativeImageRefs.get(name.toLowerCase());
        if (ref) return { name, ref, url: '' };
        const scope = card.closest('[data-presented-files-row]') || document;
        const img = [...scope.querySelectorAll('img')].find((im) => im.getAttribute('alt') === name)
          || [...document.querySelectorAll('img')].find((im) => im.getAttribute('alt') === name);
        if (!img) return null;
        const url = srcOf(img);
        return /^(?:blob:|https?:|\/|data:)/i.test(url) ? { name, ref: '', url } : null;
      };
      const buildMenuRow = (menu, resolved) => {
        if (menu.querySelector('button[data-dsh-canvas-add]')) return true;
        const revealBtn = [...menu.querySelectorAll('[role="menuitem"]')]
          .find((b) => /显示文件位置|Show file location|Show File Location/i.test(b.textContent || ''));
        const templateBtn = revealBtn || menu.querySelector('[role="menuitem"]');
        if (!templateBtn) return false;
        const templateWrap = templateBtn.closest('div');
        if (!templateWrap || !templateWrap.parentElement) return false;
        const wrap = templateWrap.cloneNode(false);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'menuitem');
        btn.setAttribute('data-dsh-canvas-add', '1');
        btn.className = templateBtn.className;
        const tIcon = templateBtn.querySelector('span');
        if (tIcon && /icon/i.test(String(tIcon.className))) {
          const icon = tIcon.cloneNode(false);
          icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"></rect><path d="M1.5 10.5l3.2-3.2 2.8 2.8 2.3-2.3 4.7 4.2"></path><circle cx="5.6" cy="5.9" r="1.1"></circle></svg>';
          btn.appendChild(icon);
        }
        const tLabel = [...templateBtn.children].find((sp) => sp.tagName === 'SPAN' && !/icon|shortcut/i.test(String(sp.className)));
        const label = document.createElement('span');
        if (tLabel) label.className = tLabel.className;
        label.textContent = '加入画布';
        btn.appendChild(label);
        wrap.appendChild(btn);
        const revealWrap = revealBtn && revealBtn.closest('div');
        if (revealWrap && revealWrap.parentElement) revealWrap.parentElement.insertBefore(wrap, revealWrap);
        else templateWrap.parentElement.appendChild(wrap);
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          // 登记表引用(绝对路径/附件)走完整解析派发;否则直接用缩略图字节。
          if (resolved.ref) dispatchResolvedImage(resolved.ref);
          else dispatchStripImage(resolved.name, resolved.url);
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
          } catch (err) {}
        });
        return true;
      };
      const decorateMenu = (menu) => {
        if (!menu || !menu.isConnected) return;
        const chevron = document.querySelector('[data-open-path-more][aria-expanded="true"]');
        // 菜单节点若被 React 复用(极端情况),残留的解析结果属于上一张
        // 卡片——锚点变化时强制重新解析,防止点到错误的图。
        if (!chevron || menu.__dshCanvasAnchor !== chevron) {
          menu.dataset.dshCanvasResolve = '';
          menu.__dshCanvasAnchor = chevron || null;
          menu.__dshCanvasImage = null;
        }
        if (!menu.dataset.dshCanvasResolve) {
          const resolved = chevron && resolveCardImage(fileCardOf(chevron));
          if (!resolved) { menu.dataset.dshCanvasResolve = 'no'; return; }
          menu.dataset.dshCanvasResolve = 'yes';
          menu.__dshCanvasImage = resolved;
        }
        if (menu.dataset.dshCanvasResolve !== 'yes' || !menu.__dshCanvasImage) return;
        if (!buildMenuRow(menu, menu.__dshCanvasImage)) return;
        if (!menu.__dshCanvasGuard) {
          // 菜单打开期间宿主会异步刷新应用列表并重渲染行;被冲掉即补插,
          // 菜单关闭(节点移除/chevron 收起)后停手。
          menu.__dshCanvasGuard = new MutationObserver(() => {
            if (!menu.isConnected) { menu.__dshCanvasGuard.disconnect(); return; }
            const chevron = document.querySelector('[data-open-path-more][aria-expanded="true"]');
            if (!chevron) { menu.__dshCanvasGuard.disconnect(); return; }
            if (!menu.querySelector('button[data-dsh-canvas-add]')) buildMenuRow(menu, menu.__dshCanvasImage);
          });
          menu.__dshCanvasGuard.observe(menu, { childList: true, subtree: true });
        }
      };
      const scheduleMenu = (menu) => {
        for (const delay of [50, 200, 500]) window.setTimeout(() => decorateMenu(menu), delay);
      };
      const scanAdded = (node) => {
        try {
          if (!node || node.nodeType !== 1) return;
          if (node.matches && node.matches('[role="menu"][data-menu-material]')) scheduleMenu(node);
          if (node.querySelectorAll) node.querySelectorAll('[role="menu"][data-menu-material]').forEach(scheduleMenu);
        } catch (err) {}
      };
      const start = () => {
        scanAdded(document.body);
        try {
          new MutationObserver((records) => {
            for (const record of records) for (const node of record.addedNodes || []) scanAdded(node);
          }).observe(document.body, { childList: true, subtree: true });
        } catch (err) {}
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();
