import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const overlay = await readFile(new URL('../../src/client/app/02-CanvasOverlay.js', import.meta.url), 'utf8');
const layout = await readFile(new URL('../../src/client/app/01-layout.js', import.meta.url), 'utf8');
const helper = layout.slice(layout.indexOf('function canvasPathWithin('), layout.indexOf('\n    }', layout.indexOf('function canvasPathWithin(')) + 6);
const filters = overlay.slice(overlay.indexOf('const isLayeredOutput ='), overlay.indexOf('const sourcePaths ='));

test('explicit layered exports survive a project scan that excludes outputs and use direct source checks on Mac and Windows', () => {
  for (const root of ['/project/中文画布', 'C:\\Projects\\中文画布']) {
    const paths = [root + '/assets/original.png', root + '/outputs/图片拆层/layers-test/design.ai', '/external/design.psd'];
    const context = vm.createContext({projectRoot:root,liveImages:paths.map(path => ({customData:{dshSourcePath:path}}))});
    const result = vm.runInContext(helper + '\n' + filters + '\n({scan:sourceElements.map(e=>e.customData.dshSourcePath),direct:externalSourceElements.map(e=>e.customData.dshSourcePath)})',context);
    assert.deepEqual(Array.from(result.scan),[paths[0]]);
    assert.deepEqual(Array.from(result.direct),paths.slice(1));
  }
});
