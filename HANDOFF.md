# AcousticLab 3D — 项目总结与 Agent 交接文档 (HANDOFF.md)

> **更新时间**：2026-11-18  
> **工作区路径**：`d:\Desktop\家用房间音频仿真`  
> **当前构建状态**：`npm run build`（`tsc -b && vite build`）零错误通过  

---

## 1. 项目背景与用户画像（接手必读）

### 1.1 用户目标与技术背景
- **职业方向**：用户计划未来从事音频工程相关工作，特别是 **车载音响调音（Automotive Audio Tuning / Cabin Acoustics）**。
- **编程基础**：具备 **Java** 与 **Python** 基础，**希望借本项目深入学习 C++**（音频 DSP 与车载座舱芯片行业标准语言）。
- **产品初衷**：打造一款既能辅助自己学习声学/DSP 底层物理原理、又能供发烧友/卧室混音师实际使用的 **3D 家用房间声学仿真与声学材料布置软件**。

### 1.2 产品核心痛点切入
市面上现有工具两极分化：
1. **GIK Acoustics 3D Room Designer**：能 3D 拖拽摆吸音板，但**完全没有声学物理计算与试听**；
2. **AMROC / REW (Room EQ Wizard) Room Sim**：能算矩形房间驻波与整面墙平均混响，但**没有 3D 局部挂板交互**；
3. **Odeon / EASE / Treble**：工业级建筑声学软件，价格昂贵且操作门槛极高。

**`AcousticLab 3D` 的定位**：轻量级 CAD 风格 3D 矩形房间建模 + 局部拖拽摆放声学材料（低频陷阱、宽频吸音板、薄鸡蛋棉对比、QRD 扩散板、复合隔音板）+ 毫秒级声学指标/曲线实时计算 + 真实干声脉冲响应卷积试听（Auralization）+ 定量智能摆放建议，并在各处融入**房间声学与车载座舱调音的对照讲解**。

---

## 2. 项目目录与模块架构

```text
d:\Desktop\家用房间音频仿真\
├── index.html                      # 应用入口 HTML
├── package.json                    # React 18 + Three.js 0.170 + Vite 6 + Lucide 依赖
├── tsconfig.json                   # TypeScript 严格模式配置
├── vite.config.ts                  # Vite 配置 (默认端口 5173)
├── README.md                       # 项目使用与编译说明
├── HANDOFF.md                      # 本交接文档
├── public/
│   └── audio/                      # 专业无混响/消声室级干声测试音源库 (本地静态资源)
│       ├── anechoic_guitar.wav     # PyRoomAcoustics 标准 44.1kHz 无混响木吉他干声 (10.4s)
│       ├── anechoic_speech.wav     # Google Resonance Audio 官方 48kHz 消声室人声 (2.86s)
│       ├── studio_music.wav        # Google Resonance Audio 官方 48kHz 无混响器乐参考曲 (30s)
│       ├── acoustic_drums.mp3      # Tone.js 真实录音棚原声鼓组律动
│       └── studio_bass.mp3         # Tone.js 低音电贝斯律动 (专测 50~130Hz 驻波轰头)
├── cpp_core/                       # 与前端 1:1 算法对齐的现代 C++17 核心声学引擎 (学习 & Wasm 预备)
│   ├── acoustic_engine.hpp         # C++17 数据结构与面向 Java/Python 开发者的实时音频内存注释
│   ├── acoustic_engine.cpp         # Eyring RT60、一阶镜像源求交、简正驻波、角落声压权重实现
│   └── demo_cli.cpp                # 独立命令行测试入口 (装好 g++/MSVC 即可直接编译运行)
└── src/
    ├── main.tsx                    # React 挂载入口
    ├── App.tsx                     # 顶栏控制、三栏工作站状态编排、预设切换、材料增删改
    ├── styles.css                  # 深色专业音频工作站 (DAW/CAD) 响应式样式
    ├── acoustics/
    │   ├── types.ts                # 全局物理与几何数据结构定义
    │   ├── materials.ts            # 6面基底材质 & 5种声学处理模块的6倍频程吸音/散射/隔声参数库
    │   └── engine.ts               # 核心物理仿真引擎 + 诊断打分 + 逆向 Eyring 定量智能推荐算法
    ├── audio/
    │   └── auralizer.ts            # Web Audio 实时双耳 RIR 合成、驻波谐振器、粉红噪声生成与卷积试听
    └── components/
        ├── RoomViewport3D.tsx      # 原生 Three.js CAD 级 3D 视窗 (透视/正交双相机、拖拽吸附、热力图)
        └── AcousticCharts.tsx      # SVG 声学图表 (6频段 RT60、REW 同款低频频响&驻波、ETC 脉冲图)
```

