    const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#].*)?$/i;
    const IMAGE_MIME_RE = /^image\/(?:png|jpe?g|jpeg|webp|gif|avif|bmp|svg\+xml)(?:[;]|$)/i;
    function isDirectImageSource(value) {
      return typeof value === 'string' && /^(?:data:image\/|https?:\/\/|blob:)/i.test(value.trim());
    }
    function compactBase64(value) {
      return String(value || '').replace(/[\r\n\t\s]+/g, '');
    }
    function looksLikeBase64(value) {
      const compact = compactBase64(value);
      return compact.length >= 256 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
    }
    function pushImageCandidate(value, out, cwdOverride) {
      if (value == null) return;
      if (typeof value !== 'string') {
        if (typeof value === 'object') walkImagePayload(value, out, 0, cwdOverride);
        return;
      }
      const candidate = value.trim();
      if (!candidate) return;
      if (isDirectImageSource(candidate)) { out.push(candidate); return; }
      // Codex image_generation_call.result 常直接返回无 MIME 的 Base64；补成可直接预览的 PNG data URL。
      if (looksLikeBase64(candidate)) { out.push('data:image/png;base64,' + compactBase64(candidate)); return; }
      pushIfImage(candidate, out, cwdOverride);
    }
    function pushIfImage(p, out, cwdOverride) {
      if (!p || typeof p !== 'string') return;
      const candidate = p.trim();
      if (isDirectImageSource(candidate)) { out.push(candidate); return; }
      // 部分模型把本地沙箱文件写成 sandbox:/...，转换为当前主机可读的绝对路径。
      if (/^sandbox:(?:\/\/)?/i.test(candidate)) {
        const sandboxPath = candidate.replace(/^sandbox:(?:\/\/)?/i, '');
        pushIfImage(sandboxPath.charAt(0) === '/' ? sandboxPath : '/' + sandboxPath, out, cwdOverride);
        return;
      }
      if (/^file:\/\//i.test(candidate)) {
        const resolvedFile = resolveImagePath(candidate, cwdOverride);
        if (resolvedFile) out.push(resolvedFile);
        return;
      }
      // 远程图片只在明显带图片扩展名时接受，避免把普通网页链接当成图片输出。
      if (/^https?:\/\//i.test(candidate)) {
        if (IMAGE_EXT_RE.test(candidate)) out.push(candidate);
        return;
      }
      // Shell 回复常用 `*.png` 表示一批产物。通配符不是可读文件，
      // 若将它当成“最终图片”，会覆盖工具结果里已经可显示的真实附件。
      if (/[*\[\]{}]/.test(candidate.split(/[?#]/, 1)[0])) return;
      if (!IMAGE_EXT_RE.test(candidate)) return;
      const resolved = resolveImagePath(candidate, cwdOverride);
      if (resolved) out.push(resolved);
    }
    function collectImagePaths(text, out, cwdOverride) {
      if (!text) return;
      const source = String(text);
      let m;
      // 某些模型返回 JSON/结构化文本，先尝试解析完整 JSON，兼容 image_url、result 等字段。
      try {
        const trimmed = source.trim();
        if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') walkImagePayload(JSON.parse(trimmed), out, 0, cwdOverride);
      } catch (e) {}
      // 画布 imagegen 路由的归档路径写在 <output_path> 标签里；不提取它，
      // 附件就找不到同名源文件，新旧判定（mtime 过滤）会失效。
      const outputPathRe = /<output_path[^>]*>([^<]+)<\/output_path>/gi;
      while ((m = outputPathRe.exec(source))) pushIfImage(m[1].trim(), out, cwdOverride);
      const jsonRe = /"(?:image|image_url|imageUrl|file|file_path|filePath|path|url|result|b64_json|base64)"\s*:\s*(?:"([^"]+)"|\{[^}]*\})/gi;
      while ((m = jsonRe.exec(source))) pushImageCandidate(m[1], out, cwdOverride);
      const codePathRe = /`([^`\r\n]+\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^`\r\n]*)?)`/gi;
      while ((m = codePathRe.exec(source))) pushIfImage(m[1], out, cwdOverride);
      const plainText = source.replace(/`[^`\r\n]*`/g, ' ');
      // Markdown 图片路径经常是 macOS 绝对路径，中间包含空格。
      // 旧正则用 `[^)\s]+` 会在第一个空格处截断，导致消息最终只剩 alt 文字。
      // 同时支持 CommonMark 推荐的 `<...>` 包裹路径。
      const mdRe = /!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^)\r\n]+?))\s*\)/g;
      while ((m = mdRe.exec(plainText))) {
        const markdownTarget = String(m[1] || m[2] || '').trim();
        if (!markdownTarget) continue;
        // 原生 DSH 图片组件允许没有扩展名的 http(s) 签名 URL。
        if (isDirectImageSource(markdownTarget)) out.push(markdownTarget);
        else pushIfImage(markdownTarget, out, cwdOverride);
      }
      // read_image 等工具会以 <path>/tmp/a.png</path> 返回，允许 XML 标签后的路径。
      const tagPathRe = /<(?:path|file|image-path|output)\s*>\s*([^<\r\n]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^<\r\n]*)?)\s*<\//gi;
      while ((m = tagPathRe.exec(source))) pushIfImage(m[1], out, cwdOverride);
      const absRe = /(?:^|[\s"'`=(\[>])((?:\/|~\/)[^\s"'`<>()\[\]]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^\s"'`<>()\[\]]*)?)(?=[\s"'`=)\],.;:]|$)/gi;
      while ((m = absRe.exec(plainText))) pushIfImage(m[1], out, cwdOverride);
      const relativeRe = /(?:^|[\s"'`=(\[>])((?![a-z][a-z0-9+.-]*:\/\/)(?:\.?\.?\/)?[^\s"'`<>()\[\]]*\/[^\s"'`<>()\[\]]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^\s"'`<>()\[\]]*)?)(?=[\s"'`=)\],.;:，。]|$)/gi;
      while ((m = relativeRe.exec(plainText))) pushIfImage(m[1], out, cwdOverride);
      const bareFileRe = /(?:^|[\s"'`=(\[>：])([^\s\/"'`<>()\[\]：]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^\s"'`<>()\[\]]*)?)(?=[\s"'`=)\],.;:，。<]|$)/gi;
      while ((m = bareFileRe.exec(plainText))) pushIfImage(m[1], out, cwdOverride);
      // 修复旧正则没有捕获组导致 m[1] 为 undefined；同时支持 avif/bmp 与换行空白。
      const dataRe = /data:image\/(?:png|jpe?g|webp|gif|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+/gi;
      while ((m = dataRe.exec(plainText))) out.push(m[0].replace(/\s+/g, ''));
    }
    function walkImagePayload(value, out, depth, cwdOverride) {
      if (value == null || depth > 7) return;
      if (typeof value === 'string') { pushImageCandidate(value, out, cwdOverride); return; }
      if (Array.isArray(value)) {
        for (const item of value) walkImagePayload(item, out, depth + 1, cwdOverride);
        return;
      }
      if (typeof value !== 'object') return;
      if (value.attachmentId) {
        const marker = attachmentMarker(value);
        if (marker) out.push(marker);
        return;
      }
      const type = String(value.type || '').toLowerCase();
      for (const key of Object.keys(value)) {
        const child = value[key];
        const k = String(key).toLowerCase();
        if (k === 'text' && typeof child === 'string') {
          // 工具结果通常把图片路径放在 content[] -> text 中，不能只看第一层 block.text。
          collectImagePaths(child, out, cwdOverride);
          continue;
        }
        if ((k === 'attachment' || k === 'ref') && child && typeof child === 'object' && child.attachmentId) {
          const marker = attachmentMarker(child);
          if (marker) out.push(marker);
          continue;
        }
        const imageKey = k === 'image' || k === 'image_url' || k === 'imageurl' || k === 'file' || k === 'file_path' || k === 'filepath' || k === 'path' || k === 'url' || k === 'result' || k === 'partial_image_b64' || k === 'b64_json' || k === 'base64' || k === 'data_url' || /image|attachment|asset/.test(k);
        const containerKey = k === 'content' || k === 'message' || k === 'output' || k === 'response' || k === 'data' || k === 'body' || k === 'choices' || k === 'delta' || k === 'chunk' || k === 'block' || k === 'blocks' || k === 'tool' || k === 'tool_result' || k === 'items' || k === 'source' || k === 'meta';
        if (imageKey || containerKey || type.indexOf('image') >= 0 || type.indexOf('attachment') >= 0) {
          if (typeof child === 'string') pushImageCandidate(child, out, cwdOverride);
          else walkImagePayload(child, out, depth + 1, cwdOverride);
        }
      }
    }
    function dedupeImagePaths(paths) {
      const unique = [...new Set(paths)];
      const result = [];
      const byName = new Map();
      for (const path of unique) {
        const ref = attachmentFromPath(path);
        const direct = isDirectImageSource(path);
        if (ref || direct) {
          result.push(path);
          continue;
        }
        const name = imageName(path).toLowerCase();
        const previous = byName.get(name);
        if (!previous) {
          byName.set(name, path);
          result.push(path);
          continue;
        }
        // Markdown 常同时包含绝对图片链接和旁边的相对文件名；优先绝对路径，避免同图显示两次。
        const previousAbsolute = /^(?:\/|~\/)/.test(previous);
        const currentAbsolute = /^(?:\/|~\/)/.test(path);
        if (currentAbsolute && !previousAbsolute) {
          const index = result.indexOf(previous);
          if (index >= 0) result[index] = path;
          byName.set(name, path);
        }
      }
      return result;
    }
    function eventCwd(event) {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return activeChatCwd;
      const candidates = [
        data.cwd,
        data.session && data.session.cwd,
        data.conversation && data.conversation.cwd,
        data.message && data.message.cwd,
        data.step && data.step.cwd,
        data.context && data.context.cwd
      ];
      return candidates.find((value) => typeof value === 'string' && value.trim()) || activeChatCwd;
    }
    function extractImagePaths(event) {
      const out = [];
      const data = event && event.data;
      if (!data) return [];
      // 兼容旧版 message.content.text，以及切换模型后常见的结构化 image_url / image_generation_call.result。
      const cwd = eventCwd(event);
      walkImagePayload(data, out, 0, cwd);
      const blocks = data.message && data.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block && typeof block.text === 'string') collectImagePaths(block.text, out, cwd);
        }
      }
      const unique = dedupeImagePaths(out);
      // 同一个工具结果可能同时返回路径和持久化附件。附件是会话授权的稳定字节，
      // 当两者同名时优先附件，避免临时路径失效后出现“图片加载失败”。
      const attachmentNames = new Set(unique
        .filter((path) => !!attachmentFromPath(path))
        .map((path) => imageName(path).toLowerCase()));
      // 返回条目而非裸路径：附件条目携带被去掉的同名文件路径（sourcePath），
      // 图片输出卡片靠它对源文件做 mtime 判定——本轮 read_image 的旧图附件
      // 才能被识别为“旧图引用”并从本轮卡片中过滤掉。
      return unique
        .filter((path) => {
          const ref = attachmentFromPath(path);
          return !!ref || !attachmentNames.has(imageName(path).toLowerCase());
        })
        .map((path) => {
          const ref = attachmentFromPath(path);
          if (!ref) return { path, sourcePath: '' };
          const wantedName = imageName(path).toLowerCase();
          const sourcePath = unique.find((p) => p !== path && !attachmentFromPath(p) && imageName(p).toLowerCase() === wantedName) || '';
          return { path, sourcePath };
        });
    }

    // “图片输出”不是通用的图片扫描器。新版 DSH 会把模型读过的参考图、
    // 裁剪检查图和工具中间附件都放进同一个 turn；只有 canvas imagegen
    // 路由明确标为 final 的产物才属于这里。
    function extractGeneratedImagePaths(event) {
      const data = event && event.data;
      if (!data) return [];
      let serialized = '';
      try { serialized = JSON.stringify(data); } catch (error) { return []; }
      if (serialized.indexOf('<canvas_image_output producer=\\"imagegen\\">final</canvas_image_output>') < 0
        && serialized.indexOf('<canvas_image_output producer="imagegen">final</canvas_image_output>') < 0) return [];
      return extractImagePaths(event).map((item) => ({ ...item, producer: 'imagegen' }));
    }

    // 最终助手回复里的图片名用来做“名字校准”（裸名映射回工具结果里的稳定
    // 附件引用），不再用来整体取舍。中间 tool/result 里的扫描/预览参考图
    // 由图片输出卡片的文件修改时间过滤负责隐藏。
    // 这里只读取可见 text block，不读取 reasoning、tool-call 参数。
    function extractAssistantVisibleImages(event) {
      const out = [];
      const data = event && event.data;
      if (!data) return out;
      const cwd = eventCwd(event);
      if (event.type === 'assistant/message') {
        const blocks = data.message && data.message.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (!block || typeof block.text !== 'string') continue;
            const type = String(block.type || '').toLowerCase();
            if (type === 'text' || type === 'output_text' || type === 'markdown') {
              collectImagePaths(block.text, out, cwd);
            }
          }
        } else if (typeof blocks === 'string') {
          collectImagePaths(blocks, out, cwd);
        }
      } else if (event.type === 'assistant/chunk') {
        const chunk = data.chunk;
        const block = chunk && chunk.block;
        const type = block && String(block.type || '').toLowerCase();
        if (chunk && chunk.type === 'block-end' && block && typeof block.text === 'string' && (type === 'text' || type === 'output_text' || type === 'markdown')) {
          collectImagePaths(block.text, out, cwd);
        }
      }
      return dedupeImagePaths(out);
    }

    function reconcileFinalImages(existingImages, visiblePaths, seq, startTime) {
      const existing = Array.isArray(existingImages) ? existingImages : [];
      // 归档撞名时画布路由会自动加 “-2/-3” 去重后缀，而模型最终回复常写原始
      // 文件名。按名字匹配时把后缀剥掉再比，否则裸名匹配不到真实附件，会退化
      // 成不存在的归档路径被逐个隐藏，最终回复整轮没有图片输出卡片。
      const baseKeyOf = (name) => String(name).toLowerCase().replace(/-\d+(\.[a-z0-9]+)$/i, '$1');
      return visiblePaths.map((path) => {
        const wantedName = imageName(path).toLowerCase();
        const wantedBase = baseKeyOf(wantedName);
        const exact = existing.filter((item) => imageName(item.path).toLowerCase() === wantedName);
        const byBase = existing.filter((item) => {
          const name = imageName(item.path).toLowerCase();
          return name !== wantedName && baseKeyOf(name) === wantedBase;
        });
        // 最终回复经常只写“xxx.png”，而工具结果已经提供了可持久
        // 解析的 attachmentId 或绝对路径。最终文字只用来筛选同名产物，
        // 不能把真实引用降级成相对于聊天 cwd 的不存在路径。
        const sameName = exact.concat(byBase);
        const stable = sameName.find((item) => attachmentFromPath(item.path))
          || sameName.find((item) => isDirectImageSource(item.path) || isLocalAbsolutePath(item.path));
        return stable || { path, seq, startTime: startTime || 0, sourcePath: '' };
      });
    }
