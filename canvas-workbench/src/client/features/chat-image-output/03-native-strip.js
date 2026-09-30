    // ---- 原生图片展示带(0.2.0 桌面 imagegen 输出)注入「加入画布」----
    // 新版 DSH 用自己的横向缩略图带渲染 imagegen 工具输出。图片 src 走宿主附件
    // 服务(/api/attachments/,sha256 引用)或插件图片路由,按多模式识别;文件名从
    // 缩略图下方标注/alt 取得,与轮次尾图片输出卡片走同一 CANVAS_ADD_TOKEN
    // 令牌通道(dispatchAddImage)。字节直接取 <img> 已加载成功的同源 URL,插件
    // 自有表面(类名 dsh-canvas- 前缀)不重复装饰。
    (function () {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
      const SRC_MARKS = ['/api/attachments/', '/dsh-attachment', '/dsh-canvas/image'];
      const NAME_RE = /[^\s/\\]+\.(?:png|jpe?g|webp|gif|avif|bmp)$/i;
      const inPluginSurface = (node) => {
        for (let el = node; el && el !== document.body; el = el.parentElement) {
          const raw = el.className;
          const cls = String(raw && raw.baseVal !== undefined ? raw.baseVal : raw || '');
          if (cls.indexOf('dsh-canvas') >= 0) return true;
        }
        return false;
      };
      const matchesStrip = (img) => {
        const src = String(img.currentSrc || img.getAttribute('src') || '');
        return Boolean(src) && SRC_MARKS.some((mark) => src.indexOf(mark) >= 0);
      };
      // 文件名:alt → 容器标注文字 → src 尾部,三级回退。
      const nameOf = (img, host) => {
        const alt = String(img.getAttribute('alt') || '').trim();
        if (NAME_RE.test(alt)) return alt.match(NAME_RE)[0];
        if (host) {
          for (const node of host.querySelectorAll('span, div, p, figcaption')) {
            const text = (node.textContent || '').trim();
            const m = text.match(NAME_RE);
            if (m) return m[0];
          }
        }
        const src = String(img.currentSrc || img.getAttribute('src') || '');
        const tail = decodeURIComponent(src.split('?')[0].split('#')[0].split('/').pop() || '');
        const m = tail.match(NAME_RE);
        return m ? m[0] : '';
      };
      const decorate = (img) => {
        if (!img || img.dataset.dshCanvasNativeBtn || !matchesStrip(img)) return;
        if (inPluginSurface(img)) { img.dataset.dshCanvasNativeBtn = 'skip'; return; }
        const host = img.closest('a, figure, div') || img.parentElement;
        if (!host || host.dataset.dshCanvasNativeHost) return;
        const name = nameOf(img, host) || ('画布图片-' + Date.now().toString(36) + '.png');
        const url = String(img.currentSrc || img.getAttribute('src') || '');
        img.dataset.dshCanvasNativeBtn = '1';
        host.dataset.dshCanvasNativeHost = '1';
        try {
          if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        } catch (err) {}
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '加入画布';
        btn.setAttribute('style', [
          'position:absolute', 'right:6px', 'bottom:6px', 'z-index:5',
          'padding:3px 9px', 'border-radius:6px',
          'border:1px solid var(--dsh-border, rgba(148,163,184,.4))',
          'background:var(--dsh-surface, rgba(15,23,42,.82))',
          'color:var(--dsh-fg, #f8fafc)',
          'font-size:11px', 'line-height:1.5', 'cursor:pointer',
          'opacity:0', 'transition:opacity .15s ease'
        ].join(';') + ';backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)');
        const show = () => { btn.style.opacity = '1'; };
        const hide = () => { btn.style.opacity = '0'; };
        host.addEventListener('mouseenter', show, { passive: true });
        host.addEventListener('mouseleave', hide, { passive: true });
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          try {
            // 附件引用式路径:imageName() 会取到真实文件名;url 用缩略图已加载
            // 成功的同源地址,字节直接可取,不依赖路径解析。
            const path = 'dsh-attachment:native-strip:image/png:' + name;
            dispatchAddImage(path, url);
          } catch (err) {}
        });
        host.appendChild(btn);
      };
      let sweepScheduled = false;
      const sweep = () => {
        sweepScheduled = false;
        try { document.querySelectorAll('img').forEach(decorate); } catch (err) {}
      };
      const scheduleSweep = () => {
        if (sweepScheduled) return;
        sweepScheduled = true;
        window.setTimeout(sweep, 150);
      };
      const start = () => {
        sweep();
        try {
          new MutationObserver(scheduleSweep).observe(document.body, { childList: true, subtree: true });
        } catch (err) {}
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();