---

## 3. 空间坐标系与核心物理/DSP 算法说明

### 3.1 房间三维坐标系约定（极其重要，修改几何时必须严格遵守）
所有物理计算（`engine.ts` / `cpp_core`）与 `RoomViewport3D.tsx` 内的子物体均使用**统一的房间内部物理坐标系**：
- **$X$ 轴（宽度 `width`）**：范围 `[0, room.width]`。`x = 0` 为左侧墙（`left`），`x = room.width` 为右侧墙（`right`）。
- **$Y$ 轴（层高 `height`）**：范围 `[0, room.height]`。`y = 0` 为地面（`floor`），`y = room.height` 为天花板（`ceiling`）。
- **$Z$ 轴（长度 `length`）**：范围 `[0, room.length]`。`z = 0` 为音箱后方的前墙（`front`），`z = room.length` 为听者背后的后墙（`rear`）。
- 在 Three.js 中，`rootOffsetGroup` 整体平移了 `(-room.width / 2, 0, -room.length / 2)`，因此其内部所有 `shellGroup`、`panelsGroup`、`actorsGroup`、`raysGroup`、`hintsGroup` 直接使用 `[0, W] × [0, H] × [0, L]` 坐标，无需二次坐标轴翻转。
- **四个竖直内墙角索引约定（`cornerIndex`）**：
  - `0`: 左前内角 `(x=0, z=0)`，向 `(+x, +z)` 延伸进入室内；
  - `1`: 右前内角 `(x=W, z=0)`，向 `(-x, +z)` 延伸进入室内；
  - `2`: 左后内角 `(x=0, z=L)`，向 `(+x, -z)` 延伸进入室内；
  - `3`: 右后内角 `(x=W, z=L)`，向 `(-x, -z)` 延伸进入室内。

### 3.2 四层轻量级声学物理计算引擎 (`src/acoustics/engine.ts`)
1. **多频段混响时间 `RT60`（`125Hz, 250Hz, 500Hz, 1kHz, 2kHz, 4kHz`）**：
   - 采用 **Eyring-Norris 公式** 结合空气高频吸收项 $4mV$，同时扣除板材覆盖掉的原墙面基底吸音面积。
   - **角落声压位置权重 (`computeCornerPressureWeight`)**：根据简正驻波在边界面声压幅值叠加规律，低频陷阱越靠近两面墙交棱或三面墙顶角，`125Hz/250Hz` 有效吸音权重越高（最高 `1.35x`，墙心仅约 `0.5x`）。
2. **一阶镜像源法（First-Order Image Source Method, `traceReflections`）**：
   - 支持单声源（Mono）与立体声双音箱（Stereo），精确计算经 6 个边界面到达听音位的反射交点（第一反射点）、声程差延迟 $\Delta t\text{ (ms)}$ 与距离衰减。
   - 判定交点是否落在用户放置的板材区域内：
     - 命中吸音板/低频陷阱 $\rightarrow$ `status = 'absorbed'`（3D 声线变绿，脉冲大幅衰减）；
     - 命中 QRD 扩散板 $\rightarrow$ `status = 'diffused'`（3D 声线变青色扇形散射簇，RIR 中拆散为 8 抽头双极性序列消除梳状滤波）；
     - 命中裸硬墙或复合隔音板 $\rightarrow$ `status = 'raw'`（红色警告线，体现“隔音板表面坚硬不吸音”）。
