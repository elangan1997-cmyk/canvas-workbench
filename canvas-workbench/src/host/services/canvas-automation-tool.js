import { defineTool } from '@deepseek-ai/dsh-tools';

export const AUTOMATION_TOOL_NAME = 'canvas_workbench';
export const AUTOMATION_TOOL_DESCRIPTION = '操作画布工作台及后台批处理的正式入口。可读取当前画布/选中图片、按对象ID调整位置尺寸，或指定本地文件夹/文件清单批量抠图、拆层导出可编辑PSD/AI/SVG、普通PSD转换、局部图像编辑；无需打开画布即可后台执行，完成后自动建立项目并展示结果。先用inspect读取用户所指对象或plan检查文件清单；submit立即返回任务ID，随后status查进度，cancel停止，resume只继续未完成项，open展示项目。layered_export是真实拆层且默认校准可编辑文字，flat_psd仅把原图封装为单图层PSD，不能冒充拆层。抠图/普通转换不调用生图。需生成时明确设置allow_generation和max_image_requests；不得在结果未知时自动开启retry_unknown。原图始终保留，失败不能报告成功。文字分析自动使用当前聊天模型，生图跟随工作台图像引擎。所有路径使用绝对路径；region为所选图片的原图像素选区，区外像素锁定。不要为这些操作编写临时脚本或绕过工作台改canvas.json。';

