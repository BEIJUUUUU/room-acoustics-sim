# 分级方案库实施约定

## 已确认的范围

用户确认：五阶段方案库 + 当前房间自适应 + 本地保存/A-B对比，并修复旧预设继承目标的问题。保留新浅色工作台。撤销/预算/测量导入/DSP不在本轮。先展示真实效果，未获确认不得commit或push。

新方案保留当前RoomConfig全部字段（尺寸、基底材质、音箱、听音位）。应用时替换材料并显式切换方案对应用途；存在当前材料时明确确认。完整场景案例是另一入口，明确提示会替换房间与材料。

## 并行所有权

- 方案模块：仅 src/plans/** 与 scripts/test-plans.cjs。
- 存储模块：仅 src/projects/** 与 scripts/test-projects.cjs。
- UI集成：仅 src/App.tsx、src/styles.css、src/components/PlanLibrary.tsx、src/components/ProjectLibrary.tsx（可新增这两个组件），不得改上述模块。
- 协调者维护本文件，做独立测试；不代写实现代码。

禁止修改src/acoustics/**、src/audio/**、cpp_core/**、public/**、package*.json、vite.config.ts、.gitignore。本轮不新增依赖。

## 共享接口（导出名称及字段必须保持）

`src/plans/catalog.ts` 导出 `PLAN_STAGES`（只读数组），并可re-export types：

- PlanStageId = 'everyday' | 'listening' | 'creator' | 'mixing' | 'mastering'
- PlanStage = { id: PlanStageId; step: number; title: string; summary: string; goalId: TargetGoalId; focus: string[]; upgrade: string; limitations: string[] }
- StagePlan = { stage: PlanStage; room: RoomConfig; panels: PlacedPanel[]; simulation: SimulationResult; notes: string[] }

`src/plans/generatePlan.ts` 导出 `generateStagePlan(room: RoomConfig, stageId: PlanStageId): StagePlan`。

阶段依次：日常影音、专注听音、家庭制作、项目混音室、母带监听参考。前两档hifi，后三档mixing；这是现有模型的用途映射，不是专业等级认证。生成函数不得改传入room，必须以原房间与声源几何生成合法材料；计算均复用原engine。高级不等于材料越多或分数越高。母带参考允许与混音档生成同样物料，但需明确该阶段更重测量/验证，本模型无法据此认证母带室，不得编造差异与数值。

`src/projects/storage.ts` 导出：

- SavedDesign = { id: string; name: string; createdAt: string; room: RoomConfig; panels: PlacedPanel[]; goalId: TargetGoalId; planId?: string }
- loadDesigns(): { designs: SavedDesign[]; error?: string }
- saveDesigns(designs: SavedDesign[]): { ok: boolean; error?: string }
- createDesignSnapshot(name: string, room: RoomConfig, panels: PlacedPanel[], goalId: TargetGoalId, planId?: string): SavedDesign

存储使用专有带schemaVersion的localStorage键，加载必须校验不信任JSON，不存音频二进制，不保存无穷/NaN/未知材质。失败以error交给UI呈现，不静默声称成功。保存上限20个，UI需显示上限并允许删除；不得悄悄删旧条目。快照必须深拷贝。

`src/projects/comparison.ts` 导出：

- compareRoomCompatibility(a: RoomConfig, b: RoomConfig): { compatible: boolean; differences: string[] }
- evaluateDesignComparison(a: SavedDesign, b: SavedDesign, goalId: TargetGoalId): { compatible: boolean; differences: string[]; goalId: TargetGoalId; a?: SimulationResult; b?: SimulationResult }

公平对比要求同一RoomConfig（包括尺寸、材质、单双声源、音箱/听音位位置、间距）。不兼容时必须显示原因，不画貌似可比的指标结论。兼容时使用同一明确显示的goalId重算双方，不能直接对比不同用途下保存的分数。沿用当前试听音源和dry/untreated/treated模式，不自动替换音频。图表对比与载入快照必须分开；载入会改变房间时需明确提示。

## UI验收要点

- 顶栏方案库入口，库中“升级方案 / 场景案例”分开。旧四案例仍可到达，薄棉案例明确设置目标，避免继承。
- 五阶段卡片只放短文案、标签；详情才展开材料、变化、真实预期结果、未达标与局限。
- 新应用不重置当前房间。取消确认不得丢方案。
- 保存/已保存/A-B入口直观，比较必须选择两个不同快照；名称、错误/成功反馈、删除及空态完整。
- 维护浅色留白风格；不把全部新增内容堆进首屏。宽屏/窄屏无页面横溢，弹层可滚动可关闭，有焦点和键盘路径。
- 当前UI已有navigateToContext统一退出全宽，集成不得恢复旧状态泄漏。

## 验收与交付

各执行者自测自己的模块；UI在其余模块到齐后跑完整tsc/build。协调者独立做构建、单元测试与浏览器动作、刷新保存、错误数据与对比约束检查，然后展示截图。所有既有未提交改动是UI基线，不得reset或覆盖掉。

### 本轮独立验收记录

- 三个实施任务各运行1次即交付；协调者没有代写模块实现。
- 协调者复跑 `node scripts/test-plans.cjs`：6类房间×5阶段30组合、输入不变、位置合法、确定性与真实仿真结果均通过。
- 协调者复跑 `node scripts/test-projects.cjs`：最终54组通过，包含损坏/未来schema保护、数值与面板边界校验、20条上限、同房公平比较。
- 另做跨模块隔离编译测试：4类房间×5阶段共20个真实生成方案均可创建快照、保存/加载，并按统一用途比较。
- 协调者浏览器21项动作断言通过：命名保存、五阶段、应用后完整room保持、刷新持久化、统一用途表、不自动应用、A/B预览/切换/关闭恢复原房间和用途及材料、不同房间禁止比较、损坏存储只读、quota错误与原字节保留、20条禁保存、取消删除/删除释放名额、1440/390弹层不溢出、完整案例目标、薄棉目标重置、Escape关闭并恢复焦点。测试中捕获的未处理运行时异常为0；测试结束恢复测试前原localStorage内容。
- 最终独立 `npx tsc -b` 与 `npm run build` 成功；`git diff --check`成功。声学/DSP/C++/素材及package依赖无改动。
- 宽卡片方案库、手机单列方案库和A/B界面均已截取真实页面并人工查看。未commit、未push，等待用户验收。

### 明确的本轮边界

存储只在当前浏览器本地，无云同步；清理站点存储会丢快照。损坏或未来版本仅保护并提示，不自动迁移/修复。跨标签页不提供并发合并。越界的旧材料布局会被拒绝保存并显示错误，不自动改变其几何。保留原有大bundle构建警告，代码分包未纳入本轮。母带参考不等于专业认证；方案是有限推荐探索，非全局最优或施工校核。
