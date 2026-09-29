// Excalidraw (MIT, 完全开源商用) 版 iframe：替代 tldraw，保留相同 postMessage 协议。
// 从 CDN 加载 React + Excalidraw UMD；离线/内网环境可能加载失败。
const EXCALIDRAW_SRCDOC = `<!doctype html><html><head><meta charset="utf-8"><style>
    .dsh-name-layer{position:absolute;inset:0;z-index:55;pointer-events:none;overflow:hidden}.dsh-pending{position:absolute;box-sizing:border-box;overflow:hidden;pointer-events:none;border-radius:4%/3%;background:var(--dsh-surface,rgba(248,250,252,.97));color:var(--dsh-fg,#1f2937);font-family:system-ui,-apple-system,'PingFang SC','Alibaba PuHuiTi 3.0',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.45em;box-shadow:inset 0 0 0 2px rgba(59,130,246,.5)}.dsh-pending::before{content:'';position:absolute;left:0;right:0;top:-48px;bottom:0;background:repeating-linear-gradient(135deg,rgba(127,127,127,.07) 0 10px,transparent 10px 24px);animation:dshStripes 1.4s linear infinite}.dsh-pending>*{position:relative}.dsh-pending-ring{width:2.6em;height:2.6em;border-radius:50%;border:.32em solid rgba(127,127,127,.28);border-top-color:#3b82f6;animation:dshSpin .85s linear infinite}.dsh-pending-title{font-weight:700;font-size:1.05em;letter-spacing:.02em}.dsh-pending-sub{font-size:.68em;color:var(--dsh-fg-muted,#6b7280);max-width:88%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-pending-time{font-size:.7em;color:var(--dsh-fg-muted,#9ca3af);font-variant-numeric:tabular-nums}.dsh-pending-percent{font-size:1.3em;font-weight:700;color:#2563eb;font-variant-numeric:tabular-nums}.dsh-pending-bar{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(127,127,127,.14);overflow:hidden}.dsh-pending-bar>i{position:absolute;top:0;bottom:0;left:0;width:35%;background:linear-gradient(90deg,transparent,#3b82f6,transparent);animation:dshSweep 1.3s ease-in-out infinite}.dsh-pending-bar>b{position:absolute;top:0;bottom:0;left:0;background:#3b82f6;transition:width .4s ease}@keyframes dshSpin{to{transform:rotate(360deg)}}@keyframes dshStripes{to{transform:translateY(34px)}}@keyframes dshSweep{0%{left:-35%}100%{left:100%}}.dsh-image-name-plain{position:absolute;box-sizing:border-box;user-select:none}
    .dsh-image-name{position:absolute;box-sizing:border-box;min-width:64px;max-width:260px;height:22px;padding:3px 8px;border:1px solid rgba(148,163,184,.48);border-radius:6px;background:rgba(255,255,255,.94);box-shadow:0 2px 8px rgba(15,23,42,.12);color:#334155;font:500 11px/14px ui-rounded,"SF Pro Rounded",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;cursor:text;user-select:none;transform:translateY(-26px)}
    .dsh-image-name:hover{border-color:#60a5fa;background:#fff;color:#1d4ed8}
    .dsh-image-name-input{position:absolute;box-sizing:border-box;height:24px;padding:3px 7px;border:1px solid #3b82f6;border-radius:6px;background:#fff;box-shadow:0 0 0 3px rgba(59,130,246,.18);color:#1e293b;font:500 11px/16px ui-rounded,"SF Pro Rounded",sans-serif;outline:none;pointer-events:auto;transform:translateY(-27px)}
    .dsh-selection-toolbar{position:absolute;z-index:80;display:flex;align-items:center;gap:4px;box-sizing:border-box;padding:5px;border:1px solid var(--dsh-line,rgba(255,255,255,.14));border-radius:11px;background:var(--dsh-surface,rgba(15,18,24,.96));box-shadow:0 12px 30px rgba(15,23,42,.28),0 2px 8px rgba(15,23,42,.22);color:var(--dsh-fg,#f8fafc);pointer-events:auto;transform:translate(-50%,-100%);white-space:nowrap;backdrop-filter:blur(14px);animation:dsh-toolbar-in .13s ease-out}
    .dsh-selection-toolbar:after{content:"";position:absolute;left:50%;bottom:-5px;width:9px;height:9px;background:var(--dsh-surface,rgba(15,18,24,.96));border-right:1px solid var(--dsh-line,rgba(255,255,255,.12));border-bottom:1px solid var(--dsh-line,rgba(255,255,255,.12));transform:translateX(-50%) rotate(45deg)}
    .dsh-selection-count{position:relative;z-index:1;padding:0 7px;color:var(--dsh-fg-muted,#94a3b8);font:600 11px/28px ui-rounded,"SF Pro Rounded",sans-serif}
    .dsh-selection-divider{position:relative;z-index:1;width:1px;height:20px;margin:0 2px;background:var(--dsh-line,rgba(255,255,255,.14))}
    /* 选区工具条：更多下拉菜单 */
.dsh-selection-more{position:relative;display:flex}
.dsh-selection-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:136px;display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid var(--dsh-line,rgba(255,255,255,.14));border-radius:10px;background:var(--dsh-surface,rgba(15,18,24,.97));box-shadow:0 14px 34px rgba(15,23,42,.4);z-index:90}
    .dsh-selection-menu .dsh-selection-action{white-space:nowrap;width:100%;text-align:left}
    .dsh-selection-menu .dsh-selection-action:hover{background:var(--dsh-hover,rgba(255,255,255,.08))}
    /* 画布图片颜色标记：更多菜单内的七色调色板与画布角标圆点 */
.dsh-tag-palette{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.09);margin-bottom:3px;white-space:nowrap;flex-wrap:nowrap}
.dsh-tag-palette>span{flex:none}
.dsh-tag-palette .dsh-selection-action{width:auto;min-width:0;flex:none}
.dsh-tag-dot-btn{width:19px;height:19px;flex:none;padding:0;border:2px solid rgba(255,255,255,.34);border-radius:50%;cursor:pointer;transition:transform .12s ease}
.dsh-tag-dot-btn:hover{transform:scale(1.18)}
.dsh-image-tag-dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;border:1.5px solid rgba(255,255,255,.65);vertical-align:baseline;flex:none}
.dsh-image-tag-corner{position:absolute;z-index:70;width:13px;height:13px;border:2px solid rgba(255,255,255,.7);border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none}
.dsh-selection-action{position:relative;z-index:1;height:30px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsh-fg,#e2e8f0);font:600 12px/30px ui-rounded,"SF Pro Rounded",sans-serif;cursor:pointer;transition:background .12s ease,color .12s ease,transform .12s ease}
    .dsh-selection-action:hover{background:var(--dsh-hover,rgba(255,255,255,.1));color:var(--dsh-fg,#fff)}
    .dsh-selection-action:active{transform:translateY(1px)}
    .dsh-selection-action.dsh-material-drag-action{cursor:grab}.dsh-selection-action.dsh-material-drag-action:active{cursor:grabbing}
    .dsh-selection-action.dsh-primary{background:#2563eb;color:#fff}.dsh-selection-action.dsh-primary:hover{background:#3b82f6}
    .dsh-selection-action.dsh-photoshop{background:#001e36;color:#31a8ff}.dsh-selection-action.dsh-photoshop:hover{background:#0b2b46;color:#8dceff}
    .dsh-selection-action.dsh-illustrator{background:#3b1b08;color:#ff9a3d}.dsh-selection-action.dsh-illustrator:hover{background:#5a2608;color:#ffc078}
    /* Adobe 桥接「返回」：放入发件箱，由 PS/AI 里的 DSH画布桥接 面板置入（adobe-bridge/PROTOCOL.md） */
    .dsh-selection-action.dsh-bridge-ps{background:#001e36;color:#31a8ff;border:1px dashed rgba(49,168,255,.45)}.dsh-selection-action.dsh-bridge-ps:hover{background:#0b2b46;color:#8dceff}
    .dsh-selection-action.dsh-bridge-ai{background:#3b1b08;color:#ff9a3d;border:1px dashed rgba(255,154,61,.45)}.dsh-selection-action.dsh-bridge-ai:hover{background:#5a2608;color:#ffc078}
    .dsh-selection-action.dsh-danger:hover{background:rgba(239,68,68,.18);color:#fecaca}
    @keyframes dsh-toolbar-in{from{opacity:0;transform:translate(-50%,-92%) scale(.97)}to{opacity:1;transform:translate(-50%,-100%) scale(1)}}
    .dsh-image-editor{position:fixed;inset:0;z-index:220;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(5,7,11,.82);backdrop-filter:blur(12px);pointer-events:auto}
    .dsh-image-editor-panel{display:grid;grid-template-rows:auto minmax(180px,1fr) auto;width:min(980px,calc(100vw - 36px));height:min(820px,calc(100vh - 36px));overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:#13161c;box-shadow:0 30px 90px rgba(0,0,0,.48);color:#f8fafc;font-family:ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif}
    .dsh-image-editor-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.09);background:#181c23}
    .dsh-image-editor-title{font-size:14px;font-weight:750}.dsh-image-editor-sub{flex:1;min-width:0;color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dsh-image-editor-tool{height:30px;padding:0 10px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:#252a33;color:#e2e8f0;font:600 12px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-image-editor-tool:hover{background:#313743}.dsh-image-editor-tool:disabled{opacity:.4;cursor:not-allowed}
    .dsh-image-editor-close{width:30px;padding:0;font-size:16px}
    .dsh-image-editor-stage{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;padding:16px;overflow:hidden;background-color:#0c0f14;background-image:linear-gradient(45deg,#151922 25%,transparent 25%),linear-gradient(-45deg,#151922 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#151922 75%),linear-gradient(-45deg,transparent 75%,#151922 75%);background-size:22px 22px;background-position:0 0,0 11px,11px -11px,-11px 0;touch-action:none;cursor:default}
    .dsh-image-editor-media{position:relative;display:inline-flex;max-width:100%;max-height:100%;line-height:0;box-shadow:0 10px 36px rgba(0,0,0,.38);transform-origin:center center;will-change:transform;touch-action:none}
    .dsh-image-editor-image{display:block;max-width:100%;max-height:calc(100vh - 260px);object-fit:contain;user-select:none;-webkit-user-drag:none}
    .dsh-image-editor-mask{position:absolute;inset:0;width:100%;height:100%;opacity:.52;cursor:none;touch-action:none}
    .dsh-image-editor-mask.dsh-select-cursor{cursor:crosshair}
    .dsh-mask-cursor{position:absolute;z-index:3;border:1.5px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.78),0 0 12px rgba(0,0,0,.35);transform:translate(-50%,-50%);pointer-events:none;mix-blend-mode:difference}
    .dsh-mask-tools{display:flex;align-items:center;gap:3px;padding:3px;border:1px solid rgba(255,255,255,.11);border-radius:10px;background:#10141a}
    .dsh-mask-tool{height:26px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:#94a3b8;font:650 11px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-mask-tool:hover{color:#fff;background:#252b35}.dsh-mask-tool.is-active{background:#f43f5e;color:#fff;box-shadow:0 2px 10px rgba(244,63,94,.24)}
    .dsh-image-editor-foot{display:grid;grid-template-columns:1fr auto;gap:10px;padding:12px 14px;border-top:1px solid rgba(255,255,255,.09);background:#181c23}
    .dsh-image-editor-input{box-sizing:border-box;width:100%;min-height:76px;max-height:150px;resize:vertical;padding:11px 13px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:#0f1217;color:#f8fafc;font:500 13px/1.5 ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;outline:none}.dsh-image-editor-input:focus{border-color:#4f8cff;box-shadow:0 0 0 3px rgba(79,140,255,.16)}
    .dsh-image-editor-send{align-self:stretch;min-width:126px;border:0;border-radius:11px;background:#2563eb;color:#fff;font:750 13px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-image-editor-send:hover{background:#3b82f6}.dsh-image-editor-send:disabled{background:#374151;color:#94a3b8;cursor:wait}
    .dsh-image-editor-note{grid-column:1/-1;color:#94a3b8;font-size:11px}.dsh-image-editor-note.dsh-error{color:#fca5a5}
    .dsh-brush-label{display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:11px}.dsh-brush-label input{width:92px;accent-color:#fb4165}
    .dsh-image-editor-zoom{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid rgba(255,255,255,.11);border-radius:9px;background:#10141a}
    .dsh-image-editor-zoom button{height:26px;min-width:28px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:#cbd5e1;font:650 11px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-image-editor-zoom button:hover{background:#252b35;color:#fff}.dsh-image-editor-zoom-value{min-width:42px;color:#f8fafc;font:650 11px/26px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;text-align:center}
    .dsh-image-editor-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,11,16,.68);color:#fff;font-weight:700;letter-spacing:.04em;backdrop-filter:blur(3px)}
    @media(max-width:720px){.dsh-image-editor{padding:8px}.dsh-image-editor-panel{width:calc(100vw - 16px);height:calc(100vh - 16px);border-radius:12px}.dsh-image-editor-foot{grid-template-columns:1fr}.dsh-image-editor-send{min-height:44px}.dsh-image-editor-head{flex-wrap:wrap}.dsh-image-editor-sub{flex-basis:40%}}
    .excalidraw [data-testid="toolbar-image"],#ex-root [data-testid="toolbar-image"],.excalidraw [aria-label="插入图像"],.excalidraw [aria-label="Insert image"],.excalidraw [title^="插入图像"]{display:none!important}
    .excalidraw .dsh-hidden-social-links{display:none!important}
    /* Excalidraw 暗色主题会把画布先反相绘制，再用 invert(.93) 还原。
       .93 会把黑位抬高约 7% 并压缩对比度，导致同一张图比聊天预览发白。
       仅在暗色主题下把还原系数校正为 1，不改图片字节、元素透明度或浅色主题。 */
    .excalidraw.theme--dark canvas.excalidraw__canvas{filter:invert(1) hue-rotate(180deg)!important}
    /* 设置菜单需要位于画布文件名标签和选中工具条之上；打开菜单时暂时收起标签，关闭后自动恢复。 */
    .dsh-excalidraw-menu-open .dsh-name-layer{display:none!important}
    .dsh-tip{display:none!important}

html,body,#ex-root,#ex-root>div,.excalidraw,.excalidraw-container{margin:0;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsh-bg,#f7f8fa)}.dsh-tip{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.65);color:#fff;font-size:12px;padding:6px 12px;border-radius:8px;pointer-events:none;z-index:5;max-width:80%;text-align:center}.dsh-err{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff3f3;border:1px solid #ecc;color:#a22;font-size:13px;padding:16px 20px;border-radius:10px;max-width:80%;white-space:pre-wrap}@media(prefers-color-scheme:dark){html,body,#ex-root,#ex-root>div,.excalidraw,.excalidraw-container{background:var(--dsh-bg,#15171c)}.dsh-err{background:#2a171b;border-color:#7f1d1d;color:#fecaca}}
/* 隐藏 Excalidraw 内置素材库入口（默认侧栏触发按钮），改用插件自有素材库 */
.excalidraw .default-sidebar-trigger{display:none!important}
.excalidraw .layer-ui__wrapper__footer-left .sidebar-trigger{display:none!important}
</style></head><body><div id="ex-root"></div><div class="dsh-tip">拖拽=移动 · 滚轮=缩放 · 图片可移动/缩放</div><script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script><script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js"></script><script>(function(){var lastRuntimeError="";var post=function(m){try{window.parent.postMessage(m,"*")}catch(e){}};window.addEventListener("error",function(ev){lastRuntimeError="画布运行错误: "+String(ev&&ev.message||ev&&ev.error||"未知错误");post({type:"error",message:lastRuntimeError})});window.addEventListener("unhandledrejection",function(ev){lastRuntimeError="画布异步错误: "+String(ev&&ev.reason&&ev.reason.message||"未知错误");post({type:"error",message:lastRuntimeError})});var root=window.ReactDOM.createRoot(document.getElementById("ex-root"));var api=null,ready=false,insertCount=0,insertChain=Promise.resolve(),requestSceneLoad=null,hydrating=false,expectedElements=0;var systemDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var canvasDefaultBackground=systemDark?"#15171c":"#f7f8fa";var empty={viewBackgroundColor:canvasDefaultBackground};var themeMedia=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;var syncSystemTheme=function(ev){var nextDark=!!(ev&&ev.matches);if(nextDark===systemDark)return;var previous=canvasDefaultBackground;systemDark=nextDark;canvasDefaultBackground=systemDark?"#15171c":"#f7f8fa";if(api&&typeof api.getAppState==="function"&&typeof api.updateScene==="function"&&String(api.getAppState().viewBackgroundColor||"")===previous)api.updateScene({appState:Object.assign({},api.getAppState(),{viewBackgroundColor:canvasDefaultBackground}),commitToHistory:false});};if(themeMedia){if(typeof themeMedia.addEventListener==="function")themeMedia.addEventListener("change",syncSystemTheme);else if(typeof themeMedia.addListener==="function")themeMedia.addListener(syncSystemTheme);}function fileObject(fl){var f={};if(fl&&typeof fl.forEach==="function"){fl.forEach(function(v,k){f[k]=v})}else if(fl&&typeof fl==="object"){Object.keys(fl).forEach(function(k){f[k]=fl[k]})}return f}function serialize(el,st,fl){var elements=el||[],used={};elements.forEach(function(item){if(item&&item.type==="image"&&!item.isDeleted&&item.fileId)used[item.fileId]=true;});var f={},src=fileObject(fl);Object.keys(src).forEach(function(k){if(!used[k])return;var v=src[k];if(v&&v.dataURL)f[k]={id:v.id||k,dataURL:v.dataURL,mimeType:v.mimeType,created:v.created||Date.now(),lastRetrieved:v.lastRetrieved};});return {elements:elements,appState:Object.assign({},st||empty),files:f}};function App(){return window.React.createElement(window.ExcalidrawLib.Excalidraw,{excalidrawAPI:function(a){api=a;if(!ready){ready=true;post({type:"ready"})}},initialData:{elements:[],appState:empty,files:{}},onChange:(function(){/* 性能 v2：600ms 防抖 + files 增量——changed 只带 usedFileIds 与新增/变化文件，父层按 previous.files 合并；loaded/snapshot-request 仍发全量 */var t=0,la=null,sent={};function sig(f){return (f&&f.dataURL?f.dataURL.length:0)+':'+String(f&&f.mimeType||'')}function markSent(f){Object.keys(f||{}).forEach(function(k){sent[k]=sig(f[k])})}window.__dshSentFilesReset=function(f){sent={};markSent(f)};window.__dshCancelPendingChanged=function(){if(t){clearTimeout(t);t=0;}la=null};return function(el,st,fl){/* 水合守卫：requestSceneLoad 渐进恢复场景时 onChange 会以"部分场景"触发，若此时发 changed 会把父层完整文件表砍成部分——水合期间一律忽略并取消挂起 */if(hydrating){if(t){clearTimeout(t);t=0;}la=null;return;}la=[el,st,fl];if(!t){t=setTimeout(function(){t=0;var a=la;la=null;if(!a)return;try{var s=serialize(a[0],a[1],api&&api.getFiles?api.getFiles():a[2]);var ids=[],delta={};Object.keys(s.files||{}).forEach(function(k){var v=s.files[k];ids.push(k);if(sent[k]!==sig(v))delta[k]=v});s.usedFileIds=ids;s.files=delta;post({type:"changed",snapshot:s,token:window.__dshSceneToken||""});markSent(delta)}catch(e){}},600)}}})(),viewModeEnabled:false,zenModeEnabled:false,langCode:"zh-CN"})}  var useState=window.React.useState,useEffect=window.React.useEffect;
  var updateImageEditorState=null;
  // 模块级桥接：Main 挂载后回填。add-image 的捕获阶段监听器在 Main 之外，
  // 之前这个变量被 var 声明在 Main 内部，导致外面永远拿到 undefined，
  // 「加入画布后自动打开编辑器」（图层编辑）从来没生效过。
  var openImageEditorById=null;
  var ExcalidrawView=window.ExcalidrawLib.Excalidraw;
  window.ExcalidrawLib.Excalidraw=function(props){var input=props||{},options=input.UIOptions||{},tools=options.tools||{};return window.React.createElement(ExcalidrawView,Object.assign({},input,{UIOptions:Object.assign({},options,{tools:Object.assign({},tools,{image:false})})}));};
  function baseName2(path){var text=String(path||""),at=-1;for(var i=text.length-1;i>=0;i-=1){var code=text.charCodeAt(i);if(code===47||code===92){at=i;break;}}return at<0?text:text.slice(at+1);}
  function pathComparable2(value){var text=String(value||"").split("\\\\").join("/");while(text.indexOf("//")>=0)text=text.split("//").join("/");while(text.length>1&&text.endsWith("/"))text=text.slice(0,-1);return text;}
  function pathWithin2(parent,child){var base=pathComparable2(parent),target=pathComparable2(child);if(!base||!target)return false;var insensitive=/^[A-Za-z]:/.test(base)||/^[A-Za-z]:/.test(target),left=insensitive?base.toLowerCase():base,right=insensitive?target.toLowerCase():target;return right===left||right.indexOf(left+"/")===0;}
  function cleanImageName(value,dataURL,forcedExt){var raw=Array.from(baseName2(value)).map(function(ch){var code=ch.charCodeAt(0);return code<32||[34,42,47,58,60,62,63,92,124].indexOf(code)>=0?"-":ch;}).join("").trim().slice(0,120);var mime=(String(dataURL||"").match(/^data:([^;]+)/i)||[])[1]||"image/png";var fallback=forcedExt||(mime==="image/jpeg"?"jpg":((mime.split("/")[1]||"png").replace("svg+xml","svg")));var dot=raw.lastIndexOf("."),base=(dot>0?raw.slice(0,dot):raw).replace(/[. ]+$/g,"").trim()||"画布图片";return base+"."+fallback;}
  function uniqueImageName(value,dataURL,exceptId,forcedExt){var wanted=cleanImageName(value,dataURL,forcedExt),dot=wanted.lastIndexOf("."),base=dot>0?wanted.slice(0,dot):wanted,ext=dot>0?wanted.slice(dot):"";var used={};(api&&api.getSceneElements?api.getSceneElements():[]).forEach(function(item){if(item&&item.type==="image"&&!item.isDeleted&&item.id!==exceptId){var n=item.customData&&item.customData.dshFileName;if(n)used[String(n).toLowerCase()]=true;}});var out=wanted,index=2;while(used[out.toLowerCase()])out=base+"-"+(index++)+ext;return out;}
  // 元素真正进入场景后再打开编辑器：updateScene 之后 getSceneElements 可能还看不到它，
  // 固定 160ms 定时器不可靠（旧实现就是这么写的，而且因为作用域问题连执行机会都没有）。
  function openEditorWhenReady(id,mode){
    var tries=0;
    var timer=setInterval(function(){
      tries+=1;
      var scene=(api&&typeof api.getSceneElements==="function")?(api.getSceneElements()||[]):[];
      var present=scene.some(function(item){return item&&item.id===id&&!item.isDeleted;});
      if(typeof openImageEditorById==="function"&&present){clearInterval(timer);openImageEditorById(mode,id);return;}
      if(tries>25)clearInterval(timer);
    },120);
  }

function addImageDataURL(dataURL,dm,meta){if(!api)throw new Error("画布尚未就绪");if(typeof api.addFiles!=="function")throw new Error("当前 Excalidraw 不支持 addFiles");var now=Date.now();var token=now.toString(36)+"_"+Math.random().toString(36).slice(2,10);var fileId="f_"+token;var ratio=(dm&&dm.w&&dm.h&&dm.h>0)?dm.w/dm.h:1.6;var maxW=240,maxH=240,w,h;if(ratio>=1){w=maxW;h=Math.max(1,Math.round(maxW/ratio));}else{h=maxH;w=Math.max(1,Math.round(maxH*ratio));}var mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png";var appState=api.getAppState()||empty;var zoom=appState.zoom&&appState.zoom.value?appState.zoom.value:1;var baseX=(-Number(appState.scrollX||0))+80/zoom,baseY=(-Number(appState.scrollY||0))+90/zoom;var total=Number(meta&&meta.batchTotal||1),index=Number(meta&&meta.batchIndex);if(!(index>=0)){index=insertCount++;total=1;}var columns=total>1?Number(meta&&meta.batchColumns||Math.min(5,Math.ceil(Math.sqrt(total*1.35)))):4;var slot=total>1?index:(index%12),col=slot%columns,row=Math.floor(slot/columns);var hasDrop=meta&&Number.isFinite(Number(meta.dropClientX))&&Number.isFinite(Number(meta.dropClientY));var x=hasDrop?((Number(meta.dropClientX)-Number(appState.offsetLeft||0))/zoom-Number(appState.scrollX||0)-w/2):(baseX+col*300+(maxW-w)/2),y=hasDrop?((Number(meta.dropClientY)-Number(appState.offsetTop||0))/zoom-Number(appState.scrollY||0)-h/2):(baseY+row*320);var hasPos=meta&&meta.atX!==undefined&&meta.atY!==undefined&&Number.isFinite(Number(meta.atX))&&Number.isFinite(Number(meta.atY));if(hasPos){x=Number(meta.atX);y=Number(meta.atY);}var sourceExt=meta&&["psd","svg","pdf","ai"].indexOf(meta.kind)>=0?meta.kind:"";var fileName=uniqueImageName(meta&&meta.name,dataURL,null,sourceExt);var el=Object.assign({type:"image",id:"e_"+token,fileId:fileId,x:x,y:y,width:w,height:h,angle:0,strokeColor:"transparent",backgroundColor:"transparent",fillStyle:"solid",strokeWidth:1,strokeStyle:"solid",roughness:0,opacity:100,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),isDeleted:false,groupIds:[],frameId:null,boundElements:null,updated:now,link:null,locked:false,customData:Object.assign({dshFileName:fileName,dshSourcePath:String(meta&&meta.path||""),dshSourceMtime:Number(meta&&meta.mtime||0),dshSourceSize:Number(meta&&meta.size||0),dshSourceKind:String(meta&&meta.kind||"image"),dshManaged:!(meta&&meta.managed===false)},(meta&&meta.customData&&typeof meta.customData==="object")?meta.customData:null),roundness:null,status:"saved",scale:[1,1]});api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);api.updateScene({elements:(api.getSceneElements()||[]).concat([el]),appState:Object.assign({},appState)});if(total>1&&index===total-1)insertCount+=total;post({type:"added",name:fileName});if(meta&&meta.openEditor===true){openEditorWhenReady(el.id,String(meta.editorMode||"edit"));}}

function dims2(d){return new Promise(function(res){var i=new Image();i.onload=function(){res({w:i.naturalWidth,h:i.naturalHeight})};i.onerror=function(){res({w:200,h:130})};i.src=d});}
  function aspectCorrectedSize(item,dm){var actual=dm&&dm.w&&dm.h?dm.w/dm.h:0,current=Number(item&&item.width||1)/Math.max(1,Number(item&&item.height||1));if(!actual||Math.abs(current/actual-1)<.01)return null;var edge=Math.max(1,Number(item.width||240),Number(item.height||240));return actual>=1?{width:edge,height:Math.max(1,Math.round(edge/actual))}:{width:Math.max(1,Math.round(edge*actual)),height:edge};}
  function repairPsdAspectRatios(){if(!api)return Promise.resolve(0);var elements=api.getSceneElements()||[],files=fileObject(api.getFiles?api.getFiles():{}),targets=elements.filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&item.customData&&item.customData.dshSourceKind==="psd"&&files[item.fileId]&&files[item.fileId].dataURL;});return Promise.all(targets.map(function(item){return dims2(files[item.fileId].dataURL).then(function(dm){return {id:item.id,size:aspectCorrectedSize(item,dm)};});})).then(function(results){var fixes=new Map(results.filter(function(result){return result.size;}).map(function(result){return [result.id,result.size];}));if(!fixes.size)return 0;var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){var size=item&&fixes.get(item.id);return size?Object.assign({},item,size,{version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now}):item;});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});post({type:"aspect-ratio-repaired",count:fixes.size});return fixes.size;});}
  function toDataURLBlob(b){return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(b)});}
  function displayImageName(value){var text=String(value||"");return text.replace(/\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai|psd)$/i,"")||text;}
  var pendingProgress={},bumpPending=null;
  function pendingOverlays(elements,appState){var state=appState||empty,zoom=state.zoom&&state.zoom.value?Number(state.zoom.value):1,scrollX=Number(state.scrollX||0),scrollY=Number(state.scrollY||0),offsetLeft=Number(state.offsetLeft||0),offsetTop=Number(state.offsetTop||0);return (elements||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&item.customData&&item.customData.dshEditState==="processing";}).map(function(item){var c=item.customData;return {id:item.id,left:Math.round(((Number(item.x||0)+scrollX)*zoom+offsetLeft)*10)/10,top:Math.round(((Number(item.y||0)+scrollY)*zoom+offsetTop)*10)/10,width:Math.round(Number(item.width||160)*zoom*10)/10,height:Math.round(Number(item.height||160)*zoom*10)/10,title:String(c.dshEditTitle||"图片修改中…"),subtitle:String(c.dshEditSubtitle||""),startedAt:Number(c.dshEditStartedAt||0)};});}
  function imageNameLabels(elements,appState){var state=appState||empty,zoom=state.zoom&&state.zoom.value?Number(state.zoom.value):1,scrollX=Number(state.scrollX||0),scrollY=Number(state.scrollY||0),offsetLeft=Number(state.offsetLeft||0),offsetTop=Number(state.offsetTop||0),labelScale=Math.max(.25,Math.min(1.5,zoom)),selectedIds=state.selectedElementIds||{};return (elements||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted;}).map(function(item){var name=item.customData&&item.customData.dshFileName||(\"画布图片-\"+String(item.id||\"\").slice(-6)+\".png\");return {id:item.id,fileId:item.fileId,name:name,displayName:displayImageName(name),tag:item.customData&&item.customData.dshTagColor||\"\",fmt:docFormatTagOfElement(item),dotSize:Math.max(2,Math.round(8*zoom*10)/10),dotBorder:Math.max(1,Math.round(1.5*zoom*10)/10),cornerSize:Math.max(3,Math.round(13*zoom*10)/10),cornerBorder:Math.max(1,Math.round(2*zoom*10)/10),selected:!!selectedIds[item.id],fontSize:Math.max(6,Math.round(9*labelScale*10)/10),height:Math.max(14,Math.round(16*labelScale)),paddingX:Math.max(3,Math.round(6*labelScale)),offsetY:Math.max(12,Math.round(20*labelScale)),minWidth:Math.max(36,Math.round(64*labelScale)),maxWidth:Math.max(96,Math.round(260*labelScale)),left:Math.round(((Number(item.x||0)+scrollX)*zoom+offsetLeft)*10)/10,top:Math.round(((Number(item.y||0)+scrollY)*zoom+offsetTop)*10)/10,width:Math.round(Math.max(48,Math.min(260*labelScale,Number(item.width||160)*zoom))*10)/10};});}
  function selectionToolbarData(elements,appState){var state=appState||empty,selected=state.selectedElementIds||{},zoom=state.zoom&&state.zoom.value?Number(state.zoom.value):1,scrollX=Number(state.scrollX||0),scrollY=Number(state.scrollY||0),offsetLeft=Number(state.offsetLeft||0),offsetTop=Number(state.offsetTop||0);var images=(elements||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&selected[item.id];});if(!images.length)return null;var boxes=images.map(function(item){var left=(Number(item.x||0)+scrollX)*zoom+offsetLeft,top=(Number(item.y||0)+scrollY)*zoom+offsetTop;return {left:left,top:top,right:left+Number(item.width||0)*zoom};});var minLeft=Math.min.apply(null,boxes.map(function(box){return box.left;})),minTop=Math.min.apply(null,boxes.map(function(box){return box.top;})),maxRight=Math.max.apply(null,boxes.map(function(box){return box.right;})),viewportWidth=Math.max(360,Number(window.innerWidth||960)),center=Math.max(170,Math.min(viewportWidth-170,(minLeft+maxRight)/2));return {ids:images.map(function(item){return item.id;}),count:images.length,left:Math.round(center*10)/10,top:Math.round(Math.max(54,minTop-40)*10)/10,singleName:images.length===1?(images[0].customData&&images[0].customData.dshFileName||("画布图片-"+String(images[0].id||"").slice(-6)+".png")):"",singleKind:images.length===1?(images[0].customData&&images[0].customData.dshSourceKind||""):""};}
  function duplicateSelectedImages(ids){if(!api||!Array.isArray(ids)||!ids.length)return;var selected={};ids.forEach(function(id){selected[id]=true;});var all=api.getSceneElements()||[],files=fileObject(api.getFiles?api.getFiles():{}),now=Date.now(),nextSelected={},copies=[];all.forEach(function(item,index){if(!item||item.type!=="image"||item.isDeleted||!selected[item.id])return;var token=now.toString(36)+"_"+index+"_"+Math.random().toString(36).slice(2,8),nextId="e_copy_"+token,source=files[item.fileId],nextFileId=source?("f_copy_"+token):item.fileId;if(source&&typeof api.addFiles==="function")api.addFiles([{id:nextFileId,dataURL:source.dataURL,mimeType:source.mimeType||"image/png",created:now,lastRetrieved:now}]);copies.push(Object.assign({},item,{id:nextId,fileId:nextFileId,x:Number(item.x||0)+36,y:Number(item.y||0)+36,index:undefined,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},item.customData||{})}));nextSelected[nextId]=true;});if(!copies.length)return;api.updateScene({elements:all.concat(copies),appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:nextSelected}),commitToHistory:true});post({type:"duplicated",count:copies.length});}
  function deleteSelectedImages(ids){if(!api||!Array.isArray(ids)||!ids.length)return;var selected={};ids.forEach(function(id){selected[id]=true;});var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){if(!item||!selected[item.id])return item;return Object.assign({},item,{isDeleted:true,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:{}}),commitToHistory:true});post({type:"deleted-selection",count:ids.length,snapshot:serialize(updated,api.getAppState()||empty,api.getFiles()||{})});}
  function svgText(value){return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");}
  function editStatusDataURL(title,subtitle,state,ratio){var width=800,height=Math.max(360,Math.min(1200,Math.round(width/Math.max(.35,Math.min(2.4,Number(ratio)||1.6))))),failed=state==="failed",accent=failed?"#fb7185":"#60a5fa",safeTitle=svgText(title),safeSub=svgText(subtitle).slice(0,120),svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#1e293b"/></linearGradient><pattern id="p" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M0 28L28 0" stroke="#ffffff" stroke-opacity=".035" stroke-width="8"/></pattern></defs><rect width="100%" height="100%" rx="28" fill="url(#g)"/><rect width="100%" height="100%" rx="28" fill="url(#p)"/><rect x="3" y="3" width="794" height="'+(height-6)+'" rx="26" fill="none" stroke="'+accent+'" stroke-opacity=".65" stroke-width="6" stroke-dasharray="16 14"/>'+(failed?'<path d="M370 '+(height/2-70)+'l60 60m0-60l-60 60" stroke="'+accent+'" stroke-width="18" stroke-linecap="round"/>':'<circle cx="400" cy="'+(height/2-55)+'" r="42" fill="none" stroke="#334155" stroke-width="14"/><path d="M400 '+(height/2-97)+'a42 42 0 0 1 42 42" fill="none" stroke="'+accent+'" stroke-width="14" stroke-linecap="round"/>')+'<text x="400" y="'+(height/2+40)+'" fill="#f8fafc" font-family="PingFang SC, sans-serif" font-size="38" font-weight="700" text-anchor="middle">'+safeTitle+'</text><text x="400" y="'+(height/2+88)+'" fill="#94a3b8" font-family="PingFang SC, sans-serif" font-size="21" text-anchor="middle">'+safeSub+'</text></svg>';return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));}
  function createEditPlaceholder(item,subtitle){if(!api||!item)throw new Error("画布尚未就绪");var source=(api.getSceneElements()||[]).find(function(el){return el&&el.id===item.id&&el.type==="image"&&!el.isDeleted;});if(!source)throw new Error("原图片已不在画布中");var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,9),requestId="edit_"+token,id="e_edit_pending_"+token,fileId="f_edit_pending_"+token,ratio=Number(source.width||1)/Math.max(1,Number(source.height||1)),dataURL=editStatusDataURL("图片修改中…",subtitle||"处理中 · 完成后自动替换", "processing",ratio),selected={};selected[id]=true;api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);var placeholder=Object.assign({},source,{id:id,fileId:fileId,x:Number(source.x||0)+Number(source.width||240)+70,y:Number(source.y||0),index:undefined,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},source.customData||{},{dshFileName:"图片修改中…",dshSourcePath:"",dshSourceMtime:0,dshSourceKind:"placeholder",dshManaged:false,dshEditTitle:"图片修改中…",dshEditSubtitle:subtitle||"处理中 · 完成后自动替换",dshEditStartedAt:now,dshEditState:"processing",dshEditRequestId:requestId})});api.updateScene({elements:(api.getSceneElements()||[]).concat([placeholder]),appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:true});setTimeout(function(){if(api&&typeof api.scrollToContent==="function")api.scrollToContent([placeholder],{fitToContent:false,animate:true});},60);return {requestId:requestId,placeholderId:id};}
  function findEditPlaceholder(detail){return (api&&api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.type==="image"&&!item.isDeleted&&((detail.placeholderId&&item.id===detail.placeholderId)||(item.customData&&item.customData.dshEditRequestId===detail.requestId));});}
  function markEditPlaceholderFailed(detail){if(!api)return;var placeholder=findEditPlaceholder(detail);if(!placeholder)return;var now=Date.now(),fileId="f_edit_failed_"+now.toString(36)+"_"+Math.random().toString(36).slice(2,7),ratio=Number(placeholder.width||1)/Math.max(1,Number(placeholder.height||1)),message=String(detail.message||"请重新编辑"),dataURL=editStatusDataURL("图片修改失败",message,"failed",ratio);api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);var selected={};selected[placeholder.id]=true;var updated=(api.getSceneElements()||[]).map(function(item){if(!item||item.id!==placeholder.id)return item;return Object.assign({},item,{fileId:fileId,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,customData:Object.assign({},item.customData||{},{dshFileName:"图片修改失败",dshEditState:"failed",dshManaged:false})});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});post({type:"image-edit-placeholder-failed",message:message});}
  function reopenFailedImageEdit(detail){if(!api||!detail||!detail.retryItem)return false;var placeholder=findEditPlaceholder(detail),retry=detail.retryItem,selected={};if(retry.id)selected[retry.id]=true;var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){if(!placeholder||!item||item.id!==placeholder.id)return item;return Object.assign({},item,{isDeleted:true,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});if(typeof updateImageEditorState==="function")updateImageEditorState(Object.assign({},retry,{busy:false,error:String(detail.message||"生成失败，可直接重试")}));return true;}
  // 占位图超时自愈：请求若一直不返回（DSH 重启会把在途请求直接带走、网关也可能悬挂），
  // 「图片修改中…」就会永远转圈；而且占位图已经写进 canvas.json，重启后还会被恢复出来。
  // 这里把超过 25 分钟仍处于 processing 的占位图统一标成失败，用户删掉重来即可。
  // ---- 聊天生图占位(v1.9):与编辑占位同款视觉,完成原位替换 ----
  function chatPlaceholderAnchor(index){
    var els=(api&&api.getSceneElements?api.getSceneElements():[]),right=null;
    els.forEach(function(item){
      if(!item||item.type!=="image"||item.isDeleted)return;
      var c=item.customData||{};
      if(c.dshChatGenState==="failed")return;
      if(!right||Number(item.x||0)+Number(item.width||0)>Number(right.x||0)+Number(right.width||0))right=item;
    });
    var base=right?{x:Number(right.x||0)+Number(right.width||220)+70,y:Number(right.y||0)}:{x:150,y:150};
    var step=Number(index)||0;
    return {x:base.x+step*270,y:base.y+Math.floor(step/3)*180};
  }
  function createChatPlaceholder(detail){
    if(!api)throw new Error("画布尚未就绪");
    var now=Date.now(),id=String(detail.id||("e_chat_pending_"+now.toString(36))),fileId="f_"+id,ratio=1.6;
    var subtitle=String(detail.subtitle||"完成后自动加入画布");
    // 底图只做中性占位(视觉全部交给 dsh-pending 动画覆盖层,跟随应用主题)
    var dataURL="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#ececf0"/><rect x="6" y="6" width="788" height="488" fill="none" stroke="#b9bfcc" stroke-width="4" stroke-dasharray="14 12" rx="18"/></svg>')));
    var pos=chatPlaceholderAnchor(detail.index||0),w=220,h=Math.round(w/ratio);
    api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);
    var el={type:"image",id:id,fileId:fileId,x:pos.x,y:pos.y,width:w,height:h,angle:0,strokeColor:"transparent",backgroundColor:"transparent",fillStyle:"solid",strokeWidth:1,strokeStyle:"solid",roughness:0,opacity:100,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),isDeleted:false,groupIds:[],frameId:null,boundElements:null,updated:now,created:now,link:null,locked:false,roundness:null,status:"saved",scale:[1,1],mimeType:"image/svg+xml",customData:{dshFileName:"聊天生图中…",dshSourceKind:"placeholder",dshManaged:false,dshChatGen:true,dshChatGenState:"processing",dshChatGenStartedAt:now,dshEditState:"processing",dshEditTitle:"聊天生图中…",dshEditSubtitle:subtitle,dshEditStartedAt:now}};
    api.updateScene({elements:(api.getSceneElements()||[]).concat([el]),appState:Object.assign({},api.getAppState()||empty)});
    setTimeout(function(){if(api&&typeof api.scrollToContent==="function")api.scrollToContent([el],{fitToContent:false,animate:true});},60);
  }
  function findChatPlaceholder(id){return (api&&api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.type==="image"&&!item.isDeleted&&item.id===id;});}
  function resolveChatPlaceholder(detail){
    if(!api||!detail||!detail.url)return Promise.reject(new Error("生成结果无效"));
    var placeholder=findChatPlaceholder(detail.id);
    if(!placeholder)return Promise.reject(new Error("占位图已不在画布中"));
    return fetch(detail.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取生成结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){
      var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,8),fileId="f_chat_"+token,ratio=dm.w/Math.max(1,dm.h),pw=Number(placeholder.width||240),mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png",w,h;
      // 与 addImageDataURL/扫描导入统一为 240 盒装(同一批生成图视觉尺寸一致);
      // 用户手动改过占位宽度(非默认 220/240)时尊重该宽度按比例出高。
      if(Math.abs(pw-220)<.5||Math.abs(pw-240)<.5){if(ratio>=1){w=240;h=Math.max(1,Math.round(240/ratio));}else{h=240;w=Math.max(1,Math.round(240*ratio));}}else{w=pw;h=Math.max(1,Math.round(w/ratio));}
      api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);
      var el=Object.assign({},placeholder,{fileId:fileId,width:w,height:h,version:Number(placeholder.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,customData:Object.assign({},placeholder.customData||{},{dshFileName:detail.name||"聊天生成.png",dshSourcePath:detail.path||"",dshSourceMtime:Number(detail.mtime||0),dshSourceKind:"image",dshManaged:true,dshChatGenState:"complete",dshEditState:"complete"})});
      api.updateScene({elements:(api.getSceneElements()||[]).map(function(item){return item&&item.id===placeholder.id?el:item;}),appState:Object.assign({},api.getAppState()||empty)});
      post({type:"added"});
    });});
  }
  function failChatPlaceholder(detail){
    if(!api)return;
    var placeholder=findChatPlaceholder(detail.id);
    if(!placeholder)return;
    var now=Date.now(),fileId="f_chat_failed_"+now.toString(36)+"_"+Math.random().toString(36).slice(2,7),ratio=Number(placeholder.width||1)/Math.max(1,Number(placeholder.height||1));
    var msg=String(detail.message||"生成中断,请重试");var dataURL="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#f3f4f6"/><rect x="6" y="6" width="788" height="488" fill="none" stroke="#d1d5db" stroke-width="4" rx="18"/><text x="400" y="235" fill="#6b7280" font-family="PingFang SC,sans-serif" font-size="34" font-weight="700" text-anchor="middle">聊天生图失败</text><text x="400" y="285" fill="#9ca3af" font-family="PingFang SC,sans-serif" font-size="20" text-anchor="middle">'+msg.slice(0,60)+'</text></svg>')));
    api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);
    api.updateScene({elements:(api.getSceneElements()||[]).map(function(item){return item&&item.id===placeholder.id?Object.assign({},item,{fileId:fileId,version:Number(item.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,customData:Object.assign({},item.customData||{},{dshFileName:"聊天生图失败",dshChatGenState:"failed",dshEditState:"failed",dshManaged:false})}):item;}),appState:Object.assign({},api.getAppState()||empty)});
  }
  var STALE_EDIT_MS = 25 * 60 * 1000;
  function failStaleEditPlaceholders(){
    if(!api||typeof api.getSceneElements!=="function")return;
    var now=Date.now(),stale=[];
    try{
      (api.getSceneElements()||[]).forEach(function(item){
        if(!item||item.type!=="image"||item.isDeleted)return;
        var c=item.customData||{};
        if(c.dshChatGen&&String(c.dshChatGenState||"")==="processing"){
          var chatStarted=Number(c.dshChatGenStartedAt||0);
          if(!chatStarted||now-chatStarted>STALE_EDIT_MS)failChatPlaceholder({id:item.id,message:"等待超过 "+Math.round(STALE_EDIT_MS/60000)+" 分钟没有响应，已标记失败——删除后重新生成即可"});
          return;
        }
        if(String(c.dshEditState||"")!=="processing")return;
        var started=Number(c.dshEditStartedAt||0);
        if(!started||now-started>STALE_EDIT_MS)stale.push(item.id);
      });
    }catch(eScan){return;}
    for(var i=0;i<stale.length;i++){
      try{ markEditPlaceholderFailed({placeholderId:stale[i],message:"等待超过 "+Math.round(STALE_EDIT_MS/60000)+" 分钟没有响应，已标记失败——删除这张后重新编辑即可"}); }catch(eMark){}
    }
  }
  setInterval(failStaleEditPlaceholders, 15000);
  function addEditedImage(detail){if(!api||!detail||!detail.image||!detail.image.url)return Promise.reject(new Error("图片编辑结果无效"));var placeholder=findEditPlaceholder(detail),source=(api.getSceneElements()||[]).find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});if(!placeholder&&!source)return Promise.reject(new Error("原图片和等待图片均已不在画布中"));return fetch(detail.image.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取编辑结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,8),fileId="f_edit_"+token,ratio=dm.w/Math.max(1,dm.h),base=placeholder||source,w=Number(base.width||240),h=Math.max(1,Math.round(w/ratio)),mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png",id=placeholder?placeholder.id:("e_edit_"+token),selected={};selected[id]=true;api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);var customSource=source&&source.customData||{},el=Object.assign({},base,{id:id,fileId:fileId,x:placeholder?Number(placeholder.x||0):Number(source.x||0)+Number(source.width||w)+70,y:placeholder?Number(placeholder.y||0):Number(source.y||0),width:w,height:h,index:placeholder?placeholder.index:undefined,seed:placeholder?placeholder.seed:Math.floor(Math.random()*1e9),version:Number(base.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},customSource,placeholder&&placeholder.customData||{},{dshFileName:detail.image.name||"编辑结果.png",dshSourcePath:detail.image.path||"",dshSourceMtime:Number(detail.image.mtime||0),dshSourceKind:detail.image.kind||"image",dshManaged:true,dshEditState:"complete",dshEditRootPath:detail.editRootPath||customSource.dshEditRootPath||customSource.dshSourcePath||"",dshEditHistory:Array.isArray(detail.editHistory)?detail.editHistory:[],dshEditDepth:Number(detail.editDepth||1),dshEditEngine:detail.engine||"codex"})}),all=api.getSceneElements()||[],next=placeholder?all.map(function(item){return item&&item.id===placeholder.id?el:item;}):all.concat([el]);api.updateScene({elements:next,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});post({type:"image-edit-added",name:detail.image.name||"编辑结果",engine:detail.engine||"codex"});});});}
  function addBackgroundRemovedImage(detail){
    if(!api||!detail||!detail.image||!detail.image.url)return Promise.reject(new Error("去背景结果无效"));
    var placeholder=findEditPlaceholder(detail),source=(api.getSceneElements()||[]).find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});
    if(!placeholder&&!source)return Promise.reject(new Error("原图片和等待图片均已不在画布中"));
    return fetch(detail.image.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取去背景结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,8),fileId="f_bg_"+token,ratio=dm.w/Math.max(1,dm.h),base=placeholder||source,w=Number(base.width||240),h=Math.max(1,Math.round(w/ratio)),mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png",id=placeholder?placeholder.id:("e_bg_"+token),selected={};selected[id]=true;api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);var sourceCustom=source&&source.customData||{},el=Object.assign({},base,{id:id,fileId:fileId,x:placeholder?Number(placeholder.x||0):Number(source.x||0)+Number(source.width||w)+70,y:placeholder?Number(placeholder.y||0):Number(source.y||0),width:w,height:h,index:placeholder?placeholder.index:undefined,seed:placeholder?placeholder.seed:Math.floor(Math.random()*1e9),version:Number(base.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},sourceCustom,placeholder&&placeholder.customData||{},{dshFileName:detail.image.name||"去背景.png",dshSourcePath:detail.image.path||"",dshSourceMtime:Number(detail.image.mtime||0),dshSourceKind:"image",dshManaged:true,dshBackgroundRemoved:true,dshBackgroundModel:detail.model||"birefnet-general-lite",dshEditState:"complete"})}),all=api.getSceneElements()||[],next=placeholder?all.map(function(item){return item&&item.id===placeholder.id?el:item;}):all.concat([el]);api.updateScene({elements:next,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});post({type:"image-background-removed",name:detail.image.name||"去背景.png",model:detail.model||"birefnet-general-lite"});});});
  }
  function addVectorizedImage(detail){
    if(!api||!detail||!detail.image||!detail.image.url)return Promise.reject(new Error("矢量化结果无效"));
    return fetch(detail.image.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取矢量化结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){addImageDataURL(dataURL,dm,{name:detail.image.name||"矢量结果.svg",path:detail.image.path||"",mtime:detail.image.mtime||0,kind:"svg",managed:detail.image.managed!==false});post({type:"image-vectorized-added",name:detail.image.name||"矢量结果.svg",backend:detail.backend||""});});});
  }
  function ImageEditDialog(props){
    var p=useState(String(props.item.prompt||"")),prompt=p[0],setPrompt=p[1];
    var b=useState(38),brush=b[0],setBrush=b[1];
    var tl=useState("brush"),tool=tl[0],setTool=tl[1];
    var cu=useState({x:0,y:0,show:false}),cursor=cu[0],setCursor=cu[1];
    var mv=useState(0),maskVersion=mv[0],setMaskVersion=mv[1];
    var er=useState(""),error=er[0],setError=er[1];
    var vz=useState(1),zoom=vz[0],setZoom=vz[1];
    var vp=useState({x:0,y:0}),pan=vp[0],setPan=vp[1];
    var canvasRef=window.React.useRef(null),pathsRef=window.React.useRef([]),savedMaskRef=window.React.useRef(String(props.item.maskData||"")),activeRef=window.React.useRef(null),drawingRef=window.React.useRef(false),panGestureRef=window.React.useRef(null),spaceRef=window.React.useRef(false),zoomRef=window.React.useRef(1),panRef=window.React.useRef({x:0,y:0});
    zoomRef.current=zoom;panRef.current=pan;
    useEffect(function(){setPrompt(String(props.item.prompt||""));setError("");setTool("brush");setCursor({x:0,y:0,show:false});pathsRef.current=[];savedMaskRef.current=String(props.item.maskData||"");setMaskVersion(0);zoomRef.current=1;panRef.current={x:0,y:0};setZoom(1);setPan({x:0,y:0});panGestureRef.current=null;},[props.item.id,props.item.mode,props.item.retryToken]);
    useEffect(function(){var down=function(e){if(e.key===" ")spaceRef.current=true;};var up=function(e){if(e.key===" ")spaceRef.current=false;};window.addEventListener("keydown",down);window.addEventListener("keyup",up);return function(){window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);spaceRef.current=false;};},[]);
    var drawSelection=function(ctx,path){if(!path||!path.length)return;ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);if(path.kind==="rect"){var end=path[path.length-1]||path[0];ctx.rect(path[0].x,path[0].y,end.x-path[0].x,end.y-path[0].y);ctx.fill();return;}if(path.kind==="lasso"){path.slice(1).forEach(function(point){ctx.lineTo(point.x,point.y);});if(path.length>2){ctx.closePath();ctx.fill();}else{ctx.lineWidth=2;ctx.stroke();}return;}ctx.lineWidth=path[0].size;path.length===1?ctx.lineTo(path[0].x+.01,path[0].y+.01):path.slice(1).forEach(function(point){ctx.lineTo(point.x,point.y);});ctx.stroke();};
    var redraw=function(){var canvas=canvasRef.current;if(!canvas)return;var ctx=canvas.getContext("2d");ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle="#ff315d";ctx.fillStyle="#ff315d";ctx.lineCap="round";ctx.lineJoin="round";pathsRef.current.forEach(function(path){drawSelection(ctx,path);});};
    var prepareCanvas=function(e){var canvas=canvasRef.current,img=e.currentTarget;if(!canvas)return;canvas.width=img.naturalWidth||1;canvas.height=img.naturalHeight||1;redraw();};
    var pointOf=function(e){var canvas=canvasRef.current,rect=canvas.getBoundingClientRect(),sx=canvas.width/Math.max(1,rect.width),sy=canvas.height/Math.max(1,rect.height);return {x:(e.clientX-rect.left)*sx,y:(e.clientY-rect.top)*sy,size:brush*Math.max(sx,sy)};};
    var cursorPoint=function(e){var canvas=canvasRef.current,rect=canvas.getBoundingClientRect(),layoutW=canvas.offsetWidth||rect.width,layoutH=canvas.offsetHeight||rect.height,sx=rect.width/Math.max(1,layoutW),sy=rect.height/Math.max(1,layoutH);return {x:(e.clientX-rect.left)/Math.max(.001,sx),y:(e.clientY-rect.top)/Math.max(.001,sy),show:true};};
    var setViewport=function(nextZoom,center){var old=zoomRef.current||1,next=Math.max(.25,Math.min(4,Number(nextZoom)||1)),point=center||{x:0,y:0},current=panRef.current||{x:0,y:0},ratio=next/old,nextPan={x:point.x-(point.x-current.x)*ratio,y:point.y-(point.y-current.y)*ratio};zoomRef.current=next;panRef.current=nextPan;setZoom(next);setPan(nextPan);};
    var fitViewport=function(){zoomRef.current=1;panRef.current={x:0,y:0};setZoom(1);setPan({x:0,y:0});};
    var wheel=function(e){if(props.item.busy)return;e.preventDefault();e.stopPropagation();var rect=e.currentTarget.getBoundingClientRect(),center={x:e.clientX-(rect.left+rect.width/2),y:e.clientY-(rect.top+rect.height/2)},factor=e.deltaY>0?.9:1.1;setViewport(zoomRef.current*factor,center);};
    var beginPan=function(e){if(props.item.busy||!(spaceRef.current||e.button===1||e.button===2))return false;e.preventDefault();e.stopPropagation();panGestureRef.current={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,startPan:Object.assign({},panRef.current||{x:0,y:0})};if(e.currentTarget.setPointerCapture)e.currentTarget.setPointerCapture(e.pointerId);return true;};
    var pointerDown=function(e){if(beginPan(e))return;if(props.item.busy)return;e.preventDefault();e.stopPropagation();if(e.currentTarget.setPointerCapture)e.currentTarget.setPointerCapture(e.pointerId);var path=[pointOf(e)];path.kind=tool;pathsRef.current.push(path);activeRef.current=path;drawingRef.current=true;setCursor(cursorPoint(e));redraw();setMaskVersion(function(v){return v+1;});};
    var pointerMove=function(e){if(e.currentTarget===canvasRef.current)e.stopPropagation();if(panGestureRef.current){e.preventDefault();var gesture=panGestureRef.current,nextPan={x:gesture.startPan.x+(e.clientX-gesture.startX),y:gesture.startPan.y+(e.clientY-gesture.startY)};panRef.current=nextPan;setPan(nextPan);return;}if(e.currentTarget===canvasRef.current)setCursor(cursorPoint(e));if(!drawingRef.current||!activeRef.current)return;e.preventDefault();var point=pointOf(e);if(activeRef.current.kind==="rect"){activeRef.current.length=1;activeRef.current.push(point);}else activeRef.current.push(point);redraw();};
    var pointerUp=function(e){if(e.currentTarget===canvasRef.current)e.stopPropagation();if(panGestureRef.current){e.preventDefault();panGestureRef.current=null;return;}if(!drawingRef.current)return;e.preventDefault();drawingRef.current=false;activeRef.current=null;setMaskVersion(function(v){return v+1;});};
    var undo=function(){if(props.item.busy||!pathsRef.current.length)return;pathsRef.current.pop();redraw();setMaskVersion(function(v){return v+1;});};
    var clearMask=function(){if(props.item.busy)return;pathsRef.current=[];savedMaskRef.current="";redraw();setMaskVersion(function(v){return v+1;});};
    var buildMask=function(){var source=canvasRef.current,mask=document.createElement("canvas");mask.width=source.width;mask.height=source.height;var ctx=mask.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,mask.width,mask.height);ctx.globalCompositeOperation="destination-out";ctx.strokeStyle="#000";ctx.fillStyle="#000";ctx.lineCap="round";ctx.lineJoin="round";pathsRef.current.forEach(function(path){drawSelection(ctx,path);});return mask.toDataURL("image/png");};
    var submit=function(){var text=prompt.trim(),hasMask=pathsRef.current.length||savedMaskRef.current;if(props.item.mode==="edit"&&!text){setError("请输入具体修改需求");return;}if(props.item.mode==="erase"&&!hasMask){setError("请先用画笔、套索或框选标出要擦除的区域");return;}setError("");props.onSubmit({prompt:text,maskData:pathsRef.current.length?buildMask():savedMaskRef.current});};
    var erase=props.item.mode==="erase",note=erase?"提示词可留空：擦除选区并智能补全背景；也可填写希望补成什么。滚轮缩放；按住空格或鼠标中键拖动视图。":"选区是可选的：有选区时只修改红色区域；不画选区时按提示词修改整张图。不会写入主聊天上下文。滚轮缩放；按住空格或鼠标中键拖动视图。";
    return window.React.createElement("div",{className:"dsh-image-editor",onPointerDown:function(e){e.stopPropagation();}},window.React.createElement("div",{className:"dsh-image-editor-panel"},
      window.React.createElement("div",{className:"dsh-image-editor-head"},window.React.createElement("div",{className:"dsh-image-editor-title"},erase?"智能擦除":"编辑图片"),window.React.createElement("div",{className:"dsh-image-editor-sub"},props.item.name),window.React.createElement("div",{className:"dsh-mask-tools",role:"group","aria-label":"遮罩选择工具"},[["brush","画笔"],["lasso","套索"],["rect","框选"]].map(function(item){return window.React.createElement("button",{key:item[0],type:"button",className:"dsh-mask-tool"+(tool===item[0]?" is-active":""),disabled:props.item.busy,onClick:function(){setTool(item[0]);setCursor({x:0,y:0,show:false});}},item[1]);})),tool==="brush"?window.React.createElement("label",{className:"dsh-brush-label",title:"画面上圆环显示当前画笔的屏幕直径"},"直径 ",window.React.createElement("input",{type:"range",min:8,max:120,value:brush,disabled:props.item.busy,onChange:function(e){setBrush(Number(e.target.value));}}),brush+"px"):null,window.React.createElement("div",{className:"dsh-image-editor-zoom",role:"group","aria-label":"画布缩放"},window.React.createElement("button",{type:"button",disabled:props.item.busy,onClick:function(){setViewport(zoomRef.current/1.2,null)},title:"缩小"},"−"),window.React.createElement("span",{className:"dsh-image-editor-zoom-value"},Math.round(zoom*100)+"%"),window.React.createElement("button",{type:"button",disabled:props.item.busy,onClick:function(){setViewport(zoomRef.current*1.2,null)},title:"放大"},"+"),window.React.createElement("button",{type:"button",disabled:props.item.busy,onClick:fitViewport,title:"适应视图"},"适应")),window.React.createElement("button",{className:"dsh-image-editor-tool",disabled:props.item.busy||!pathsRef.current.length,onClick:undo},"撤销选择"),window.React.createElement("button",{className:"dsh-image-editor-tool",disabled:props.item.busy||!pathsRef.current.length,onClick:clearMask},"清空遮罩"),window.React.createElement("button",{className:"dsh-image-editor-tool dsh-image-editor-close",disabled:props.item.busy,onClick:props.onClose,title:"关闭"},"×")),
      window.React.createElement("div",{className:"dsh-image-editor-stage",onWheel:wheel,onPointerDown:function(e){beginPan(e);},onPointerMove:pointerMove,onPointerUp:pointerUp,onPointerCancel:pointerUp,onContextMenu:function(e){e.preventDefault();}},window.React.createElement("div",{className:"dsh-image-editor-media",style:{transform:"translate("+pan.x+"px,"+pan.y+"px) scale("+zoom+")"}},window.React.createElement("img",{className:"dsh-image-editor-image",src:props.item.dataURL,draggable:false,onLoad:prepareCanvas}),window.React.createElement("canvas",{ref:canvasRef,className:"dsh-image-editor-mask"+(tool==="brush"?"":" dsh-select-cursor"),onPointerEnter:function(e){setCursor(cursorPoint(e));},onPointerLeave:function(){setCursor({x:0,y:0,show:false});},onPointerDown:pointerDown,onPointerMove:pointerMove,onPointerUp:pointerUp,onPointerCancel:pointerUp}),tool==="brush"&&cursor.show?window.React.createElement("div",{className:"dsh-mask-cursor",style:{left:cursor.x+"px",top:cursor.y+"px",width:(brush/Math.max(.001,zoom))+"px",height:(brush/Math.max(.001,zoom))+"px"}}):null),props.item.busy?window.React.createElement("div",{className:"dsh-image-editor-busy"},"Codex 正在编辑；失败时自动切换 image2 API…"):null),
      window.React.createElement("div",{className:"dsh-image-editor-foot"},window.React.createElement("textarea",{className:"dsh-image-editor-input",value:prompt,disabled:props.item.busy,autoFocus:true,placeholder:erase?"可选：留空 = 擦除所选区域并智能补全背景":"描述你想要的编辑，例如：删除底部小字，其他内容保持不变…",onChange:function(e){setPrompt(e.target.value);},onKeyDown:function(e){if((e.metaKey||e.ctrlKey)&&e.key==="Enter")submit();}}),window.React.createElement("button",{className:"dsh-image-editor-send",disabled:props.item.busy,onClick:submit},props.item.busy?"处理中…":(erase?"擦除并补全":"生成修改图")),window.React.createElement("div",{className:"dsh-image-editor-note"+(error||props.item.error?" dsh-error":"")},error||props.item.error||note))
    ));
  }
  function renameCanvasImage(id,value){if(!api)return "";var elements=api.getSceneElements()||[],target=elements.find(function(item){return item&&item.id===id&&item.type==="image";});if(!target)return "";var files=fileObject(api.getFiles?api.getFiles():{}),file=files[target.fileId]||{},oldName=target.customData&&target.customData.dshFileName||("画布图片-"+String(target.id).slice(-6)+".png"),sourceKind=target.customData&&target.customData.dshSourceKind||"",forcedExt=["psd","svg","pdf","ai"].indexOf(sourceKind)>=0?sourceKind:"",newName=uniqueImageName(value,file.dataURL||"",id,forcedExt);var now=Date.now();var updated=elements.map(function(item){if(!item||item.id!==id)return item;return Object.assign({},item,{customData:Object.assign({},item.customData||{},{dshFileName:newName}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:true});post({type:"rename-image",id:id,fileId:target.fileId,oldName:oldName,newName:newName,sourcePath:target.customData&&target.customData.dshSourcePath||""});return newName;}
  function refreshSourceImage(detail){if(!api||!detail||!detail.elementId||!detail.url)return Promise.resolve();var elements=api.getSceneElements()||[],target=elements.find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});if(!target)return Promise.resolve();var read=function(attempt){var separator=String(detail.url).indexOf("?")>=0?"&":"?";return toDataURL(detail.url+separator+"refreshAttempt="+attempt+"&t="+Date.now()).catch(function(err){if(attempt>=4)throw err;return new Promise(function(resolve){setTimeout(resolve,450*attempt);}).then(function(){return read(attempt+1);});});};return read(1).then(function(dataURL){return dims2(dataURL).then(function(dm){var mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/jpeg",now=Date.now(),nextFileId="f_refresh_"+now.toString(36)+"_"+Math.random().toString(36).slice(2,8),size=aspectCorrectedSize(target,dm);api.addFiles([{id:nextFileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);var updated=elements.map(function(item){if(!item||item.id!==target.id)return item;return Object.assign({},item,size||{},{fileId:nextFileId,customData:Object.assign({},item.customData||{},{dshFileName:detail.name||item.customData&&item.customData.dshFileName,dshSourcePath:detail.path||item.customData&&item.customData.dshSourcePath,dshSourceMtime:Number(detail.mtime||0),dshSourceSize:Number(detail.size||0),dshSourceKind:detail.kind||item.customData&&item.customData.dshSourceKind||"image"}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,status:"saved"});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});post({type:"source-refreshed",elementId:target.id,path:detail.path||"",mtime:Number(detail.mtime||0),size:Number(detail.size||0),name:detail.name||target.customData&&target.customData.dshFileName||"图片"});});});}
  function bindManagedImage(detail){if(!api||!detail||!detail.elementId)return;var elements=api.getSceneElements()||[],target=elements.find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});if(!target)return;var files=fileObject(api.getFiles?api.getFiles():{}),oldFile=files[target.fileId],nextFileId=detail.newFileId||target.fileId,now=Date.now();if(oldFile&&nextFileId!==target.fileId)api.addFiles([{id:nextFileId,dataURL:oldFile.dataURL,mimeType:oldFile.mimeType||"image/png",created:now,lastRetrieved:now}]);var updated=elements.map(function(item){if(!item||item.id!==target.id)return item;return Object.assign({},item,{fileId:nextFileId,customData:Object.assign({},item.customData||{},{dshFileName:detail.name,dshSourcePath:detail.path,dshSourceMtime:Number(detail.mtime||0),dshSourceSize:Number(detail.size||0),dshSourceKind:detail.kind||"image",dshManaged:detail.managed!==false}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,status:"saved"});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});}
  function removeSourceElements(ids){if(!api||!Array.isArray(ids)||!ids.length)return;var selected={};ids.forEach(function(id){selected[id]=true;});var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){if(!item||!selected[item.id])return item;return Object.assign({},item,{isDeleted:true,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});}
  // Mac 式七色标记（与素材库/Finder 颜色一致），存放在元素 customData.dshTagColor。
  var DSH_TAG_HEX={red:"#ff5f57",orange:"#ff9f0a",yellow:"#ffd60a",green:"#28c840",blue:"#0a84ff",purple:"#bf5af2",gray:"#8e8e93"};
  /* 文档格式默认标记(品牌色,方点区分用户圆点):PS 蓝 / AI 橙 / PDF 红 / SVG 紫。
     存元素 customData.dshTagColor,渲染与用户标记同一套(屏幕空间,不随画布缩放)。 */
  var DSH_FORMAT_TAG_HEX={psd:"#31A8FF",ai:"#FF9A00",pdf:"#E5322D",svg:"#8B5CF6"};
  function docFormatTagOf(kind){var k=String(kind||"").toLowerCase();return DSH_FORMAT_TAG_HEX[k]?k:null;}
  /* 旧元素可能没存 dshSourceKind:按源路径/文件名扩展名推断格式(.psd/.ai/.pdf/.svg)。 */
  function docFormatTagOfElement(item){var cd=item&&item.customData||{};var path=String(cd.dshSourcePath||cd.dshFileName||"");var m=/\.(psd|ai|pdf|svg)\s*$/i.exec(path);if(m)return m[1].toLowerCase();return docFormatTagOf(cd.dshSourceKind);}
  function setCanvasImageTag(ids,color){if(!api||!Array.isArray(ids)||!ids.length)return 0;var all=api.getSceneElements()||[],wanted={};ids.forEach(function(id){wanted[id]=true;});var count=0,now=Date.now();var updated=all.map(function(item){if(!item||item.type!=="image"||!wanted[item.id]||item.isDeleted)return item;var custom=Object.assign({},item.customData||{});if(color)custom.dshTagColor=color;else delete custom.dshTagColor;count++;return Object.assign({},item,{customData:custom,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});if(!count)return 0;api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:true});post({type:"tag-images",ids:ids,color:color||"",count:count});return count;}
  function arrangeCanvasImages(detail){if(!api)return;var order=String(detail&&detail.order||"name"),tag=detail&&detail.tag===undefined?"":String(detail.tag||"");
    var collect=(api.getSceneElements()||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted;});
    var images=collect.filter(function(item){var c=item.customData&&item.customData.dshTagColor||"";return tag===""?true:(tag==="none"?!c:c===tag);});
    if(!images.length){post({type:"arranged",count:0,order:order,tag:tag});return;}
    var files=fileObject(api.getFiles?api.getFiles():{});
    var extOf=function(name){var m=/\.([a-z0-9]+)$/i.exec(String(name||""));return m?m[1].toLowerCase():"";};
    var nameOf=function(item){return item.customData&&item.customData.dshFileName||("画布图片-"+String(item.id||"").slice(-6)+".png");};
    var timeOf=function(item){return Number(item.customData&&item.customData.dshSourceMtime||0);};
    var bytesOf=function(item){return Number(item.customData&&item.customData.dshSourceSize||0);};
    var layout=function(pixelMap){
      var sorted=images.slice().sort(order==="time"?function(a,b){return timeOf(b)-timeOf(a);}
        :order==="bytes"?function(a,b){return bytesOf(b)-bytesOf(a)||timeOf(b)-timeOf(a);}
        :order==="type"?function(a,b){var ea=extOf(nameOf(a)),eb=extOf(nameOf(b));return ea===eb?(timeOf(b)-timeOf(a)):(ea<eb?-1:1);}
        :order==="pixels"?function(a,b){return (pixelMap[b.fileId]||0)-(pixelMap[a.fileId]||0)||timeOf(b)-timeOf(a);}
        :function(a,b){return String(nameOf(a)).localeCompare(String(nameOf(b)),"zh-CN",{numeric:true,sensitivity:"base"});});
      var minX=Math.min.apply(null,sorted.map(function(item){return Number(item.x||0);})),bandY=Math.min.apply(null,sorted.map(function(item){return Number(item.y||0);})),positions={};
      // 文件类型排序按扩展名分块：每种格式一个独立网格带，块间留大间隔
      //（约 1.5 行空白），避免不同格式混排在同一片网格里看不出来。
      var groups=[sorted];
      if(order==="type"){
        groups=[];var byExt={},extOrder=[];
        sorted.forEach(function(item){var ext=extOf(nameOf(item));if(!byExt[ext]){byExt[ext]=[];extOrder.push(ext);}byExt[ext].push(item);});
        extOrder.forEach(function(ext){groups.push(byExt[ext]);});
      }
      groups.forEach(function(group){
        var columns=Math.min(5,Math.max(2,Math.ceil(Math.sqrt(group.length*1.35)))),rows=Math.ceil(group.length/columns);
        group.forEach(function(item,index){var ratio=Number(item.width||1)/Math.max(1,Number(item.height||1)),w,h;if(ratio>=1){w=240;h=Math.max(1,Math.round(240/ratio));}else{h=240;w=Math.max(1,Math.round(240*ratio));}var col=index%columns,row=Math.floor(index/columns);positions[item.id]={x:minX+col*300+(240-w)/2,y:bandY+row*320,width:w,height:h};});
        bandY+=rows*320+460;
      });
      var now=Date.now(),updated=collect.map(function(item){var p=item&&positions[item.id];if(!p)return item;return Object.assign({},item,p,{version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});
      api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:true});
      setTimeout(function(){if(api&&typeof api.scrollToContent==="function")api.scrollToContent(updated.filter(function(item){return item&&positions[item.id];}),{fitToContent:true,animate:true});},80);
      post({type:"arranged",count:sorted.length,order:order,tag:tag,groups:groups.length});
    };
    if(order!=="pixels"){layout(null);return;}
    // 图片尺寸排序需要真实像素：按 fileId 去重解码一次 dataURL（结果只进局部 map，不写回场景）。
    var unique={},pending=[];
    images.forEach(function(item){if(item.fileId&&!unique[item.fileId]){unique[item.fileId]=true;pending.push(item.fileId);}});
    var pixelMap={},done=0;
    if(!pending.length){layout(pixelMap);return;}
    pending.forEach(function(fid){
      var file=files[fid],apply=function(w,h){pixelMap[fid]=(w||0)*(h||0);if(++done===pending.length)layout(pixelMap);};
      if(!file||!file.dataURL){apply(0,0);return;}
      var probe=new Image();
      probe.onload=function(){apply(probe.naturalWidth,probe.naturalHeight);};
      probe.onerror=function(){apply(0,0);};
      probe.src=file.dataURL;
    });
  }

function Main(){
    var l=useState([]),labels=l[0],setLabels=l[1];
    var pd=useState([]),pending=pd[0],setPending=pd[1];var pr=window.React.useRef("");
    var tk=useState(0),tick=tk[0],setTick=tk[1];bumpPending=function(){setTick(Date.now());};
    window.React.useEffect(function(){if(!pending.length)return undefined;var t=setInterval(function(){setTick(Date.now());},1000);return function(){clearInterval(t);};},[pending.length]);
    var ed=useState(null),editing=ed[0],setEditing=ed[1];
    var tb=useState(null),toolbar=tb[0],setToolbar=tb[1];
    var ie=useState(null),imageEditor=ie[0],setImageEditor=ie[1];
    updateImageEditorState=setImageEditor;openImageEditorById=function(mode,id){openImageEditor(mode,id);};
    var mo=useState(false),moreOpen=mo[0],setMoreOpen=mo[1];
    /* 选区变化/移动时自动收起"更多"菜单 */
    window.React.useEffect(function(){setMoreOpen(false);},[toolbar]);
    var lr=window.React.useRef("");
    var tr=window.React.useRef("");
    var updateLabels=function(elements,appState){var next=imageNameLabels(elements,appState),signature=next.map(function(item){return [item.id,item.name,item.displayName,item.left,item.top,item.width,item.fontSize,item.height,item.selected].join(":");}).join("|");if(signature!==lr.current){lr.current=signature;setLabels(next);}var pn=pendingOverlays(elements,appState),ps=pn.map(function(p){return [p.id,p.left,p.top,p.width,p.height,p.title,p.subtitle].join(":");}).join("|");if(ps!==pr.current){pr.current=ps;setPending(pn);}};
    var updateToolbar=function(elements,appState){var next=selectionToolbarData(elements,appState),signature=next?[next.ids.join("|"),next.left,next.top,next.singleName].join(":"):"";if(signature!==tr.current){tr.current=signature;setToolbar(next);}};
    requestSceneLoad=function(saved){
      var elements=(saved.elements||[]).filter(function(item){return item&&item.id!=="dsh_theme_backdrop"&&!(item.customData&&item.customData.dshChatGen&&item.customData.dshChatGenState==="processing");}).map(function(item,itemIndex){var normalized=Object.assign({},item,{index:item.index||("a"+itemIndex)});if(item.type!=="image")return normalized;return Object.assign({strokeColor:"transparent",backgroundColor:"transparent",fillStyle:"solid",strokeWidth:1,strokeStyle:"solid",roughness:0,opacity:100,frameId:null,status:"saved",scale:[1,1]},normalized,{status:item.status||"saved",scale:Array.isArray(item.scale)?item.scale:[1,1],frameId:item.frameId||null});});
      var now=Date.now(),files={},usedFileIds={};
      elements.forEach(function(item){if(item&&item.type==="image"&&!item.isDeleted&&item.fileId)usedFileIds[item.fileId]=true;});
      if(saved.files)Object.keys(saved.files).forEach(function(k){if(!usedFileIds[k])return;var v=saved.files[k]||{};if(v.dataURL)files[k]={id:v.id||k,dataURL:v.dataURL,mimeType:v.mimeType||"image/png",created:v.created||now,lastRetrieved:now};});
      var targetAppState=Object.assign({},empty,saved.appState||{});
      if(window.ExcalidrawLib&&typeof window.ExcalidrawLib.convertToExcalidrawElements==="function")elements=window.ExcalidrawLib.convertToExcalidrawElements(elements,{regenerateIds:false});
      if(window.ExcalidrawLib&&typeof window.ExcalidrawLib.restore==="function"){
        var restored=window.ExcalidrawLib.restore({elements:elements,appState:targetAppState,files:files},api&&api.getAppState?api.getAppState():null,null);
        elements=restored.elements||elements;targetAppState=restored.appState||targetAppState;files=fileObject(restored.files||files);
      }
      if(!/^#[0-9a-f]{6}$/i.test(String(targetAppState.viewBackgroundColor||"")))targetAppState.viewBackgroundColor=canvasDefaultBackground;
      targetAppState.openMenu=null;
      targetAppState.openPopup=null;
      targetAppState.openSidebar=null;
      targetAppState.openDialog=null;
      targetAppState.contextMenu=null;
      targetAppState.showWelcomeScreen=false;
      targetAppState.collaborators=new Map();
      hydrating=true;expectedElements=elements.filter(function(item){return item&&!item.isDeleted;}).length;
      if(!api)throw new Error("画布尚未就绪");
      if(typeof api.resetScene==="function")api.resetScene();else api.updateScene({elements:[],appState:empty});
      setTimeout(function(){
        if(Object.keys(files).length&&typeof api.addFiles==="function")api.addFiles(Object.keys(files).map(function(k){return files[k];}));
        setTimeout(function(){
          api.updateScene({elements:elements,appState:targetAppState,commitToHistory:false});updateLabels(elements,targetAppState);updateToolbar(elements,targetAppState);setTimeout(function(){repairPsdAspectRatios().catch(function(err){post({type:"error",message:"PSD 比例修复失败: "+String(err&&err.message||err)});});},120);
          setTimeout(function(){
            var sceneElements=api&&api.getSceneElements?api.getSceneElements():[];var sceneFiles=api&&api.getFiles?fileObject(api.getFiles()):{};
            if(sceneElements.length===expectedElements&&sceneElements.length&&typeof api.scrollToContent==="function")api.scrollToContent(sceneElements,{fitToContent:true,animate:false});
            var diagRoot=document.getElementById("ex-root"),diagCanvas=diagRoot?diagRoot.querySelectorAll("canvas").length:0,diagButtons=diagRoot?diagRoot.querySelectorAll("button").length:0;
            if(sceneElements.length===expectedElements){hydrating=false;post({type:"loaded",snapshot:serialize(sceneElements,api.getAppState?api.getAppState():saved.appState,api.getFiles?api.getFiles():files)});if(window.__dshSentFilesReset)window.__dshSentFilesReset(fileObject(api.getFiles?api.getFiles():files));}
            if(lastRuntimeError||sceneElements.length!==expectedElements)post({type:"diagnostic",elements:sceneElements.length,files:Object.keys(sceneFiles).length,expected:expectedElements,dom:(diagRoot&&diagRoot.querySelectorAll("*").length||0),canvas:diagCanvas,buttons:diagButtons,error:lastRuntimeError});
          },250);
        },80);
      },0);
    };
    document.addEventListener('click',function(e){
      try{
        var node=e.target,hit=null;
        while(node&&node!==document){var t=(node.textContent||'').trim();if(t==='添加到素材库中'||t==='添加到素材库'){hit=node;break;}node=node.parentNode;}
        if(!hit)return;
        e.preventDefault();e.stopPropagation();if(typeof e.stopImmediatePropagation==='function')e.stopImmediatePropagation();
        var sel=(api&&api.getSceneElements?api.getSceneElements():[]).filter(function(x){return x&&x.type==='image'&&!x.isDeleted&&api.getAppState&&api.getAppState().selectedElementIds&&api.getAppState().selectedElementIds[x.id];});
        var files=fileObject(api.getFiles?api.getFiles():{});
        var payload=sel.map(function(x){var f=files[x.fileId];return f&&f.dataURL?{name:(x.customData&&x.customData.dshFileName)||('素材-'+String(x.id).slice(-6)+'.png'),dataURL:f.dataURL}:null;}).filter(Boolean);
        if(payload.length){post({type:'save-to-materials',items:payload,source:'context-menu'});if(api&&api.updateScene)api.updateScene({appState:Object.assign({},api.getAppState()||empty,{openMenu:null,contextMenu:null})});}
      }catch(err){}
    },true);
    var onCanvasChange=function(el,st,fl){
      var snapshot=serialize(el,st,api&&api.getFiles?api.getFiles():fl),live=(el||[]).filter(function(item){return item&&!item.isDeleted;}).length;updateLabels(el,st);updateToolbar(el,st);
      if(hydrating){if(live<expectedElements)return;hydrating=false;post({type:"loaded",snapshot:snapshot});if(window.__dshSentFilesReset)window.__dshSentFilesReset(snapshot.files||{});}
      post({type:"changed",snapshot:snapshot,token:window.__dshSceneToken||""});
    };
    var commitName=function(){if(!editing)return;var next=renameCanvasImage(editing.id,editing.value);setEditing(null);if(next)post({type:"name-edited",name:next});};
    var openImageEditor=function(mode,id){if(!api)return;var target=(api.getSceneElements()||[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}var custom=target.customData||{},item={mode:mode,id:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),dataURL:file.dataURL,width:0,height:0,sourcePath:custom.dshSourcePath||"",editRootPath:custom.dshEditRootPath||"",editHistory:Array.isArray(custom.dshEditHistory)?custom.dshEditHistory:[],editDepth:Number(custom.dshEditDepth||0),busy:false,error:""};setImageEditor(item);var probe=new Image();probe.onload=function(){setImageEditor(function(current){return current&&current.id===id?Object.assign({},current,{width:probe.naturalWidth||1,height:probe.naturalHeight||1}):current;});};probe.src=file.dataURL;};

    var openInPhotoshop=function(id){if(!api)return;var target=(api.getSceneElements()||[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}var custom=target.customData||{};post({type:"request-photoshop-edit",elementId:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),sourcePath:custom.dshSourcePath||"",sourceKind:custom.dshSourceKind||"image",dataURL:file.dataURL});};
    var openInIllustrator=function(id){if(!api)return;var target=(api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),custom=target&&target.customData||{},kind=String(custom.dshSourceKind||"");if(!target||!custom.dshSourcePath){post({type:"error",message:"Illustrator 编辑需要源文件（该图片没有关联的磁盘源，如为粘贴图请先归档）"});return;}post({type:"request-illustrator-edit",elementId:id,name:custom.dshFileName||("画布文件-"+String(id).slice(-6)),sourcePath:custom.dshSourcePath,sourceKind:kind});};
    /* Adobe 桥接「返回 Ps/Ai」：把所选图片交给父页面写入项目 ADOBE桥接/发件箱（有源文件传路径，无源文件传 dataURL 先落盘）。
       customData.dshBridge 是收件时打的印（jobId/app/layer），host 据此解析出处并让 PS/AI 面板原位置入。协议：adobe-bridge/PROTOCOL.md */
    var requestBridgeReturn=function(ids,app){if(!api||!Array.isArray(ids)||!ids.length)return;var wanted={};ids.forEach(function(id){wanted[id]=true;});var files=fileObject(api.getFiles?api.getFiles():{}),items=[];(api.getSceneElements()||[]).forEach(function(item){if(!item||item.type!=="image"||item.isDeleted||!wanted[item.id])return;var custom=item.customData||{},file=files[item.fileId],sourcePath=String(custom.dshSourcePath||"");if(!sourcePath&&!(file&&file.dataURL))return;items.push({elementId:item.id,fileId:item.fileId,name:custom.dshFileName||("画布图片-"+String(item.id).slice(-6)+".png"),sourcePath:sourcePath,sourceKind:custom.dshSourceKind||"image",dataURL:sourcePath?"":file.dataURL,bridge:custom.dshBridge||null});});if(!items.length){post({type:"error",message:"所选图片没有可返回的数据"});return;}post({type:"request-bridge-return",app:app,items:items});};
    var requestVectorize=function(id,vectorMode){if(!api)return;var target=(api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId],custom=target&&target.customData||{},kind=String(custom.dshSourceKind||"image"),mimeMatch=String(file&&file.dataURL||"").match(/^data:([^;]+);base64,/i),mime=mimeMatch?String(mimeMatch[1]).toLowerCase():"",rasterMime=["image/png","image/jpeg","image/jpg","image/webp","image/gif","image/avif","image/bmp"].indexOf(mime)>=0;if(!target||!file||!file.dataURL||["image","psd"].indexOf(kind)<0||!rasterMime){post({type:"error",message:"当前图片不适合转矢量，请选择 PNG/JPG/WebP 等栅格图片"});return;}post({type:"request-vectorize",elementId:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),sourcePath:custom.dshSourcePath||"",imageData:file.dataURL,vectorMode:vectorMode||"flat"});};
    var requestTextRebuild=function(id){if(!api)return;var target=(api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}var custom=target.customData||{};post({type:"request-text-rebuild",elementId:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),sourcePath:custom.dshSourcePath||"",imageData:file.dataURL});};
    var materialPayloadForSelection=function(ids){if(!api)return[];var wanted=new Set(Array.isArray(ids)?ids:[]),files=fileObject(api.getFiles?api.getFiles():{});return (api.getSceneElements?api.getSceneElements():[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&wanted.has(item.id);}).map(function(item,index){var file=files[item.fileId],custom=item.customData||{};return file&&file.dataURL?{dataURL:file.dataURL,name:custom.dshFileName||("画布素材-"+(index+1)+"-"+String(item.id).slice(-6)+".png")}:null;}).filter(Boolean);};
    var saveSelectionToMaterials=function(ids){var items=materialPayloadForSelection(ids);if(items.length)post({type:"save-to-materials",items:items,source:"selection-toolbar"});else post({type:"error",message:"所选图片暂时无法读取"});};
    var beginMaterialDrag=function(ids,event){var items=materialPayloadForSelection(ids);if(!items.length)return;if(event&&event.dataTransfer){event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-dsh-canvas-image",JSON.stringify({count:items.length}));event.dataTransfer.setData("text/plain",items.length===1?items[0].name:(items.length+" 张画布图片"));}post({type:"material-drag-start",items:items});};
    var sendSelectionToChat=function(ids){if(!api)return;var wanted=new Set(Array.isArray(ids)?ids:[]),files=fileObject(api.getFiles?api.getFiles():{}),images=(api.getSceneElements?api.getSceneElements():[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&wanted.has(item.id);}).map(function(item,index){var file=files[item.fileId],custom=item.customData||{};return file&&file.dataURL?{dataURL:file.dataURL,name:custom.dshFileName||("canvas-selection-"+(index+1)+"-"+String(item.id).slice(-6)+".png"),width:Math.max(1,Number(item.width||0)),height:Math.max(1,Number(item.height||0)),sourceKind:String(custom.dshSourceKind||"image")} : null;}).filter(Boolean);if(!images.length){post({type:"error",message:"所选图片暂时无法读取，请稍后重试"});return;}var batchId="chat_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,7);images.forEach(function(image,index){setTimeout(function(){post({type:"request-send-selection-item",batchId:batchId,index:index+1,total:images.length,image:image});},index*90);});};
    var requestBackgroundRemoval=function(id){if(!api)return;var target=(api.getSceneElements()||[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}try{var custom=target.customData||{},job=createEditPlaceholder({id:id},"本地 rembg · birefnet-general-lite · 首次使用自动准备"),name=custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png");post({type:"request-remove-background",requestId:job.requestId,placeholderId:job.placeholderId,elementId:id,fileId:target.fileId,name:name,imageData:file.dataURL,imagePath:custom.dshSourcePath||""});}catch(err){post({type:"error",message:String(err&&err.message||err)});}};
    var submitImageEdit=function(payload){if(!imageEditor||imageEditor.busy)return;try{var job=createEditPlaceholder(imageEditor),request=Object.assign({},imageEditor);setImageEditor(null);var posEl=(api&&api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===request.id;})||null;post({type:"request-image-edit",requestId:job.requestId,placeholderId:job.placeholderId,elementId:request.id,fileId:request.fileId,name:request.name,imageData:request.dataURL,imagePath:request.sourcePath,editRootPath:request.editRootPath,editHistory:request.editHistory,editDepth:request.editDepth,mode:request.mode,prompt:payload.prompt,maskData:payload.maskData,width:request.width,height:request.height,atX:posEl?posEl.x:undefined,atY:posEl?posEl.y:undefined});}catch(err){setImageEditor(Object.assign({},imageEditor,{busy:false,error:String(err&&err.message||err)}));}};
    return window.React.createElement('div',{style:{position:'absolute',inset:0}},
      window.React.createElement('div',{style:{position:'absolute',inset:0}},window.React.createElement(window.ExcalidrawLib.Excalidraw,{excalidrawAPI:function(a){api=a;if(!ready){ready=true;post({type:"ready"})}},initialData:{elements:[],appState:empty,files:{}},onChange:onCanvasChange,viewModeEnabled:false,zenModeEnabled:false,langCode:"zh-CN"})),
      window.React.createElement('div',{className:'dsh-name-layer'},pending.map(function(p){var fs=Math.max(9,Math.min(20,p.width/13)),compact=p.height<fs*7||p.width<fs*9,prog=pendingProgress[p.id]||null,pct=prog&&isFinite(Number(prog.percent))?Math.max(0,Math.min(100,Math.round(Number(prog.percent)))):null,elapsed=p.startedAt?Math.max(0,Math.round((Date.now()-p.startedAt)/1000)):0,mm=Math.floor(elapsed/60),ss=String(elapsed%60).padStart(2,'0'),sub=prog&&prog.message?String(prog.message):p.subtitle;return window.React.createElement('div',{key:'pend_'+p.id,className:'dsh-pending',style:{left:p.left+'px',top:p.top+'px',width:p.width+'px',height:p.height+'px',fontSize:fs+'px'}},compact?null:window.React.createElement('div',{className:'dsh-pending-ring'}),pct!==null&&!compact?window.React.createElement('div',{className:'dsh-pending-percent'},pct+'%'):null,window.React.createElement('div',{className:'dsh-pending-title'},p.title),compact||!sub?null:window.React.createElement('div',{className:'dsh-pending-sub'},sub),compact?null:window.React.createElement('div',{className:'dsh-pending-time'},'已用 '+mm+':'+ss),window.React.createElement('div',{className:'dsh-pending-bar'},pct!==null?window.React.createElement('b',{style:{width:pct+'%'}}):window.React.createElement('i',null)));}),labels.filter(function(item){return (editing&&editing.id===item.id)||item.selected||item.tag||item.fmt;}).map(function(item){var labelStyle={left:item.left+'px',top:item.top+'px',width:item.width+'px',minWidth:item.minWidth+'px',maxWidth:item.maxWidth+'px',height:item.height+'px',padding:'3px '+item.paddingX+'px',fontSize:item.fontSize+'px',lineHeight:Math.max(10,item.height-6)+'px',borderRadius:Math.max(4,Math.round(6*item.fontSize/11))+'px',transform:'translateY(-'+item.offsetY+'px)'};return editing&&editing.id===item.id
        ?window.React.createElement('input',{key:item.id,className:'dsh-image-name-input',style:labelStyle,autoFocus:true,value:editing.value,spellCheck:false,onPointerDown:function(e){e.stopPropagation()},onChange:function(e){setEditing({id:item.id,value:e.target.value})},onBlur:commitName,onKeyDown:function(e){e.stopPropagation();if(e.key==='Enter')commitName();else if(e.key==='Escape')setEditing(null)}})
        :item.selected
        ?window.React.createElement('div',{key:item.id,className:'dsh-image-name-plain',draggable:true,style:{left:item.left+'px',top:item.top+'px',transform:'translateY(-'+item.offsetY+'px)',fontSize:item.fontSize+'px',lineHeight:1.15,color:'#94a3b8',fontWeight:500,letterSpacing:'.2px',whiteSpace:'nowrap',pointerEvents:'auto',cursor:'grab',textShadow:'0 1px 2px rgba(255,255,255,.55)'},title:'拖到右侧素材库；双击修改文件名：'+item.name,onDragStart:function(e){e.stopPropagation();beginMaterialDrag((api&&api.getAppState&&Object.keys(api.getAppState().selectedElementIds||{}))||[item.id],e);},onDragEnd:function(){post({type:'material-drag-end'});},onDoubleClick:function(e){e.preventDefault();e.stopPropagation();setEditing({id:item.id,value:displayImageName(item.name)})}},(item.fmt?window.React.createElement('span',{className:'dsh-image-tag-dot',style:{background:DSH_FORMAT_TAG_HEX[item.fmt],borderRadius:'2px',width:item.dotSize+'px',height:item.dotSize+'px',borderWidth:item.dotBorder+'px'}}):null),
            (item.tag?window.React.createElement('span',{className:'dsh-image-tag-dot',style:{background:DSH_TAG_HEX[item.tag]||'#888',borderRadius:'50%',width:item.dotSize+'px',height:item.dotSize+'px',borderWidth:item.dotBorder+'px'}}):null),item.displayName)
        :(function(){var csz=item.cornerSize,cbd=item.cornerBorder,ctop=(item.top-Math.round(csz*1.4))+'px';return window.React.createElement(window.React.Fragment,{key:item.id},
            item.fmt?window.React.createElement('span',{className:'dsh-image-tag-corner',style:{left:item.left+'px',top:ctop,width:csz+'px',height:csz+'px',borderWidth:cbd+'px',borderRadius:'2px',background:DSH_FORMAT_TAG_HEX[item.fmt]}}):null,
            item.tag?window.React.createElement('span',{className:'dsh-image-tag-corner',style:{left:(item.left+(item.fmt?Math.round(csz*1.25):0))+'px',top:ctop,width:csz+'px',height:csz+'px',borderWidth:cbd+'px',borderRadius:'50%',background:DSH_TAG_HEX[item.tag]||'#888'}}):null);})();}),toolbar?window.React.createElement('div',{className:'dsh-selection-toolbar',style:{left:toolbar.left+'px',top:toolbar.top+'px'},onPointerDown:function(e){e.preventDefault();e.stopPropagation();},onClick:function(e){e.stopPropagation();}},
        toolbar.count>1?window.React.createElement('span',{className:'dsh-selection-count'},'已选 '+toolbar.count+' 张'):null,
        toolbar.count>1?window.React.createElement('span',{className:'dsh-selection-divider'}):null,
        window.React.createElement('button',{className:'dsh-selection-action dsh-primary',title:'把所选图片附加到聊天输入框',onClick:function(){sendSelectionToChat(toolbar.ids);}},'发送至聊天'),
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'本地 rembg birefnet-general-lite 去除背景；首次使用自动准备环境和模型',onClick:function(){requestBackgroundRemoval(toolbar.ids[0]);}},'去除背景'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'画笔涂抹后智能擦除',onClick:function(){openImageEditor('erase',toolbar.ids[0]);}},'智能擦除'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'不经过主聊天，直接输入图片修改需求',onClick:function(){openImageEditor('edit',toolbar.ids[0]);}},'编辑图片'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action dsh-photoshop',title:'在 Photoshop 中打开链接文件；保存后自动刷新画布',onClick:function(){openInPhotoshop(toolbar.ids[0]);}},'Ps 编辑'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action dsh-illustrator',title:'在 Illustrator 中打开原文件；保存后自动刷新画布',onClick:function(){openInIllustrator(toolbar.ids[0]);}},'AI 编辑'):null,
        window.React.createElement('button',{className:'dsh-selection-action dsh-bridge-ps',title:'返回 Photoshop：直接送回正在运行的 PS——PSD 按图层并入当前文档（文字层可编辑）、其它格式作为图片置入，来自 PS 的内容回到原位；PS 没开时先留在项目 ADOBE桥接/发件箱，打开后在「DSH画布桥接」面板点「并入图层」',onClick:function(){requestBridgeReturn(toolbar.ids,"photoshop");}},'→Ps'),
        window.React.createElement('button',{className:'dsh-selection-action dsh-bridge-ai',title:'返回 Illustrator：直接送回正在运行的 AI——.ai/.svg 按对象并入当前文档（文字可编辑）、其它格式作为图片置入，来自 AI 的内容回到原位；AI 没开时先留在项目 ADOBE桥接/发件箱',onClick:function(){requestBridgeReturn(toolbar.ids,"illustrator");}},'→Ai'),
        toolbar.count===1&&["image","psd"].indexOf(toolbar.singleKind||"image")>=0?window.React.createElement('button',{className:'dsh-selection-action dsh-text-rebuild-action',title:'框选后由当前聊天模型理解文字，并生成可在 Photoshop 中继续编辑的 PSD',onClick:function(){requestTextRebuild(toolbar.ids[0]);}},'编辑文字'):null,
        window.React.createElement('div',{className:'dsh-selection-more'},
          window.React.createElement('button',{className:'dsh-selection-action dsh-more-toggle',title:'更多操作',onClick:function(e){e.stopPropagation();setMoreOpen(!moreOpen);}},'更多 ▾'),
          moreOpen?window.React.createElement('div',{className:'dsh-selection-menu',onClick:function(e){e.stopPropagation();setMoreOpen(false);}},
            window.React.createElement('div',{className:'dsh-tag-palette',title:'Mac 式颜色标记：整理画布时可按颜色筛选',onClick:function(e){e.stopPropagation();}},
              window.React.createElement('span',{style:{color:'#94a3b8',font:'600 11px/1 ui-rounded,"SF Pro Rounded",sans-serif',whiteSpace:'nowrap'}},'标记'),
              Object.keys(DSH_TAG_HEX).map(function(color){return window.React.createElement('button',{key:color,className:'dsh-tag-dot-btn',style:{background:DSH_TAG_HEX[color]},title:'把选中的 '+toolbar.count+' 张图片标记为该颜色',onClick:function(e){e.stopPropagation();setCanvasImageTag(toolbar.ids,color);setMoreOpen(false);}});}),
              window.React.createElement('button',{className:'dsh-selection-action',style:{height:'22px',fontSize:'11px',lineHeight:'22px'},title:'清除选中图片的颜色标记',onClick:function(e){e.stopPropagation();setCanvasImageTag(toolbar.ids,'');setMoreOpen(false);}},'清除')
            ),
            window.React.createElement('button',{className:'dsh-selection-action dsh-material-drag-action',draggable:true,title:'点击保存；也可按住拖到右侧素材库',onDragStart:function(e){e.stopPropagation();beginMaterialDrag(toolbar.ids,e);},onDragEnd:function(){post({type:'material-drag-end'});},onClick:function(){saveSelectionToMaterials(toolbar.ids);}},'加入素材库'),
            toolbar.count===1&&["image","psd"].indexOf(toolbar.singleKind||"image")>=0?window.React.createElement('button',{className:'dsh-selection-action',title:'扁平稿专用：限色、去毛刺后生成结构化 SVG，原图不会被覆盖',onClick:function(){requestVectorize(toolbar.ids[0],"flat");}},'结构矢量'):null,
            window.React.createElement('button',{className:'dsh-selection-action',title:'在画布中创建副本',onClick:function(){duplicateSelectedImages(toolbar.ids);}},'复制'),
            toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'修改图片文件名（不显示扩展名）',onClick:function(){setEditing({id:toolbar.ids[0],value:displayImageName(toolbar.singleName)});}},'重命名'):null,
            window.React.createElement('button',{className:'dsh-selection-action dsh-danger',title:'移入画布回收站，可撤销',onClick:function(){deleteSelectedImages(toolbar.ids);}},'删除'),
          ):null
        ),
      ):null),
      imageEditor?window.React.createElement(ImageEditDialog,{item:imageEditor,onClose:function(){if(!imageEditor.busy)setImageEditor(null);},onSubmit:submitImageEdit}):null
    );
  }
  root.render(window.React.createElement(Main));
  function hideImageInsertionTool(){document.querySelectorAll('[data-testid="toolbar-image"],[aria-label="插入图像"],[aria-label="Insert image"],[title^="插入图像"]').forEach(function(node){node.style.display='none';node.setAttribute('aria-hidden','true');var parent=node.parentElement;if(parent&&parent.children.length<=2&&String(parent.textContent||'').indexOf('插入图像')>=0){parent.style.display='none';}});}
  hideImageInsertionTool();
  if(window.MutationObserver) new MutationObserver(hideImageInsertionTool).observe(document.body,{childList:true,subtree:true});
// 外部拖入是用户明确操作，允许加入；agent 扫描/目录轮询不会触发这里。
// 栅格图自动等比压缩后上板，SVG/PDF/AI 交给宿主复制到项目 assets。
function blobToDataURL(blob){return new Promise(function(resolve,reject){var reader=new FileReader();reader.onload=function(){resolve(reader.result)};reader.onerror=reject;reader.readAsDataURL(blob);});}
function canvasBlob(canvas,quality){return new Promise(function(resolve,reject){canvas.toBlob(function(blob){if(blob)resolve(blob);else reject(new Error("图片压缩失败"));},"image/webp",quality);});}
function prepareExternalImage(file){
  return new Promise(function(resolve,reject){
    var url=URL.createObjectURL(file),img=new Image();
    img.onload=async function(){
      try{
        var originalW=img.naturalWidth||1,originalH=img.naturalHeight||1,maxSide=3200;
        if(file.size<=1887436&&Math.max(originalW,originalH)<=maxSide){resolve({dataURL:await blobToDataURL(file),dm:{w:originalW,h:originalH},before:file.size,after:file.size});return;}
        var scale=Math.min(1,maxSide/Math.max(originalW,originalH)),w=Math.max(1,Math.round(originalW*scale)),h=Math.max(1,Math.round(originalH*scale));
        var blob=null,quality=.9;
        for(var attempt=0;attempt<8;attempt+=1){
          var canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
          var context=canvas.getContext("2d",{alpha:true});context.drawImage(img,0,0,w,h);
          blob=await canvasBlob(canvas,quality);
          if(blob.size<=1887436)break;
          if(quality>.58)quality-=.1;else{w=Math.max(1,Math.round(w*.82));h=Math.max(1,Math.round(h*.82));}
        }
        if(!blob||blob.size>2097152)throw new Error("图片压缩后仍超过 2MB，请先缩小像素尺寸");
        resolve({dataURL:await blobToDataURL(blob),dm:{w:w,h:h},before:file.size,after:blob.size});
      }catch(err){reject(err)}finally{URL.revokeObjectURL(url)}
    };
    img.onerror=function(){URL.revokeObjectURL(url);reject(new Error("无法读取拖入的图片"));};img.src=url;
  });
}
function uniqueExternalFiles(list){var seen=new Set();return list.filter(function(file){var key=[file.name||"",file.size||0,file.lastModified||0,file.type||""].join("|");if(seen.has(key))return false;seen.add(key);return true;});}
function externalFileKind(file){var name=String(file&&file.name||"");if(!name||name.charAt(0)==="."||name.slice(0,2)==="._")return"";var m=/\.([a-z0-9]+)$/i.exec(name),ext=m?m[1].toLowerCase():"",mime=String(file&&file.type||"").toLowerCase();if(ext==="psd"||mime==="image/vnd.adobe.photoshop")return"psd";if(ext==="svg")return"svg";if(ext==="pdf")return"pdf";if(ext==="ai")return"ai";if(["png","jpg","jpeg","webp","gif","avif","bmp"].indexOf(ext)>=0||(mime.indexOf("image/")===0&&mime!=="image/vnd.adobe.photoshop"))return"image";return"";}
function isSupportedExternalFile(file){return !!externalFileKind(file);}
function transferHas(dt,type){return Array.prototype.indexOf.call(dt&&dt.types||[],type)>=0;}
window.addEventListener("dragover",function(e){var files=e.dataTransfer&&e.dataTransfer.files;if((files&&Array.prototype.some.call(files,isSupportedExternalFile))||transferHas(e.dataTransfer,"application/x-dsh-material")){e.preventDefault();e.stopImmediatePropagation();e.dataTransfer.dropEffect="copy";}},true);
window.addEventListener("drop",function(e){
  var materialRaw=e.dataTransfer&&e.dataTransfer.getData("application/x-dsh-material");
  if(materialRaw){e.preventDefault();e.stopImmediatePropagation();try{var material=JSON.parse(materialRaw);if(!material||!material.url)throw new Error("素材数据无效");insertChain=insertChain.catch(function(){}).then(function(){return fetch(material.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取素材失败 HTTP "+r.status);return r.blob();}).then(blobToDataURL).then(function(dataURL){return dims2(dataURL).then(function(dm){addImageDataURL(dataURL,dm,{name:material.name||"素材.png",path:material.path||"",size:Number(material.size||0),managed:false,dropClientX:e.clientX,dropClientY:e.clientY});});});}).catch(function(err){post({type:"error",message:"素材拖入画布失败: "+String(err&&err.message||err)});});}catch(err){post({type:"error",message:"素材拖入画布失败: "+String(err&&err.message||err)});}return;}
  var files=e.dataTransfer&&e.dataTransfer.files?uniqueExternalFiles(Array.from(e.dataTransfer.files).filter(isSupportedExternalFile)):[];
  if(!files.length)return;e.preventDefault();e.stopImmediatePropagation();
  insertChain=insertChain.catch(function(){}).then(async function(){
    for(var i=0;i<files.length;i+=1){var file=files[i],kind=externalFileKind(file);if(kind==="image"){var prepared=await prepareExternalImage(file);addImageDataURL(prepared.dataURL,prepared.dm,{name:file.name,path:"",externalDrop:true});}else{var sourcePath=typeof file.path==="string"?file.path:"",dataURL=sourcePath?"":await blobToDataURL(file);parent.postMessage({type:"import-external-file",explicit:true,sourcePath:sourcePath,name:file.name,kind:kind,dataURL:dataURL},"*");}}
  }).catch(function(err){post({type:"error",message:"拖入文件失败: "+String(err&&err.message||err)});});
},true);
window.addEventListener("paste",function(e){
  var items=e.clipboardData&&e.clipboardData.items?Array.from(e.clipboardData.items):[];
  var files=uniqueExternalFiles(items.map(function(item){return item&&typeof item.getAsFile==="function"?item.getAsFile():null;}).filter(function(file){return file&&String(file.type||"").indexOf("image/")===0;}));
  if(!files.length)return;e.preventDefault();e.stopImmediatePropagation();
  insertChain=insertChain.catch(function(){}).then(async function(){
    for(var i=0;i<files.length;i+=1){var file=files[i],prepared=await prepareExternalImage(file);addImageDataURL(prepared.dataURL,prepared.dm,{name:file.name||("剪贴板图片-"+(i+1)+".png"),path:"",externalDrop:true});}
  }).catch(function(err){post({type:"error",message:"粘贴图片失败: "+String(err&&err.message||err)});});
},true);
// 聊天/工具结果回板必须复用统一的 Excalidraw 0.17 图片创建逻辑。
// capture + stopImmediatePropagation 用于拦截下方遗留的旧 add-image 分支，
// 避免缺少 status/scale/created 等字段的元素进入场景后触发持续重绘。
window.addEventListener("message",function(e){
  if(e.source!==window.parent)return;
  var d=e.data||{};
  if(d.type==="snapshot-request"){
    e.stopImmediatePropagation();
    try{post({type:"snapshot-response",requestId:d.requestId,snapshot:api?serialize(api.getSceneElements()||[],api.getAppState()||empty,api.getFiles()||new Map()):null});}
    catch(err){post({type:"snapshot-response",requestId:d.requestId,snapshot:null});}
    return;
  }
  if(d.type==="load"){
    e.stopImmediatePropagation();
    var hydrateFromDisk=async function(){
      try{
        /* 场景令牌：换场景时先取消防抖中迟到 changed 并刷新令牌，
           上一个项目的挂起 changed 即使已触发也会因 token 不匹配被父层丢弃 */
        window.__dshSceneToken=(typeof d.token==="string"&&d.token)?d.token:("t"+Date.now()+"_"+Math.random().toString(36).slice(2,8));
        if(window.__dshCancelPendingChanged)window.__dshCancelPendingChanged();
        var saved=typeof d.snapshot==="string"?JSON.parse(d.snapshot):d.snapshot;
        if(!saved||!saved.elements||typeof requestSceneLoad!=="function")return;
        /* 性能 v3：磁盘快照的 files 只带 dshPath 引用（无 dataURL），这里
           并发还原为 dataURL 后再进 requestSceneLoad；单文件失败静默跳过，
           画布上表现为占位，不影响其余图片与场景结构。 */
        var jobs=[];
        if(saved.files)Object.keys(saved.files).forEach(function(k){
          var v=saved.files[k];
          if(v&&!v.dataURL&&v.dshPath){
            jobs.push(fetch("/dsh-canvas/image?path="+encodeURIComponent(v.dshPath)).then(function(r){
              if(!r.ok)throw new Error("fetch "+r.status);
              return r.blob();
            }).then(function(b){
              return new Promise(function(res){
                var fr=new FileReader();
                fr.onload=function(){res(fr.result)};
                fr.onerror=function(){res(null)};
                fr.readAsDataURL(b);
              });
            }).then(function(url){
              if(url){v.dataURL=url;var m=String(url).match(/^data:([^;]+)/i);if(m&&!v.mimeType)v.mimeType=m[1];}
            }).catch(function(err){post({type:"error",message:"画布图片还原失败("+String((err&&err.message)||err).slice(0,80)+")，已保留占位"});}));
          }
        });
        if(jobs.length)await Promise.all(jobs);
        requestSceneLoad(saved);
      }catch(err){post({type:"error",message:"恢复画布失败: "+String(err&&err.message||err)});}
    };
    hydrateFromDisk();
    return;
  }
  if(d.type==="refresh-source"){
    e.stopImmediatePropagation();
    refreshSourceImage(d).catch(function(err){post({type:"error",message:"源图片刷新失败: "+String(err&&err.message||err)});});
    return;
  }
  if(d.type==="rename-result"){
    e.stopImmediatePropagation();
    if(api&&d.id){var renamed=(api.getSceneElements()||[]).map(function(item){if(!item||item.id!==d.id)return item;return Object.assign({},item,{customData:Object.assign({},item.customData||{},{dshFileName:d.name||item.customData&&item.customData.dshFileName,dshSourcePath:d.sourcePath||item.customData&&item.customData.dshSourcePath}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:Date.now()});});api.updateScene({elements:renamed,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});}
    return;
  }
  if(d.type==="bind-managed"){
    e.stopImmediatePropagation();bindManagedImage(d);return;
  }
  if(d.type==="remove-sources"){
    e.stopImmediatePropagation();removeSourceElements(d.ids||[]);return;
  }
  if(d.type==="placeholder-progress"){
    e.stopImmediatePropagation();var pid=String(d.placeholderId||"");if(pid){pendingProgress[pid]={percent:d.percent,stage:d.stage,message:d.message};if(typeof bumpPending==="function")bumpPending();}return;
  }
  if(d.type==="arrange-images"){
    e.stopImmediatePropagation();arrangeCanvasImages(d);return;
  }
  if(d.type==="set-theme-background"){
    e.stopImmediatePropagation();
    // DSH 主题推送：画布背景与 Excalidraw 内部 UI 主题跟随 DSH（而非系统外观）。
    var nextColor=String(d.color||"");
    if(!/^(#[0-9a-f]{3,8}|rgb)/i.test(nextColor))return;
    systemDark=!!d.dark;canvasDefaultBackground=nextColor;
    // srcdoc 的 html/body/.excalidraw-container 链式背景用 --dsh-bg 变量渲染，
    // 只改 viewBackgroundColor 不够——那些 CSS 背景会把整个 iframe 涂黑。
    // fg/surface/line/hover 同时供给选区工具栏等 iframe 内 UI 跟随 DSH 主题；
    // 空值不设置，让 CSS 兜底值生效。
    try{
      var rootStyle=document.documentElement.style;
      rootStyle.setProperty("--dsh-bg",nextColor);
      var fgColor=String(d.fg||"");
      if(!fgColor)fgColor=d.dark?"#f8fafc":"#1f2937";
      rootStyle.setProperty("--dsh-fg",fgColor);
      rootStyle.setProperty("--dsh-fg-muted",fgColor);
      if(d.surface)rootStyle.setProperty("--dsh-surface",String(d.surface));
      if(d.line)rootStyle.setProperty("--dsh-line",String(d.line));
      if(d.hover)rootStyle.setProperty("--dsh-hover",String(d.hover));
      rootStyle.colorScheme=d.dark?"dark":"light";
    }catch(cssErr){}
    if(api&&typeof api.updateScene==="function"){
      try{api.updateScene({appState:Object.assign({},api.getAppState()||empty,{viewBackgroundColor:nextColor,theme:d.dark?"dark":"light"}),commitToHistory:false});}catch(themeErr){}
    }
    return;
  }
  if(d.type==="image-edit-result"){
    e.stopImmediatePropagation();addEditedImage(d).catch(function(err){markEditPlaceholderFailed({requestId:d.requestId,placeholderId:d.placeholderId,message:String(err&&err.message||err)});});return;
  }
  if(d.type==="image-remove-bg-result"){
    e.stopImmediatePropagation();addBackgroundRemovedImage(d).catch(function(err){markEditPlaceholderFailed({requestId:d.requestId,placeholderId:d.placeholderId,message:String(err&&err.message||err)});});return;
  }
  if(d.type==="image-vectorized-result"){
    e.stopImmediatePropagation();addVectorizedImage(d).catch(function(err){post({type:"error",message:"加入矢量结果失败: "+String(err&&err.message||err)});});return;
  }
  if(d.type==="image-edit-error"){
    e.stopImmediatePropagation();if(!reopenFailedImageEdit(d))markEditPlaceholderFailed(d);return;
  }
  if(d.type==="image-remove-bg-error"){
    e.stopImmediatePropagation();markEditPlaceholderFailed(d);return;
  }
  if(d.type!=="add-image"||!d.url)return;
  e.stopImmediatePropagation();
  if(d.explicit!==true){post({type:"error",message:"已忽略非用户发起的图片加入请求"});return;}
  if(!api){post({type:"error",message:"添加图片失败: 画布尚未就绪"});return;}
  insertChain=insertChain.catch(function(){}).then(function(){return toDataURL(d.url).then(function(dataURL){
    return dims2(dataURL).then(function(dm){addImageDataURL(dataURL,dm,{name:d.name||baseName2(d.path||""),path:d.path||"",mtime:d.mtime||0,size:d.size||0,kind:d.kind||"image",managed:d.managed,batchIndex:d.batchIndex,batchTotal:d.batchTotal,batchColumns:d.batchColumns,customData:d.customData||null,openEditor:d.openEditor===true,editorMode:"edit"});});
  });}).catch(function(err){post({type:"error",message:"添加图片失败: "+String(err&&err.message||err)});});
},true);
var toDataURL=function(u){return fetch(u).then(function(r){return r.blob()}).then(function(b){return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(b)})})};var dims=function(d){return new Promise(function(res){var i=new Image();i.onload=function(){res({w:i.naturalWidth,h:i.naturalHeight})};i.onerror=function(){res({w:200,h:130})};i.src=d})};window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data||{};try{if(d.type==="chat-gen-placeholder"&&d.id){if(!api){post({type:"chat-gen-placeholder-deferred",id:d.id});return}try{createChatPlaceholder(d)}catch(err){post({type:"chat-gen-soft-error",message:"生成占位未创建: "+String(err&&err.message||err)})}return}if(d.type==="chat-gen-resolve"&&d.id&&d.url&&api){resolveChatPlaceholder(d).catch(function(err){post({type:"chat-gen-resolve-failed",id:d.id,url:d.url,path:d.path||"",name:d.name||"",message:String(err&&err.message||err)});post({type:"chat-gen-soft-error",message:"生成图未上画布: "+String(err&&err.message||err)})});return}if(d.type==="chat-gen-fail"&&d.id&&api){try{failChatPlaceholder(d)}catch(err){}return}if(d.type==="add-image"&&d.url&&api){toDataURL(d.url).then(function(dataURL){return dims(dataURL).then(function(dm){var fileId="f_"+Math.random().toString(36).slice(2,9);var ratio=(dm.w&&dm.h&&dm.h>0)?dm.w/dm.h:1.6;var w=220,h=Math.round(w/ratio);var mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png";var el={type:"image",id:"e_"+Math.random().toString(36).slice(2,9),fileId:fileId,x:150,y:150,width:w,height:h,angle:0,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),isDeleted:false,groupIds:[],boundElements:null,updated:Date.now(),link:null,locked:false,customData:d.customData||null,roundness:null,mimeType:mime};var files=(function(){var m=new Map();var b=api.getFiles()||{};if(typeof b.forEach==="function"){b.forEach(function(v,k){m.set(k,v)});}else if(typeof b==="object"){Object.keys(b).forEach(function(k){m.set(k,b[k])});}return m;})();if(typeof api.addFiles==="function"){try{api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime}])}catch(e){}}api.updateScene({elements:(api.getSceneElements()||[]).concat([el]),appState:Object.assign({},api.getAppState()||empty)});post({type:"added"});if(d.openEditor&&d.customData&&d.customData.dshLayerEdit&&typeof openImageEditorById==="function"){setTimeout(function(){openImageEditorById("edit",el.id);},160);}})}).catch(function(err){post({type:"error",message:"添加图片失败: "+String(err&&err.message||err)})})}else if(d.type==="load"&&api){var s=typeof d.snapshot==="string"?JSON.parse(d.snapshot):d.snapshot;if(s&&s.elements){var files=new Map();if(s.files)Object.keys(s.files).forEach(function(k){var v=s.files[k];files.set(k,{id:k,dataURL:v.dataURL,mimeType:v.mimeType})});api.updateScene({elements:s.elements,appState:Object.assign({},s.appState||empty),files:files})}}else if(d.type==="export"&&api){var elements=(api.getSceneElements()||[]).filter(function(item){return item&&!item.isDeleted&&item.id!=="dsh_theme_backdrop";});if(!elements.length){post({type:"exported",error:"empty"});return;}var exporter=window.ExcalidrawLib&&window.ExcalidrawLib.exportToBlob;if(typeof exporter!=="function"){post({type:"error",message:"导出失败: 当前 Excalidraw 未提供 PNG 导出器"});return;}var state=Object.assign({},api.getAppState()||empty,{exportBackground:true,exportWithDarkMode:false,exportScale:1});Promise.resolve(exporter({elements:elements,appState:state,files:fileObject(api.getFiles?api.getFiles():{}),mimeType:"image/png"})).then(function(blob){var fr=new FileReader();fr.onloadend=function(){post({type:"exported",dataUrl:fr.result})};fr.onerror=function(){post({type:"error",message:"导出失败: 无法读取 PNG 数据"})};fr.readAsDataURL(blob)}).catch(function(err){post({type:"error",message:"导出失败: "+String(err&&err.message||err)})})}else if(d.type==="clear"&&api){api.updateScene({elements:[],appState:empty,files:new Map()});post({type:"changed",snapshot:serialize([],empty,new Map()),token:window.__dshSceneToken||""})}}catch(err){post({type:"error",message:String(err&&err.message||err)})}});})();</script></body></html>`;