3. **听音位低频驻波与边界干涉频响（`30Hz ~ 500Hz`, `solveModesAndResponse`）**：
   - 低频段采用矩形空间格林函数简正模态复数叠加（模态阻尼比由低频 `RT60` 实时导出：角落加低频陷阱 $\rightarrow$ 阻尼比增大 $\rightarrow$ 驻波峰自动压平）；
   - 中低频段（施罗德过渡带 `135Hz ~ 240Hz` 以上）平滑交叉过渡到直达声 + 6 条一阶反射复相量干涉（复现音箱离前墙距离引起的 **SBIR 边界干涉凹谷** 以及房间 50% 中心点的一阶驻波深谷）。
4. **逆向定量智能推荐算法（`buildSmartRecommendations`）**：
   - 精确计算当前音箱与听音位在左右墙、天花板、前墙、后墙的镜像反射坐标；
   - 智能自适应：若空房因地毯+矿棉吸音吊顶导致中频 `RT60` 已经很短，侧墙反射点自动改推 **QRD 扩散板** 防止过度吸干；若房间为高反射水泥/石膏墙，则通过循环校验 Eyring `RT60` 动态补齐辅助宽频吸音板数量，直接回答“放什么、要多少、放哪”。

### 3.3 实时可听化收音试听引擎 (`src/audio/auralizer.ts`)
- **信号链路**：`SourceBuffer (真实干声/粉噪) -> ModePeaking1 -> ModePeaking2 -> [DirectGain || (HighDampShelf -> ReverbWarmthLPF(5.8kHz) -> StereoConvolver -> WetGain)] -> Limiter (DynamicsCompressor 防破音) -> MasterGain -> Destination`。
- 支持在播放过程中零爆音平滑切换 **【干声原音 (Dry)】 / 【空房混响 (Untreated)】 / 【当前方案 (Treated)】**。
- 内置 6 种专业声源（默认 `anechoic_guitar.wav`，其中 `anechoic_speech.wav` 在解码时自动追加 `1.15s` 尾部静音以便清晰聆听每句话尾部的混响衰减）+ Paul Kellet 7 阶 `-3dB/Oct` 标准粉红噪声脉冲 + 用户本地音频上传。

---

## 4. 历史迭代与已解决的关键坑点（防止回归）

1. **【已修复】三棱柱角落低频陷阱跑到房间外墙的几何 Bug（最新修复）**
   - *根因*：早期使用 `THREE.ExtrudeGeometry` 沿 `+Z` 挤出后调用 `rotateX(-Math.PI / 2)`，导致局部坐标 `y ∈ [0, s]` 翻转为负值 `z' ∈ [-s, 0]`，四个墙角的低频陷阱全部突出到了房间外侧。
   - *现方案*：`RoomViewport3D.tsx` 中的 `buildInteriorCornerPrismGeometry()` 直接在房间内部空间 `[0, W] × [0, H] × [0, L]` 手写顶点与法线构建三棱柱，100% 贴合四面内墙角且斜边朝向室内中心。**切勿改回 `ExtrudeGeometry + rotateX`！**
2. **【已修复】“0 件材料但 3D 图里仍有彩色框”的用户困惑**
   - *根因*：早期默认开启了 `showHints` 且带半透明面填充，用户误以为是残留未清除的材料。
   - *现方案*：`showHints` 默认 `false`（0 件材料时房间完全纯净）；仅当用户鼠标悬停右侧某条建议卡片（`hoveredHintId`）或主动勾选「预览建议虚线位」时，以纯空心虚线 `THREE.LineDashedMaterial` 预览。
