import { runRoomSimulation } from '../acoustics/engine';
import type { RoomConfig, SimulationResult, TargetGoalId } from '../acoustics/types';
import type { SavedDesign } from './storage';
import { errorMessage, record, validateGoal, validatePanels, validateRoom } from './validation';

const ROOM_LABELS: Record<keyof RoomConfig, string> = {
  width: '房间宽度', height: '房间高度', length: '房间长度',
  wallMaterial: '墙面基底材质', floorMaterial: '地面基底材质', ceilingMaterial: '顶面基底材质',
  speakerMode: '音箱模式', speakerPos: '音箱位置', stereoSpan: '音箱间距', listenerPos: '听音位',
};

export function compareRoomCompatibility(a: RoomConfig, b: RoomConfig): { compatible: boolean; differences: string[] } {
  try {
    const left = validateRoom(a);
    const right = validateRoom(b);
    const differences: string[] = [];
    for (const field of Object.keys(ROOM_LABELS) as (keyof RoomConfig)[]) {
      if (field === 'speakerPos' || field === 'listenerPos') {
        for (const axis of ['x', 'y', 'z'] as const) {
          if (left[field][axis] !== right[field][axis]) differences.push(`${ROOM_LABELS[field]} ${axis.toUpperCase()} 坐标不同`);
        }
      } else if (left[field] !== right[field]) {
        differences.push(`${ROOM_LABELS[field]}不同`);
      }
    }
    return { compatible: differences.length === 0, differences };
  } catch (error) {
    return { compatible: false, differences: [`房间数据无效，不能公平比较：${errorMessage(error)}`] };
  }
}

/** Recalculates both snapshots under the supplied goal; never loads or persists either. */
export function evaluateDesignComparison(a: SavedDesign, b: SavedDesign, goalId: TargetGoalId): {
  compatible: boolean;
  differences: string[];
  goalId: TargetGoalId;
  a?: SimulationResult;
  b?: SimulationResult;
} {
  try {
    const left = record(a, '方案A');
    const right = record(b, '方案B');
    const compatibility = compareRoomCompatibility(left.room as RoomConfig, right.room as RoomConfig);
    if (!compatibility.compatible) return { ...compatibility, goalId };
    const goal = validateGoal(goalId);
    const roomA = validateRoom(left.room);
    const roomB = validateRoom(right.room);
    const panelsA = validatePanels(left.panels, roomA);
    const panelsB = validatePanels(right.panels, roomB);
    return {
      ...compatibility, goalId: goal,
      a: runRoomSimulation(roomA, panelsA, goal),
      b: runRoomSimulation(roomB, panelsB, goal),
    };
  } catch (error) {
    return { compatible: false, differences: [`方案数据无效，不能公平比较：${errorMessage(error)}`], goalId };
  }
}
