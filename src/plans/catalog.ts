import type { PlanStage } from './types';

export type { PlanStageId, PlanStage, StagePlan } from './types';

const usageLimit = '用途映射不是专业等级认证；分数不保证随阶段递增，也不代表施工验收。';
const modelLimit = '沿用现有简化模型，不能替代现场测量、结构隔声设计与监听校准。';

const stages: PlanStage[] = [
  {
    id: 'everyday', step: 1, title: '日常影音', goalId: 'hifi',
    summary: '优先处理侧墙第一反射，兼顾日常空间活度。',
    focus: ['侧墙第一反射', '保留基底与摆位'],
    upgrade: '从推荐的左右反射区开始，基底吸音充足时优先采用推荐的扩散处理。',
    limitations: [usageLimit, '入门处理不等于解决低频驻波或所有混响问题。', modelLimit],
  },
  {
    id: 'listening', step: 2, title: '专注听音', goalId: 'hifi',
    summary: '在反射处理基础上评估前墙角低频治理。',
    focus: ['侧墙反射', '前墙角低频'],
    upgrade: '按实际混响和低频诊断尝试推荐的前墙角陷阱，不按档位强塞材料。',
    limitations: [usageLimit, '低频陷阱也会吸收中高频；过干风险可能限制可用数量。', modelLimit],
  },
  {
    id: 'creator', step: 3, title: '家庭制作', goalId: 'mixing',
    summary: '切换制作用途目标，评估天花与前墙反射区。',
    focus: ['制作用途目标', '天花反射', '音箱背区'],
    upgrade: '加入推荐的天花云及前墙宽频处理，使用原模拟结果检查混响下限。',
    limitations: [usageLimit, '用途目标改为 mixing，不能把与 Hi-Fi 档的分数差视为物理改善量。', modelLimit],
  },
  {
    id: 'mixing', step: 4, title: '项目混音室', goalId: 'mixing',
    summary: '进一步评估后墙、后角与有限的混响补齐候选。',
    focus: ['后角低频', '后墙反射', '混响均衡'],
    upgrade: '仅使用推荐中的后区和辅助吸音位置；按实际需求接受，不无限补板追分。',
    limitations: [usageLimit, '大硬房可能仍未达标，小房可能无法容纳全部候选；扩散距离需实测。', modelLimit],
  },
  {
    id: 'mastering', step: 5, title: '母带监听参考', goalId: 'mixing',
    summary: '以混音布局为起点，强调测量与验证流程，不增加虚构物理能力。',
    focus: ['现场测量', '多点复核', '监听校准与复听'],
    upgrade: '布局策略与项目混音室相同；下一步是实测频响、衰减与反射并复核监听链。',
    limitations: [usageLimit, '可与混音档生成完全相同的材料；本模型无法认证母带室，也不提供商用标准数值。', modelLimit],
  },
];

for (const stage of stages) {
  Object.freeze(stage.focus);
  Object.freeze(stage.limitations);
  Object.freeze(stage);
}

export const PLAN_STAGES: readonly PlanStage[] = Object.freeze(stages);