export function automationToolSpec(service, getContext) {
  const box = { type: 'object', additionalProperties: false, properties: {
    x: { type: 'number', required: true }, y: { type: 'number', required: true }, width: { type: 'number', required: true }, height: { type: 'number', required: true }
  } };
  return {
    name: AUTOMATION_TOOL_NAME, description: AUTOMATION_TOOL_DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, enum: ['capabilities', 'inspect', 'plan', 'submit', 'status', 'list', 'cancel', 'resume', 'open', 'review', 'arrange'] },
      operation: { type: 'string', enum: ['layered_export', 'flat_psd', 'remove_background', 'edit_image'] },
      folder: { type: 'string', description: '输入图片文件夹，默认只处理该层；与paths二选一' },
      paths: { type: 'array', items: { type: 'string' }, description: '指定图片绝对路径清单；未提供文件夹或路径时使用当前画布选中图片' },
      element_ids: { type: 'array', items: { type: 'string' }, description: 'inspect返回的画布对象ID，精确指定操作对象' },
      selected_only: { type: 'boolean', description: '默认true；false处理当前画布全部图片' },
      source_project: { type: 'string', description: '可选源画布项目绝对路径，默认当前项目' },
      output_parent: { type: 'string', description: '仅用户明确指定输出位置时填写；省略则跟随当前聊天工作目录，禁止沿用先前测试/结果项目的路径' },
      output_project: { type: 'string', description: '可选已有输出画布项目；默认自动创建独立项目' },
      project_name: { type: 'string' }, recursive: { type: 'boolean' }, max_files: { type: 'integer', description: '默认100，最高500；超出时拒绝静默截断' },
      formats: { type: 'array', items: { type: 'string', enum: ['psd', 'ai', 'svg'] } },
      editable_text: { type: 'boolean', description: '拆层时默认true，识别普通文字为可编辑文字层' },
      font_policy: { type: 'string', enum: ['substitute', 'strict'], description: '默认substitute，使用已安装的近似字体并记录差异；strict低置信时自动保留原字形区域' },
      prompt: { type: 'string' }, region: box,
      allow_generation: { type: 'boolean', description: '是否允许当前工作台图像引擎重建素材；默认false' },
      max_image_requests: { type: 'integer', description: '本批任务累计的图像请求硬上限，默认0；恢复任务时可提高，未知请求也计入' },
      retry_unknown: { type: 'boolean', description: '仅在核对上次未知请求后才设为true，可能重复消耗额度' },
      open_canvas: { type: 'boolean', description: '完成后自动展示结果项目，默认true；false仅后台生成' },
      job_id: { type: 'string' }, wait_ms: { type: 'integer', description: 'status可等待0至10000毫秒，减少频繁查询' },
      item_id: { type: 'string', description: 'review时指定查看的文件；resume且reprocess=true时指定重做的文件编号，省略则重做整批' },
      reprocess: { type: 'boolean', description: 'resume时显式重做已完成项，保留历史和累计请求额度，更新原画布结果；默认false，仅继续未完成项' },
      request_id: { type: 'string', description: '提交幂等编号；请求响应未知时使用相同编号重试可取回原任务，不会重复处理' },
      base_revision: { type: 'number', description: 'arrange需提交inspect所返回的revision，防止覆盖较新的画布操作' },
      patches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, angle: { type: 'number' }, opacity: { type: 'number' }
      } } }
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true }, action: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const sid = String(exec.agent?.session?.id || ''), current = getContext(sid) || {};
      const body = { sessionId: sid, cwd: current.cwd || exec.agent?.session?.header?.cwd || '',
        operation: args.operation, folder: args.folder, paths: args.paths, elementIds: args.element_ids, selectedOnly: args.selected_only,
        sourceProject: args.source_project, project: args.source_project || current.project, outputParent: args.output_parent, outputProject: args.output_project,
        projectName: args.project_name, recursive: args.recursive, maxFiles: args.max_files, formats: args.formats, editableText: args.editable_text,
        fontPolicy: args.font_policy, prompt: args.prompt, region: args.region, allowGeneration: args.allow_generation, maxImageRequests: args.max_image_requests,
        retryUnknown: args.retry_unknown, openCanvas: args.open_canvas, id: args.job_id, itemId: args.item_id, reprocess: args.reprocess, requestId: args.request_id, patches: args.patches, baseRevision: args.base_revision };
      let value;
      if (args.action === 'capabilities') value = { operations: ['layered_export', 'flat_psd', 'remove_background', 'edit_image'], limits: { maxFiles: 500, imageBytes: 32 * 1024 * 1024 },
        currentProject: current.project || '', currentWorkspace: current.cwd || '', defaultOutputParent: current.cwd || '', currentModel: current.modelSelection || null, background: true, restartRecovery: true, originalsPreserved: true };
      else if (args.action === 'status') {
        const ms = Number(args.wait_ms || 0); if (!Number.isInteger(ms) || ms < 0 || ms > 10000) throw new Error('wait_ms应为0至10000');
        if (ms) await new Promise((resolve, reject) => { const t = setTimeout(() => { exec.signal.removeEventListener('abort', abort); resolve(); }, ms); const abort = () => { clearTimeout(t); reject(exec.signal.reason || new Error('查询已停止')); }; exec.signal.addEventListener('abort', abort, { once: true }); });
        value = await service.get(body);
      } else {
        const method = { inspect: 'inspect', plan: 'plan', submit: 'submit', list: 'list', cancel: 'cancel', resume: 'resume', open: 'open', review: 'review', arrange: 'arrange' }[args.action];
        if (!method) throw new Error('未知画布操作');
        value = await service[method](body);
      }
      // The host's lossless-JSON contract forbids undefined object members.
      // Queue timestamps are optional until the worker reaches that stage.
      return JSON.parse(JSON.stringify({ ok: true, action: args.action, ...(Array.isArray(value) ? { jobs: value } : value) }));
    },
    presentCall: args => ({ card: 'generic', title: args.action === 'submit' ? '后台处理图片' : '画布工作台 · ' + args.action, kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '工作台操作未完成' : '工作台操作已受理', content: result.content })
  };
}

export function installCanvasAutomationTool(ctx, service, getContext) {
  if (!ctx.tools?.register || ctx.tools.get?.(AUTOMATION_TOOL_NAME)) return false;
  const tool = defineTool(automationToolSpec(service, getContext));
  ctx.effect(() => ctx.tools.register(tool), 'canvas-workbench: automation tool');
  return true;
}
