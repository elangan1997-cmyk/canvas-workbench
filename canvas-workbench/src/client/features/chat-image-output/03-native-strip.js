    // ---- 原生图片展示带(0.2.0 桌面 imagegen 输出)注入「加入画布」----
    // 新版 DSH 用自己的横向缩略图带渲染 imagegen 输出:缩略图 <img> 走
    // blob:dsh-app://… 地址,alt 携带完整文件名(实测 0.2.0-rc.2);同一批
    // 文件还会以"文件卡片"(data-presented-file)形式出现,卡片右上角的
    // 「打开方式」菜单(打开文件位置)由宿主 Menu 原语 portal 渲染。
    // 两个入口共享同一套解析/派发:
    //   1. 缩略图悬停按钮——覆盖全部图片(文件卡片只为其中少数文件渲染);
    //   2. 打开方式菜单项——用户点名要的入口,插在「显示文件位置」上方。
    // DOM 由 React 管理:任何重渲染都会冲掉注入节点,因此两处都带
    // "标记已装饰但节点缺失即重插"的看护(MutationObserver 驱动的 sweep)。
    (function () {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
      const SRC_MARKS = ['/api/attachments/', '/dsh-attachment', '/dsh-canvas/image'];
      const NAME_RE = /[^\s/\\]+\.(?:png|jpe?g|webp|gif|avif|bmp)$/i;
      // 文件卡片文本是"文件名+说明"连写,文件名只是前缀,不能用 $ 锚定。
      const NAME_IN_TEXT = /[^\s:：()（）「」《》*?'"|<>，,]+\.(?:png|jpe?g|webp|gif|avif|bmp)(?![\w.])/i;
      const BTN_FLAG = 'dshCanvasAddBtn';
      const MIME_OF_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };

      const inPluginSurface = (node) => {
        for (let el = node; el && el !== document.body; el = el.parentElement) {
          const raw = el.className;
          const cls = String(raw && raw.baseVal !== undefined ? raw.baseVal : raw || '');
          if (cls.indexOf('dsh-canvas') >= 0) return true;
        }
        return false;
      };
      const srcOf = (img) => String(img.currentSrc || img.getAttribute('src') || '');
      const matchesStrip = (img) => {
        const src = srcOf(img);
        if (!src) return false;
        if (SRC_MARKS.some((mark) => src.indexOf(mark) >= 0)) return true;
        // 0.2.0 桌面的附件缩略图用 blob:dsh-app://… 渲染;要求已加载且
        // 尺寸真实(排除图标),文件名从 alt 取(带扩展名的才是 imagegen 带)。
        return /^blob:/i.test(src) && Number(img.naturalWidth || 0) > 80;
      };
      // alt 是实测最可靠的文件名来源(带扩展名);宿主容器文本与 src 尾部仅作回退。
      const nameOf = (img, host) => {
        const alt = String(img.getAttribute('alt') || '').trim();
        if (NAME_RE.test(alt)) return alt.match(NAME_RE)[0];
        if (host) {
          for (const node of host.querySelectorAll('span, div, p, figcaption')) {
            const m = (node.textContent || '').trim().match(NAME_RE);
            if (m) return m[0];
          }
        }
        const tail = decodeURIComponent(srcOf(img).split('?')[0].split('#')[0].split('/').pop() || '');
        const m = tail.match(NAME_RE);
        return m ? m[0] : '';
      };
      const attachmentPathOf = (name) => {
        const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || 'png';
        return 'dsh-attachment:native-strip:' + (MIME_OF_EXT[ext] || 'image/png') + ':' + name;
      };
      const dispatchStripImage = (name, url) => {
        try { dispatchAddImage(attachmentPathOf(name), url); } catch (err) {}
      };

      // ---- 入口 1:缩略图角标按钮(常显) ----
      // v3 的教训有二:按钮挂在 img.closest('div') 的 right/bottom,而那个
      // 容器是"图+说明"整卡(比图宽 170px+),按钮落点飘到图外说明区上空;
      // 悬停显隐则被原生带的粘性标题条(浮在内容上方的 20px 覆盖层)随机
      // 拦截,mouseenter 不可靠(实测指针落在标题条上时 host 永不 enter)。
      // 因此按 img offset 贴图右下角并常显,React 重渲染冲掉节点时由
      // sweep 校验存活并重插。
      const buildHoverButton = (img) => {
        const host = img.closest('a, figure, div') || img.parentElement;
        if (!host) return null;
        try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (err) {}
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '加入画布';
        btn.dataset[BTN_FLAG] = '1';
        btn.setAttribute('style', [
          'position:absolute', 'z-index:5',
          'padding:3px 9px', 'border-radius:6px',
          'border:1px solid var(--dsh-border, rgba(148,163,184,.4))',
          'background:var(--dsh-surface, rgba(15,23,42,.82))',
          'color:var(--dsh-fg, #f8fafc)',
          'font-size:11px', 'line-height:1.5', 'cursor:pointer',
          'opacity:.92', 'transition:opacity .15s ease', 'pointer-events:auto'
        ].join(';') + ';backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)');
        const place = () => {
          const left = img.offsetLeft + img.clientWidth;
          const top = img.offsetTop + img.clientHeight;
          btn.style.left = Math.max(img.offsetLeft + 4, left - btn.offsetWidth - 6) + 'px';
          btn.style.top = Math.max(img.offsetTop + 4, top - btn.offsetHeight - 6) + 'px';
          btn.style.right = 'auto';
          btn.style.bottom = 'auto';
        };
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          dispatchStripImage(nameOf(img, host), srcOf(img));
        });
        host.appendChild(btn);
        place();
        return btn;
      };
      const decorateImg = (img) => {
        if (!img || !matchesStrip(img)) return;
        if (inPluginSurface(img)) { if (!img.dataset.dshCanvasNativeBtn) img.dataset.dshCanvasNativeBtn = 'skip'; return; }
        const host = img.closest('a, figure, div') || img.parentElement;
        if (!host) return;
        // 已装饰过:React 重渲染可能冲掉按钮,节点缺失即重插。
        if (img.dataset.dshCanvasNativeBtn === '1') {
          if (host.querySelector('button[data-dsh-canvas-add-btn]')) return;
          buildHoverButton(img);
          return;
        }
        img.dataset.dshCanvasNativeBtn = '1';
        buildHoverButton(img);
      };

      // ---- 入口 2:文件卡片「打开方式」菜单项 ----
      // 菜单由宿主 Menu 原语 portal 到 body(role=menu + data-menu-material),
      // 打开方式按钮在文件卡片上(data-open-target="file",chevron 带
      // data-open-path-more 且展开时 aria-expanded=true)。行样式克隆自
      // 「显示文件位置」行,保证与宿主视觉零差异;菜单项异步加载与重渲染
      // 由子树观察者补插。点击后用 Escape 关闭菜单(与宿主键盘路径一致)。
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
        const scope = card.closest('[data-presented-files-row]') || document;
        const img = [...scope.querySelectorAll('img')].find((im) => im.getAttribute('alt') === name)
          || [...document.querySelectorAll('img')].find((im) => im.getAttribute('alt') === name);
        if (!img) return null;
        const url = srcOf(img);
        return /^(?:blob:|https?:|\/|data:)/i.test(url) ? { name, url } : null;
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
          dispatchStripImage(resolved.name, resolved.url);
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
          } catch (err) {}
        });
        return true;
      };
      const decorateMenu = (menu) => {
        if (!menu || !menu.isConnected) return;
        if (!menu.dataset.dshCanvasResolve) {
          const chevron = document.querySelector('[data-open-path-more][aria-expanded="true"]');
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

      let sweepScheduled = false;
      const sweep = () => {
        sweepScheduled = false;
        try { document.querySelectorAll('img').forEach(decorateImg); } catch (err) {}
      };
      const scheduleSweep = () => {
        if (sweepScheduled) return;
        sweepScheduled = true;
        window.setTimeout(sweep, 150);
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
        sweep();
        scanAdded(document.body);
        try {
          new MutationObserver((records) => {
            scheduleSweep();
            for (const record of records) for (const node of record.addedNodes || []) scanAdded(node);
          }).observe(document.body, { childList: true, subtree: true });
        } catch (err) {}
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();
