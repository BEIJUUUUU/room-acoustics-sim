import { buildSmartRecommendations, clampPanelToRoom, runRoomSimulation } from '../acoustics/engine';
import { TARGET_GOALS, TREATMENT_CATALOG } from '../acoustics/materials';
import type { PlacedPanel, RecommendedHint, RoomConfig } from '../acoustics/types';
import { PLAN_STAGES } from './catalog';
import type { PlanStageId, StagePlan } from './types';

interface CandidateGroup {
  ids: string[];
  step: number;
  label: string;
  condition?: 'bass' | 'tail';
}

// A single pass over the engine's finite recommendation slots; no fill-until-target loop.
const GROUPS: readonly CandidateGroup[] = [
  { ids: ['rec-abs-left', 'rec-abs-right'], step: 1, label: '侧墙第一反射' },
  { ids: ['rec-trap-fl', 'rec-trap-fr'], step: 2, label: '前墙角低频', condition: 'bass' },
  { ids: ['rec-abs-ceil'], step: 3, label: '天花第一反射' },
  { ids: ['rec-abs-front'], step: 3, label: '前墙音箱背区' },
  { ids: ['rec-trap-rl', 'rec-trap-rr'], step: 4, label: '后墙角低频', condition: 'bass' },
  { ids: ['rec-rear-diff-1', 'rec-rear-diff-2'], step: 4, label: '后墙反射' },
  { ids: ['rec-extra-0', 'rec-extra-1'], step: 4, label: '侧后墙混响补齐', condition: 'tail' },
  { ids: ['rec-extra-2'], step: 4, label: '后区顶面混响补齐', condition: 'tail' },
  { ids: ['rec-extra-3'], step: 4, label: '前墙上部混响补齐', condition: 'tail' },
];

function fitRecommendation(hint: RecommendedHint, room: RoomConfig): PlacedPanel | undefined {
  const spec = TREATMENT_CATALOG[hint.productId];
  if (!spec.allowedFaces.includes(hint.face) || hint.productId === 'absorber_foam' || hint.productId === 'soundproof_board') return;
  const horizontal = hint.face === 'left' || hint.face === 'right' ? room.length : room.width;
  const vertical = hint.face === 'ceiling' || hint.face === 'floor' ? room.length : room.height;
  const width = Math.min(hint.width, spec.cornerSnap ? Math.min(room.width, room.length) / 2 : horizontal);
  const height = Math.min(hint.height, vertical);
  const normal = hint.face === 'left' || hint.face === 'right' ? room.width
    : hint.face === 'ceiling' || hint.face === 'floor' ? room.height : room.length;
  if (![width, height, spec.thickness, ...Object.values(hint.center)].every(Number.isFinite)
    || width <= 0 || height <= 0 || spec.thickness > normal
    || (spec.cornerSnap && spec.thickness > Math.min(room.width, room.length))) return;
  return clampPanelToRoom({
    id: `plan-${hint.id}`,
    productId: hint.productId,
    face: hint.face,
    center: { ...hint.center },
    width, height, thickness: spec.thickness,
    ...(hint.cornerIndex === undefined ? {} : { cornerIndex: hint.cornerIndex }),
  }, room);
}

function overlaps(a: PlacedPanel, b: PlacedPanel): boolean {
  if (a.face !== b.face || a.cornerIndex !== undefined || b.cornerIndex !== undefined) return false;
  const u = a.face === 'left' || a.face === 'right' ? 'z' : 'x';
  const v = a.face === 'ceiling' || a.face === 'floor' ? 'z' : 'y';
  return Math.abs(a.center[u] - b.center[u]) < (a.width + b.width) / 2 - 1e-6
    && Math.abs(a.center[v] - b.center[v]) < (a.height + b.height) / 2 - 1e-6;
}

