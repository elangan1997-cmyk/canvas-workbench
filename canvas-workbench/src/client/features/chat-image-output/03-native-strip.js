    // ---- 原生图片展示带(0.2.0 桌面 imagegen 输出)注入「加入画布」----
    // 新版 DSH 用自己的横向缩略图带渲染 imagegen 工具输出;缩略图 src 走本插件
    // 的 /dsh-canvas/image 路由,据此识别并逐张挂按钮。与轮次尾图片输出卡片走
    // 同一 CANVAS_ADD_TOKEN 令牌通道(dispatchAddImage),不自建旁路;插件自有
    // 表面(类名 dsh-canvas- 前缀)不重复装饰。
    (function () {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
      const ROUTE_MARK = '/dsh-canvas/image?path=';
      const inPluginSurface = (node) => {
        for (let el = node; el && el !== document.body; el = el.parentElement) {
          const raw = el.className;
          const cls = String(raw && raw.baseVal !== undefined ? raw.baseVal : raw || '');
          if (cls.indexOf('dsh-canvas') >= 0) return true;
        }
        return false;
      };
      const pathOf = (img) => {
        try {
          const src = String(img.getAttribute('src') || '');
          const idx = src.indexOf(ROUTE_MARK);
          if (idx < 0) return '';
          return decodeURIComponent(src.slice(idx + ROUTE_MARK.length).split('&', 1)[0] || '');
        } catch (err) { return ''; }
      };
      const decorate = (img) => {
        if (!img || img.dataset.dshCanvasNativeBtn) return;
        const path = pathOf(img);
        if (!path || inPluginSurface(img)) return;
        img.dataset.dshCanvasNativeBtn = '1';
        const host = img.closest('a, figure, div') || img.parentElement;
        if (!host || host.dataset.dshCanvasNativeHost) return;
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
          try { dispatchAddImage(path, '/dsh-canvas/image?path=' + encodeURIComponent(path)); } catch (err) {}
        });
        host.appendChild(btn);
      };
      let sweepScheduled = false;
      const sweep = () => {
        sweepScheduled = false;
        try { document.querySelectorAll('img[src*="' + ROUTE_MARK + '"]').forEach(decorate); } catch (err) {}
      };
      const scheduleSweep = () => {
        if (sweepScheduled) return;
        sweepScheduled = true;
        window.setTimeout(sweep, 120);
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
