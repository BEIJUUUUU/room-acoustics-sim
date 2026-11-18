import { BASE_MATERIALS, TARGET_GOALS, TREATMENT_CATALOG } from '../acoustics/materials';
import type { PlacedPanel, RoomConfig, TargetGoalId, Vec3, WallFace } from '../acoustics/types';

export const MAX_DESIGNS = 20;
export const MAX_PANELS = 1000;
export const MAX_PAYLOAD_CHARS = 2_000_000;
const MAX_TEXT = 100;
const MAX_ID = 128;
const EPSILON = 1e-6;
const FACES: WallFace[] = ['left', 'right', 'front', 'rear', 'floor', 'ceiling'];

type RecordValue = Record<string, unknown>;
export function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须为对象`);
  return value as RecordValue;
}

export function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}必须为非空文本，且不能超过${max}字或包含控制字符`);
  }
  return value;
}

export function identifier(value: unknown, label: string): string {
  return text(value, label, MAX_ID);
}

function number(value: unknown, label: string, min: number, max: number, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (positive && value === 0)) {
    throw new Error(`${label}必须为${positive ? '大于' : '不小于'}${min}且不大于${max}的有限数值`);
  }
  return value;
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label}包含未知枚举值`);
  return value as T;
}

export function validateGoal(value: unknown): TargetGoalId {
  return member(value, Object.keys(TARGET_GOALS) as TargetGoalId[], '目标用途');
}

function vector(value: unknown, room: Pick<RoomConfig, 'width' | 'height' | 'length'>, label: string): Vec3 {
  const v = record(value, label);
  return {
    x: number(v.x, `${label}.x`, 0, room.width),
    y: number(v.y, `${label}.y`, 0, room.height),
    z: number(v.z, `${label}.z`, 0, room.length),
  };
}

export function validateRoom(value: unknown): RoomConfig {
  const r = record(value, '房间');
  const dimensions = {
    width: number(r.width, '房间宽度', 0, 1000, true),
    height: number(r.height, '房间高度', 0, 1000, true),
    length: number(r.length, '房间长度', 0, 1000, true),
  };
  if (dimensions.width * dimensions.height * dimensions.length === 0) throw new Error('房间体积过小，无法计算');
  const materials = Object.keys(BASE_MATERIALS) as RoomConfig['wallMaterial'][];
  return {
    ...dimensions,
    wallMaterial: member(r.wallMaterial, materials, '墙面基底材质'),
    floorMaterial: member(r.floorMaterial, materials, '地面基底材质'),
    ceilingMaterial: member(r.ceilingMaterial, materials, '顶面基底材质'),
    speakerMode: member(r.speakerMode, ['mono', 'stereo'], '音箱模式'),
    speakerPos: vector(r.speakerPos, dimensions, '音箱位置'),
    stereoSpan: number(r.stereoSpan, '音箱间距', 0, dimensions.width),
    listenerPos: vector(r.listenerPos, dimensions, '听音位'),
  };
}

function within(center: number, size: number, span: number): boolean {
  return center - size / 2 >= -EPSILON && center + size / 2 <= span + EPSILON;
}

export function validatePanels(value: unknown, room: RoomConfig): PlacedPanel[] {
  if (!Array.isArray(value) || value.length > MAX_PANELS) throw new Error(`材料列表必须为数组，且最多${MAX_PANELS}块`);
  const ids = new Set<string>();
  return Array.from(value, (item, index) => {
    const label = `第${index + 1}块材料`;
    const p = record(item, label);
    const id = identifier(p.id, `${label}ID`);
    if (ids.has(id)) throw new Error(`${label}ID重复`);
    ids.add(id);
    const productId = member(p.productId, Object.keys(TREATMENT_CATALOG) as PlacedPanel['productId'][], `${label}产品`);
    const spec = TREATMENT_CATALOG[productId];
    const face = member(p.face, FACES, `${label}表面`);
    if (!spec.allowedFaces.includes(face)) throw new Error(`${label}不支持所选表面`);
    const center = vector(p.center, room, `${label}中心`);
    const width = number(p.width, `${label}宽度`, 0, 1000, true);
    const height = number(p.height, `${label}高度`, 0, 1000, true);
    const thickness = number(p.thickness, `${label}厚度`, 0, Math.min(room.width, room.height, room.length), true);
    let cornerIndex: PlacedPanel['cornerIndex'];
    if (p.cornerIndex !== undefined) {
      if (!spec.cornerSnap || ![0, 1, 2, 3].includes(p.cornerIndex as number)) throw new Error(`${label}角落编号无效`);
      cornerIndex = p.cornerIndex as PlacedPanel['cornerIndex'];
    }
    let fits: boolean;
    if (cornerIndex !== undefined) {
      const offset = width * 0.42;
      const expectedX = cornerIndex % 2 ? room.width - offset : offset;
      const expectedZ = cornerIndex >= 2 ? room.length - offset : offset;
      fits = width <= Math.min(room.width, room.length) && within(center.y, height, room.height)
        && Math.abs(center.x - expectedX) <= EPSILON && Math.abs(center.z - expectedZ) <= EPSILON;
    } else if (face === 'left' || face === 'right') {
      fits = Math.abs(center.x - (face === 'left' ? 0 : room.width)) <= EPSILON
        && within(center.z, width, room.length) && within(center.y, height, room.height);
    } else if (face === 'front' || face === 'rear') {
      fits = Math.abs(center.z - (face === 'front' ? 0 : room.length)) <= EPSILON
        && within(center.x, width, room.width) && within(center.y, height, room.height);
    } else {
      fits = Math.abs(center.y - (face === 'floor' ? 0 : room.height)) <= EPSILON
        && within(center.x, width, room.width) && within(center.z, height, room.length);
    }
    if (!fits) throw new Error(`${label}超出房间边界或未贴合指定表面`);
    return { id, productId, face, center, width, height, thickness, ...(cornerIndex === undefined ? {} : { cornerIndex }) };
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
