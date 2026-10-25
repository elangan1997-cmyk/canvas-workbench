import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const token = () => randomBytes(10).toString('hex');
const empty = () => ({ elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} });

export async function readAutomationCanvas(project) {
  try {
    const file = join(project, 'canvas.json');
    if ((await stat(file)).size > 128 * 1024 * 1024) throw new Error('画布记录过大，请先在工作台保存为新版项目');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(value.elements)) throw new Error('画布记录损坏');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
}

/** Share the UI's per-project write queue, always merge against the latest revision. */
export async function mutateAutomationCanvas(h, project, mutate) {
  const file = join(project, 'canvas.json');
  const pending = (h.stateWriteChains.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const value = await readAutomationCanvas(project);
    const before = Number(value.dshMeta?.revision || value.dshMeta?.savedAt || 0);
    await mutate(value);
    const revision = Math.max(Date.now(), before + 1);
    value.dshMeta = { ...value.dshMeta, baseRevision: before, revision, savedAt: revision, clientId: 'canvas-workbench-automation' };
    await mkdir(join(project, 'assets'), { recursive: true });
    await mkdir(join(project, 'outputs'), { recursive: true });
    const temporary = file + '.automation-' + token();
    await writeFile(temporary, JSON.stringify(value), 'utf8'); await rename(temporary, file);
    let metadata = {};
    try { metadata = JSON.parse(await readFile(join(project, 'project.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(join(project, 'project.json'), JSON.stringify({ ...metadata, version: metadata.version || 1, canvas: 'canvas.json', assets: 'assets', outputs: 'outputs', updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    return value;
  });
  h.stateWriteChains.set(file, pending.catch(() => {}));
  return pending;
}

export function summarizeAutomationCanvas(value) {
  const selected = value.appState?.selectedElementIds || {};
  return { revision: Number(value.dshMeta?.revision || 0),
    elements: value.elements.filter(e => e && !e.isDeleted).map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height,
      angle: e.angle || 0, opacity: e.opacity ?? 100, selected: selected[e.id] === true, name: e.customData?.dshFileName || '',
      path: e.customData?.dshSourcePath || value.files?.[e.fileId]?.dshPath || '' })) };
}

export async function appendAutomationOutputs(h, project, outputs, jobId) {
  return mutateAutomationCanvas(h, project, scene => {
    scene.files ||= {};
    const paths = new Set(scene.elements.filter(e => !e.isDeleted).map(e => e.customData?.dshSourcePath));
    const columns = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(outputs.length * 1.35))));
    const now = Date.now(); let index = scene.elements.filter(e => !e.isDeleted).length;
    for (const output of outputs) {
      if (paths.has(output.path)) continue;
      const id = 'auto_' + token(), fileId = 'file_' + token(), ratio = Number(output.width) / Number(output.height);
      const replacement=output.replacePath?scene.elements.find(e=>!e.isDeleted&&e.customData?.dshAutomationJobId===jobId&&e.customData?.dshSourcePath===output.replacePath):null;
      const width = ratio > 1 ? 240 : 240 * (ratio || .75), height = ratio > 1 ? 240 / ratio : 240;
      const e = { id, type: 'image', fileId, x: 80 + (index % columns) * 300, y: 80 + Math.floor(index / columns) * 310,
        width, height, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
        roughness: 0, opacity: 100, seed: Math.floor(Math.random() * 2147483647), version: 1, versionNonce: Math.floor(Math.random() * 2147483647),
        isDeleted: false, groupIds: [], frameId: null, boundElements: null, updated: now, created: now, link: null, locked: false, roundness: null,
        status: 'saved', scale: [1, 1], crop: null, customData: { dshSourcePath: output.path, dshFileName: output.name || basename(output.path),
          dshSourceKind: output.kind || 'image', dshManaged: true, dshMtime: output.mtime || now, dshAutomationJobId: jobId,...(output.sourceItemId?{dshAutomationItemId:output.sourceItemId}:{}) } };
      if(replacement){
        const previousFileId=replacement.fileId;
        Object.assign(replacement,{fileId,customData:{...replacement.customData,...e.customData},updated:now,version:(replacement.version||0)+1,versionNonce:e.versionNonce});
        if(!scene.elements.some(item=>item!==replacement&&!item.isDeleted&&item.fileId===previousFileId))delete scene.files[previousFileId];
      }else scene.elements.push(e);
      scene.files[fileId] = { id: fileId, mimeType: 'image/png', dshPath: output.path, created: now, lastRetrieved: now };
      paths.add(output.path); index++;
    }
  });
}

export async function patchAutomationCanvas(h, project, patches, baseRevision) {
  if (!Array.isArray(patches) || !patches.length || patches.length > 500) throw new Error('一次请指定1至500个画布对象');
  return mutateAutomationCanvas(h, project, scene => {
    if (baseRevision !== undefined && Number(baseRevision) !== Number(scene.dshMeta?.revision || 0)) throw new Error('画布已被修改，请重新读取对象后再调整');
    const seen = new Set();
    for (const patch of patches) {
      if (!patch || seen.has(patch.id)) throw new Error('对象ID无效或重复'); seen.add(patch.id);
      const e = scene.elements.find(e => !e.isDeleted && e.id === patch.id);
      if (!e) throw new Error('画布对象不存在：' + patch.id);
      const values = {};
      for (const key of ['x', 'y', 'width', 'height', 'angle', 'opacity']) if (patch[key] !== undefined) {
        const v = Number(patch[key]);
        if (!Number.isFinite(v) || Math.abs(v) > 1e7 || (['width', 'height'].includes(key) && v <= 0) || (key === 'opacity' && (v < 0 || v > 100))) throw new Error('对象尺寸或位置无效：' + key);
        values[key] = v;
      }
      Object.assign(e, values, { version: (Number(e.version) || 0) + 1, updated: Date.now(), versionNonce: Math.floor(Math.random() * 2147483647) });
    }
  });
}