3. **【已修复】类 CAD 旋转/平移拖动与窄屏排版**
   - 启用了 `controls.screenSpacePanning = true`、`controls.zoomToCursor = true`，提供左上角 `✥ 选取/移位`、`↻ 旋转`、`✋ 拖动画布` 三档左键模式，以及 **`3D透视` / `正交CAD`（`OrthographicCamera`）** 切换、0.5m 地面网格、长宽高尺寸标尺、右上角实时 XYZ 坐标轴指示器与「全宽大屏」模式。
   - 修复了拉伸房间长宽滑块时音箱未按比例居中导致缩在一角的问题（`App.tsx` 中 `updateRoom` 已支持按比例缩放相对坐标）。
4. **【已修复】测试音源质感升级**
   - 已彻底移除早期简陋的电子振荡器合成鼓/贝斯音色，替换为 `public/audio/` 下的真实消声室/无混响干声录音与标准粉红噪声脉冲。

---

## 5. 环境现状与常用命令

### 5.1 当前机器环境
- **OS / Shell**：Windows (PowerShell)
- **已安装工具**：`node v24.19.0`、`npm 11.17.0`、`python 3.14`
- **暂未加入 PATH 的工具**：`g++`、`clang++`、`cl`、`cmake`、`emcc`（后续若推进 C++ 本地编译或 WebAssembly，需先引导用户安装 MinGW-w64 / Visual Studio Build Tools / Emscripten SDK）。

### 5.2 常用命令
```powershell
# 启动本地开发服务器 (http://127.0.0.1:5173/)
npm run dev -- --host 127.0.0.1 --port 5173

# TypeScript 类型检查与生产打包验证
npm run build
```

---

## 6. 下一位 Agent 接手后的建议工作清单 (Next Steps)

1. **第一步（快速视觉与听感确认）**：
   - 刚刚完成了「内墙角三棱柱几何体修复 (`buildInteriorCornerPrismGeometry`)」与「专业干声测试音源库 (`public/audio/*` + 新版 `auralizer.ts`)」的代码合入并通过了 `npm run build`，接手后可先打开浏览器（`http://127.0.0.1:5173/`）点击「标准科学方案」，向用户直观确认四个橙色低频陷阱现已严丝合缝贴合在房间四角内部，并邀请用户试听全新的木吉他/消声室人声对比效果。

2. **进阶方向 A —— 车载音响 DSP 调音台模块（强烈契合用户职业目标）**：
   - 在现有房间声学物理仿真之上，增加一个可折叠的 **「DSP 电声调音台」**（多段参量均衡器 **PEQ：Freq / Gain / Q** + 左右声道独立 **Delay 延时对齐 (ms)** + 分频器 **Crossover**）：
   - 同时作用于下方的 **REW 频响曲线** 与 **Web Audio 实时试听链路**！让用户亲手体验：**“驻波峰可以用窄 Q 值负增益 PEQ 削平，但 50% 位置的驻波抵消深谷（Null）拉高 EQ 也救不回来，必须靠挪位置或放低频陷阱”**——打通物理声学与车载调音的核心认知。

3. **进阶方向 B —— 真正的 C++17 -> WebAssembly (`.wasm`) 编译接入**：
   - 协助用户在 Windows 下配置 `emsdk`（Emscripten）或 `w64devkit/MinGW`，为 `cpp_core/acoustic_engine.cpp` 添加 `EMSCRIPTEN_BINDINGS`，编译输出 `public/wasm/acoustic_core.js/.wasm`；
   - 在前端增加 `[TS 内核 | C++17 Wasm 内核]` 切换开关与计算耗时微秒级对比面板，并在 C++ 侧扩展更高阶镜像源（2~3 阶反射）或数百条声线追踪（Ray Tracing），帮助用户实战进阶 C++。

4. **进阶方向 C —— 房间家具模型与方案导入导出**：
   - 增加常见室内家具吸音/反射体（布艺沙发、床垫、书架、桌面——桌面早期反射也是卧室监听的一大杀手！）；
   - 支持将当前房间参数与声学材料清单导出为 `.json` 存档或一键生成声学装修采购方案长图/PDF。
