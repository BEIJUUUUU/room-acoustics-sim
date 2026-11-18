#pragma once
/**
 * ============================================================================
 * AcousticLab C++17 核心声学仿真引擎 (头文件 acoustic_engine.hpp)
 * ============================================================================
 * 【写给有 Java / Python 基础、正在学习 C++ 与音频 DSP 的你】：
 *
 * 1. 为什么音频行业（车载 DSP、游戏音频引擎、JUCE 插件）清一色用 C++？
 *    - 实时音频回调（Audio Thread，例如 48kHz 下每 128 个采样点只有 2.66 毫秒预算）
 *      绝对不能发生垃圾回收（GC 停顿，Java/Python 的硬伤）或慢速堆内存分配。
 *    - C++ 允许使用「栈内存值类型 (struct Vec3)」和「定长数组 (std::array)」，
 *      数据在内存中连续紧密排列，能直接吃满 CPU 的 SIMD 向量指令缓存！
 *
 * 2. 本文件与前端 src/acoustics/engine.ts 保持 1:1 算法对齐：
 *    - 你可以随时安装 g++ / MSVC 本地编译运行测试，或通过 Emscripten (emcc)
 *      编译为 WebAssembly (.wasm) 直接挂载到前端浏览器中执行。
 * ============================================================================
 */

#include <array>
#include <cmath>
#include <string>
#include <vector>

namespace acoustic {

// C++ constexpr 编译期常量（类似 Java 的 static final，但在编译期直接展开，零运行时开销）
constexpr int NUM_BANDS = 6;
constexpr double SPEED_OF_SOUND = 343.0; // 20°C 空气声速 (m/s)
constexpr double PI = 3.14159265358979323846;

// 6 个标准倍频程中心频率 (Hz)
constexpr std::array<double, NUM_BANDS> OCTAVE_BANDS = {
    125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0
};

using BandArray = std::array<double, NUM_BANDS>;

/**
 * 三维向量（值语义 struct，默认分配在栈上，无需像 Java 那样 new Vec3()）
 */
struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;

    // 运算符重载：让向量数学公式像手写物理公式一样直观
    Vec3 operator+(const Vec3& rhs) const noexcept {
        return {x + rhs.x, y + rhs.y, z + rhs.z};
    }
    Vec3 operator-(const Vec3& rhs) const noexcept {
        return {x - rhs.x, y - rhs.y, z - rhs.z};
    }
    Vec3 operator*(double scalar) const noexcept {
        return {x * scalar, y * scalar, z * scalar};
    }

    double dot(const Vec3& rhs) const noexcept {
        return x * rhs.x + y * rhs.y + z * rhs.z;
    }

    double length() const noexcept {
        return std::sqrt(x * x + y * y + z * z);
    }

    double distanceTo(const Vec3& other) const noexcept {
        return (*this - other).length();
    }
};

enum class WallFace {
    Left = 0,   // x = 0
    Right = 1,  // x = width
    Floor = 2,  // y = 0
    Ceiling = 3,// y = height
    Front = 4,  // z = 0
    Rear = 5    // z = length
};

enum class TreatmentKind {
    BassTrap,       // 低频陷阱
    PorousAbsorber, // 吸音板
    Diffuser,       // 扩散板
    SoundproofBoard // 隔音板
};

struct RoomSpec {
    double width = 3.6;   // X 轴 (m)
    double height = 2.8;  // Y 轴 (m)
    double length = 4.8;  // Z 轴 (m)
    BandArray wallAlpha{};    // 墙面吸音系数
    BandArray floorAlpha{};   // 地面吸音系数
    BandArray ceilingAlpha{}; // 顶面吸音系数
};

struct PlacedTreatment {
    int id = 0;
    TreatmentKind kind = TreatmentKind::PorousAbsorber;
    WallFace face = WallFace::Left;
    Vec3 center{};        // 在房间坐标系下的中心点 (m)
    double panelWidth = 0.6;
    double panelHeight = 1.2;
    double thickness = 0.1;
    BandArray alpha{};    // 6频段吸音系数
    BandArray scatter{};  // 6频段散射系数（扩散板高）
    double stcBonus = 0.0;// 隔音传声损失增益 (dB)
};

struct ReflectionRay {
    WallFace face;
    Vec3 hitPoint;
    double distanceMeters = 0.0;
    double delayMs = 0.0;          // 相对直达声延迟 (ms)
    double gainDb = 0.0;           // 1kHz 综合反射衰减 (dB)
    bool hitAbsorber = false;      // 是否被吸音板/低频陷阱拦截
    bool hitDiffuser = false;      // 是否被扩散板打散
};

struct RoomModeInfo {
    int nx = 0, ny = 0, nz = 0;
    double frequencyHz = 0.0;
    double couplingGainDb = 0.0;   // 在当前发声源+听音位下的激励强度
};

struct SimulationSummary {
    BandArray rt60Untreated{};
    BandArray rt60Treated{};
    double rt60Mid = 0.0;
    double bassRatio = 0.0;
    double clarityC50Db = 0.0;
    std::vector<ReflectionRay> reflections;
    std::vector<RoomModeInfo> dominantModes;
};

class AcousticEngine {
public:
    // 计算低频陷阱在坐标点 p 处的驻波声压加权效率（墙角三面交汇处最高）
    static double computeCornerPressureWeight(const Vec3& p, const RoomSpec& room) noexcept;

    // 艾润 (Eyring) 多频段混响时间计算
    static BandArray computeEyringRT60(
        const RoomSpec& room,
        const std::vector<PlacedTreatment>& treatments
    );

    // 一阶镜像源法 (First-Order Image Source Method)：追踪 6 面墙壁第一反射点
    static std::vector<ReflectionRay> traceFirstOrderReflections(
        const RoomSpec& room,
        const Vec3& source,
        const Vec3& listener,
        const std::vector<PlacedTreatment>& treatments
    );

    // 矩形封闭空间简正驻波求解 (20Hz ~ 250Hz)
    static std::vector<RoomModeInfo> solveRoomModes(
        const RoomSpec& room,
        const Vec3& source,
        const Vec3& listener,
        double lowFreqAbsorptionRatio
    );

    // 完整仿真入口
    static SimulationSummary runSimulation(
        const RoomSpec& room,
        const Vec3& source,
        const Vec3& listener,
        const std::vector<PlacedTreatment>& treatments
    );
};

} // namespace acoustic
