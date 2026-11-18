import type { PlacedPanel, RoomConfig, TargetGoalId } from '../acoustics/types';
import {
  errorMessage, identifier, MAX_DESIGNS, MAX_PAYLOAD_CHARS, record, text,
  validateGoal, validatePanels, validateRoom,
} from './validation';

export interface SavedDesign {
  id: string;
  name: string;
  createdAt: string;
  room: RoomConfig;
  panels: PlacedPanel[];
  goalId: TargetGoalId;
  planId?: string;
}

export const DESIGN_STORAGE_KEY = 'room-acoustics-studio:design-library:v1';
export const DESIGN_SCHEMA_VERSION = 1;
export const MAX_SAVED_DESIGNS = MAX_DESIGNS;

function validateDesign(value: unknown): SavedDesign {
  const d = record(value, '方案');
  const id = identifier(d.id, '方案ID');
  const name = text(d.name, '方案名称');
  const createdAt = text(d.createdAt, '保存日期');
  const date = new Date(createdAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
    || !Number.isFinite(date.getTime()) || date.toISOString() !== createdAt) {
    throw new Error('保存日期必须为合法ISO时间');
  }
  const room = validateRoom(d.room);
  const panels = validatePanels(d.panels, room);
  const goalId = validateGoal(d.goalId);
  const planId = d.planId === undefined ? undefined : identifier(d.planId, '方案阶段ID');
  // Whitelist fields instead of persisting workspace/audio state or unknown properties.
  return { id, name, createdAt, room, panels, goalId, ...(planId === undefined ? {} : { planId }) };
}

function validateDesigns(value: unknown): SavedDesign[] {
  if (!Array.isArray(value) || value.length > MAX_DESIGNS) throw new Error(`方案库必须为数组，且最多保存${MAX_DESIGNS}个快照`);
  const ids = new Set<string>();
  return Array.from(value, item => {
    const design = validateDesign(item);
    if (ids.has(design.id)) throw new Error('方案库中存在重复ID');
    ids.add(design.id);
    return design;
  });
}

function decode(raw: string): SavedDesign[] {
  if (raw.length > MAX_PAYLOAD_CHARS) throw new Error('本地方案库数据过大，请先备份并检查原始数据');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('本地方案库JSON损坏，原始数据已保留'); }
  const envelope = record(parsed, '方案库');
  if (envelope.schemaVersion !== DESIGN_SCHEMA_VERSION) throw new Error('本地方案库版本未知，不能读取或覆盖，请先备份原始数据');
  return validateDesigns(envelope.designs);
}

function storage(): Storage {
  const result = globalThis.localStorage;
  if (!result || typeof result.getItem !== 'function' || typeof result.setItem !== 'function') {
    throw new Error('localStorage不可用，无法访问本地方案库');
  }
  return result;
}

function storageError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return 'localStorage空间不足（quota），请释放空间后重试';
  }
  if (name === 'SecurityError') return '浏览器禁止存储或访问localStorage，请检查隐私/权限设置';
  return errorMessage(error);
}

/** Errors (including unavailable storage/corrupt data) are returned, never silently repaired. */
export function loadDesigns(): { designs: SavedDesign[]; error?: string } {
  try {
    const raw = storage().getItem(DESIGN_STORAGE_KEY);
    return { designs: raw === null ? [] : decode(raw) };
  } catch (error) {
    return { designs: [], error: `读取方案库失败：${storageError(error)}` };
  }
}

/** Explicit manual persistence only. Existing unreadable/future-version data is not overwritten. */
export function saveDesigns(designs: SavedDesign[]): { ok: boolean; error?: string } {
  try {
    const copies = validateDesigns(designs);
    const raw = JSON.stringify({ schemaVersion: DESIGN_SCHEMA_VERSION, designs: copies });
    if (raw.length > MAX_PAYLOAD_CHARS) throw new Error('方案库数据过大，保存已取消');
    const target = storage();
    const previous = target.getItem(DESIGN_STORAGE_KEY);
    if (previous !== null) decode(previous);
    target.setItem(DESIGN_STORAGE_KEY, raw);
    return { ok: true };
  } catch (error) {
    const detail = storageError(error);
    return { ok: false, error: `保存方案库失败（原有数据未主动删除）：${detail}` };
  }
}

let snapshotSequence = 0;
/**
 * Creates a detached snapshot without reading/writing storage or loading the workspace.
 * Throws Error with a readable message for invalid name/room/panels/goal/planId;
 * UI callers must catch it and display the error. Names are trimmed, at most 100 characters.
 */
export function createDesignSnapshot(
  name: string, room: RoomConfig, panels: PlacedPanel[], goalId: TargetGoalId, planId?: string,
): SavedDesign {
  if (typeof name !== 'string') throw new Error('方案名称必须为文本');
  snapshotSequence += 1;
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${snapshotSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
  return validateDesign({
    id: `design-${suffix}`,
    name: name.trim(),
    createdAt: new Date().toISOString(),
    room, panels, goalId, planId,
  });
}
