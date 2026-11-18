import type { PlacedPanel, RoomConfig, SimulationResult, TargetGoalId } from '../acoustics/types';

export type PlanStageId = 'everyday' | 'listening' | 'creator' | 'mixing' | 'mastering';

export interface PlanStage {
  id: PlanStageId;
  step: number;
  title: string;
  summary: string;
  goalId: TargetGoalId;
  focus: string[];
  upgrade: string;
  limitations: string[];
}

export interface StagePlan {
  stage: PlanStage;
  room: RoomConfig;
  panels: PlacedPanel[];
  simulation: SimulationResult;
  notes: string[];
}
