export const OCTAVE_BANDS = [125, 250, 500, 1000, 2000, 4000] as const;
export type BandArray = [number, number, number, number, number, number];

export interface Vec3 {
  x: number; // [0, width] 左右方向 (m)
  y: number; // [0, height] 地面到天花板高度 (m)
  z: number; // [0, length] 前墙到后墙深度 (m)
}

export type WallFace = 'left' | 'right' | 'front' | 'rear' | 'floor' | 'ceiling';

export type BaseSurfaceMaterialId =
  | 'concrete'
  | 'drywall'
  | 'wood_panel'
  | 'glass_window'
  | 'carpet'
  | 'acoustic_ceiling';

export interface BaseSurfaceMaterial {
  id: BaseSurfaceMaterialId;
  name: string;
  subtitle: string;
  color: string;
  alpha: BandArray; // 6 倍频程吸音系数
  baseStc: number;  // 基础隔音传声损失 (dB)
}

export type TreatmentProductId =
  | 'bass_trap_corner'
  | 'absorber_thick'
  | 'absorber_foam'
  | 'diffuser_qrd'
  | 'soundproof_board';

export type TreatmentCategory = 'bass_trap' | 'absorber' | 'diffuser' | 'soundproof';

export interface TreatmentCatalogItem {
  id: TreatmentProductId;
  category: TreatmentCategory;
  name: string;
  shortName: string;
  description: string;
  carAudioNote: string; // 与车载声学/小空间调音的关联注解
  color: string;
  accentColor: string;
  defaultWidth: number;     // 沿墙面水平宽度 (m)
  defaultHeight: number;    // 沿墙面竖直高度或长度 (m)
  thickness: number;        // 厚度 (m)
  alpha: BandArray;         // 6 频段吸音系数
  scatter: BandArray;       // 6 频段散射系数
  stcBonus: number;         // 对外隔音增益潜力 (dB)
  allowedFaces: WallFace[];
  cornerSnap?: boolean;     // 是否优先吸附竖直四墙角
}

export interface PlacedPanel {
  id: string;
  productId: TreatmentProductId;
  face: WallFace;
  /**
   * 墙面局部归一化或物理中心坐标：
   * 直接存储房间三维物理中心点 (m)，与 C++ 引擎 PlacedTreatment::center 严格一致
   */
  center: Vec3;
  width: number;
  height: number;
  thickness: number;
  cornerIndex?: 0 | 1 | 2 | 3; // 若为四角立柱低频陷阱：0=左前, 1=右前, 2=左后, 3=右后
}

export interface RoomConfig {
  width: number;   // X (m) 宽
  height: number;  // Y (m) 高
  length: number;  // Z (m) 长
  wallMaterial: BaseSurfaceMaterialId;
  floorMaterial: BaseSurfaceMaterialId;
  ceilingMaterial: BaseSurfaceMaterialId;
  speakerMode: 'mono' | 'stereo';
  speakerPos: Vec3; // 单声道位置；立体声模式下作为声场中心锚点（自动按间距展开左右箱）
  stereoSpan: number; // 立体声左右音箱间距 (m)
  listenerPos: Vec3;  // 听音位人耳中心坐标 (m)
}

export type ReflectionStatus = 'raw' | 'absorbed' | 'diffused' | 'soft_surface';

export interface ReflectionRay {
  id: string;
  speakerLabel: string;
  face: WallFace;
  faceLabel: string;
  sourcePos: Vec3;
  hitPoint: Vec3;
  listenerPos: Vec3;
  distanceMeters: number;
  delayMs: number;
  gainDb: number;
  rawGainDb: number;
  status: ReflectionStatus;
  hitPanelId?: string;
  hitProductName?: string;
}

export interface RoomModePoint {
  nx: number;
  ny: number;
  nz: number;
  type: 'axial' | 'tangential' | 'oblique';
  axisLabel: string;
  freqHz: number;
  untreatedDb: number;
  treatedDb: number;
}

export interface FreqResponseSample {
  freqHz: number;
  untreatedSplDb: number;
  treatedSplDb: number;
}

export type TargetGoalId = 'hifi' | 'mixing' | 'vocal' | 'car_lab';

export interface TargetGoalSpec {
  id: TargetGoalId;
  name: string;
  subtitle: string;
  rt60Min: number;
  rt60Max: number;
  idealClarityMin: number;
}

export interface RecommendedHint {
  id: string;
  productId: TreatmentProductId;
  title: string;
  reason: string;
  face: WallFace;
  center: Vec3;
  width: number;
  height: number;
  cornerIndex?: 0 | 1 | 2 | 3;
}

export interface SimulationResult {
  volumeM3: number;
  surfaceAreaM2: number;
  schroederFreqHz: number; // 施罗德频率：低频驻波区与中高频几何反射区的分界线！
  rt60Untreated: BandArray;
  rt60Treated: BandArray;
  rt60MidUntreated: number;
  rt60MidTreated: number;
  bassRatio: number;       // 低频温暖度/轰头比 (RT125+RT250)/(RT500+RT1000)
  trebleRatio: number;     // 高频明亮度比 (RT2000+RT4000)/(RT500+RT1000)
  clarityC50Untreated: number;
  clarityC50Treated: number;
  estimatedStcDb: number;  // 综合隔音指数估算
  stcGainDb: number;       // 隔音板带来的额外隔音提升
  score: number;           // 0 ~ 100 综合声学健康分
  reflections: ReflectionRay[];
  modes: RoomModePoint[];
  freqResponse: FreqResponseSample[];
  diagnostics: {
    level: 'good' | 'warn' | 'bad' | 'info';
    title: string;
    detail: string;
  }[];
  recommendations: RecommendedHint[];
}
