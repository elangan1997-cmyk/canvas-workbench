// 图像引擎设置与旧版 API 凭据存储（自 lib/image-engine.js 逐字迁移，v1.8 Phase 3）。
// API Key 只落在本机 ~/.codex-pixel/auth.json（0600），绝不进入项目、前端、日志或 Git（执行文档禁止 9）。
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_API_BASE_URL = 'https://ai-pixel.online';
export const DEFAULT_API_MODEL = 'gpt-image-2';
const ENGINE_VALUES = new Set(['dsh-codex', 'api']);

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function imageEngineSettingsPath() {
  return join(dshHome(), 'canvas-workbench', 'image-engine.json');
}

/** image2 网关支持的生图尺寸(gpt-image 系);auto = 不传 size,由服务端决定。 */
export const IMAGE_SIZE_VALUES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536', '1280x960', '960x1280', '1920x1080', '1080x1920', '2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840']);
export function normalizeImageSize(value) {
  return IMAGE_SIZE_VALUES.has(String(value || '').trim()) ? String(value || '').trim() : 'auto';
}

export function normalizeImageEngine(value) {
  return ENGINE_VALUES.has(String(value || '').trim()) ? String(value).trim() : 'dsh-codex';
}

export function normalizeApiBaseUrl(value, fallback = DEFAULT_API_BASE_URL) {
  const clean = String(value || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  return clean || fallback;
}

export async function readImageEngineSettings() {
  const defaults = { engine: 'dsh-codex', apiBaseUrl: DEFAULT_API_BASE_URL, apiModel: DEFAULT_API_MODEL, imageSize: 'auto' };
  try {
    const parsed = JSON.parse(await readFile(imageEngineSettingsPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaults;
    return {
      ...defaults,
      ...parsed,
      engine: normalizeImageEngine(parsed.engine),
      apiBaseUrl: normalizeApiBaseUrl(parsed.apiBaseUrl, defaults.apiBaseUrl),
      apiModel: String(parsed.apiModel || defaults.apiModel).trim() || defaults.apiModel,
      imageSize: normalizeImageSize(parsed.imageSize),
    };
  } catch {
    return defaults;
  }
}

export async function writeImageEngineSettings(patch = {}) {
  const current = await readImageEngineSettings();
  const next = {
    ...current,
    ...patch,
    engine: normalizeImageEngine(patch.engine ?? current.engine),
    apiBaseUrl: normalizeApiBaseUrl(patch.apiBaseUrl ?? current.apiBaseUrl),
    apiModel: String(patch.apiModel ?? current.apiModel).trim() || DEFAULT_API_MODEL,
    imageSize: normalizeImageSize(patch.imageSize ?? current.imageSize),
  };
  const filename = imageEngineSettingsPath();
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

function collectApiValue(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const name of names) if (typeof value[name] === 'string' && value[name].trim()) return value[name].trim();
  return '';
}

export function legacyApiAuthPath() {
  return join(homedir(), '.codex-pixel', 'auth.json');
}

export async function readLegacyApiAuth() {
  const filename = legacyApiAuthPath();
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'));
    const apiKey = collectApiValue(value, ['OPENAI_API_KEY', 'apiKey', 'api_key', 'token', 'key'])
      || collectApiValue(value.credentials, ['OPENAI_API_KEY', 'apiKey', 'api_key', 'token', 'key']);
    const baseUrl = collectApiValue(value, ['OPENAI_BASE_URL', 'BASE_URL', 'baseUrl', 'base_url']);
    return { filename, configured: Boolean(apiKey), apiKey, baseUrl };
  } catch {
    return { filename, configured: false, apiKey: '', baseUrl: '' };
  }
}

export async function writeLegacyApiAuth({ apiKey, baseUrl, clear = false } = {}) {
  const filename = legacyApiAuthPath();
  let current = {};
  try {
    const parsed = JSON.parse(await readFile(filename, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch {}
  const next = { ...current };
  const cleanKey = String(apiKey || '').trim();
  const cleanBase = normalizeApiBaseUrl(baseUrl, '');
  if (clear) {
    for (const key of ['OPENAI_API_KEY', 'apiKey', 'api_key', 'token', 'key']) delete next[key];
    if (next.credentials && typeof next.credentials === 'object') {
      next.credentials = { ...next.credentials };
      for (const key of ['OPENAI_API_KEY', 'apiKey', 'api_key', 'token', 'key']) delete next.credentials[key];
    }
  } else if (cleanKey) {
    next.OPENAI_API_KEY = cleanKey;
  }
  if (cleanBase) next.OPENAI_BASE_URL = cleanBase;
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filename, 0o600).catch(() => {});
  return { filename, configured: Boolean(collectApiValue(next, ['OPENAI_API_KEY', 'apiKey', 'api_key', 'token', 'key']) || collectApiValue(next.credentials, ['OPENAI_API_KEY', 'apiKey', 'api_key', 'token', 'key'])) };
}

export function effectiveApiBase(settings, auth) {
  const configuredBase = String(settings.apiBaseUrl || '').trim();
  return normalizeApiBaseUrl(configuredBase && configuredBase !== DEFAULT_API_BASE_URL
    ? configuredBase
    : (auth.baseUrl || configuredBase || DEFAULT_API_BASE_URL));
}