export function generateStagePlan(room: RoomConfig, stageId: PlanStageId): StagePlan {
  const entry = PLAN_STAGES.find((stage) => stage.id === stageId);
  if (!entry) throw new RangeError(`未知阶段: ${stageId}`);
  if (![room.width, room.height, room.length].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError('房间尺寸必须是有限正数；方案不会改写房间来修复无效输入。');
  }
  const snapshot = structuredClone(room);
  const stage = structuredClone(entry);
  const goal = TARGET_GOALS[stage.goalId];
  const recommendations = new Map(buildSmartRecommendations(snapshot, stage.goalId).map((hint) => [hint.id, hint]));
  let panels: PlacedPanel[] = [];
  let simulation = runRoomSimulation(snapshot, panels, stage.goalId);
  const notes = [
    `用途：${stage.goalId}（${TARGET_GOALS[stage.goalId].name}），是现有模型的用途映射，不是专业等级认证。`,
    '仅替换处理材料；房间尺寸、基底材质、声源、音箱间距与听音位保持原样。阶段方案不是完整场景案例。',
    '阶段不承诺材料更多或分数更高；不同用途目标下的分数不能直接比较。未做施工、隔声或母带认证。',
  ];

  for (const group of GROUPS) {
    if (group.step > Math.min(stage.step, 4)) continue;
    if (group.condition === 'tail' && simulation.rt60MidTreated <= goal.rt60Max) continue;
    if (group.condition === 'bass' && simulation.bassRatio <= 1.38 && simulation.rt60MidTreated <= goal.rt60Max) continue;
    const hints = group.ids.flatMap((id) => recommendations.has(id) ? [recommendations.get(id)!] : []);
    if (!hints.length) continue;
    const fitted = hints.map((hint) => fitRecommendation(hint, snapshot));
    if (fitted.some((panel) => !panel)) {
      notes.push(`${group.label}：房间尺寸无法容纳合法材料，跳过此组。`);
      continue;
    }
    const candidates = fitted as PlacedPanel[];
    if (candidates.some((panel, index) => [...panels, ...candidates.slice(0, index)].some((existing) => overlaps(panel, existing)))) {
      notes.push(`${group.label}：裁切贴合后与同面候选重叠，跳过此组而非重复计入面积。`);
      continue;
    }
    const trial = runRoomSimulation(snapshot, [...panels, ...candidates], stage.goalId);
    if (trial.rt60MidTreated < goal.rt60Min) {
      notes.push(`${group.label}：试算中频 RT60 ${trial.rt60MidTreated.toFixed(3)}s 低于用途下限 ${goal.rt60Min}s，跳过以避免继续吸干。`);
      continue;
    }
    panels = [...panels, ...candidates];
    simulation = trial;
    notes.push(`${group.label}：采用 ${candidates.length} 件推荐材料，尺寸按当前房间贴合；试算中频 RT60 ${trial.rt60MidTreated.toFixed(3)}s。`);
  }

  const rt = simulation.rt60MidTreated;
  notes.push(`实际模拟：中频 RT60 ${rt.toFixed(3)}s（原房间 ${simulation.rt60MidUntreated.toFixed(3)}s；当前用途目标 ${goal.rt60Min}–${goal.rt60Max}s），C50 ${simulation.clarityC50Treated.toFixed(2)}dB，模型分数 ${simulation.score}。`);
  if (rt > goal.rt60Max) notes.push('未达标：中频混响仍高于当前用途上限。有限推荐已评估，不会无限补板；需现场测量及进一步设计。');
  if (rt < goal.rt60Min) notes.push('未达标 / 过干：基底已使中频混响低于当前用途下限；不改基底或摆位伪造改善，已限制新增吸音。');
  if (simulation.clarityC50Treated < goal.idealClarityMin) notes.push(`未达标：C50 低于当前用途模型参考 ${goal.idealClarityMin}dB，不能承诺监听清晰度。`);
  const raw = simulation.reflections.filter((ray) => ray.status === 'raw').length;
  if (raw) notes.push(`仍有 ${raw} 条模型镜面反射未处理；有限阶段方案并非全反射消除方案。`);
  notes.push(...simulation.diagnostics.filter((diagnostic) => diagnostic.level === 'warn' || diagnostic.level === 'bad').map((diagnostic) => `${diagnostic.title}：${diagnostic.detail}`));
  if (!panels.length) notes.push('本阶段未新增材料：空间、过干风险或现有基底可能使候选不适用；不为凑档位强行补板。');
  if (stage.id === 'mastering') notes.push('母带监听参考与项目混音室使用相同布局策略，材料与模拟结果可完全相同。区别是测量、校准、多点复核与复听的验证流程参考；本模型没有新增物理能力，无法据此认证母带室或保证商用标准。');
  notes.push('模型未校验安装净空、门窗遮挡、结构承载、产品裁切后的真实频谱或扩散工作距离；落地前须实测复核，尺寸缩小不等于性能认证。');
  return { stage, room: snapshot, panels, simulation, notes };
}
