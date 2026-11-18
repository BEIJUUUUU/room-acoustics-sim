#include "acoustic_engine.hpp"
#include <algorithm>

/**
 * ============================================================================
 * AcousticLab C++17 核心声学仿真引擎实现 (acoustic_engine.cpp)
 * ============================================================================
 * 编译方式 1（本地命令行自测）：
 *   g++ -std=c++17 -O3 cpp_core/acoustic_engine.cpp cpp_core/demo_cli.cpp -o acoustic_sim
 *
 * 编译方式 2（Emscripten 编译为浏览器 WebAssembly 模块）：
 *   emcc -std=c++17 -O3 --bind cpp_core/acoustic_engine.cpp -o public/acoustic_wasm.js
 * ============================================================================
 */

namespace acoustic {

namespace {
// 匿名命名空间：仅在当前 .cpp 文件内部可见（类似 Java 的 private static 辅助函数）
bool isPointOnPanel(
    WallFace face,
    const Vec3& hit,
    const PlacedTreatment& panel
) noexcept {
    const double halfW = panel.panelWidth * 0.5;
    const double halfH = panel.panelHeight * 0.5;

    switch (face) {
        case WallFace::Left:
        case WallFace::Right:
            // 左右侧墙平面为 Z-Y
            return std::abs(hit.z - panel.center.z) <= halfW &&
                   std::abs(hit.y - panel.center.y) <= halfH;
        case WallFace::Front:
        case WallFace::Rear:
            // 前后墙平面为 X-Y
            return std::abs(hit.x - panel.center.x) <= halfW &&
                   std::abs(hit.y - panel.center.y) <= halfH;
        case WallFace::Floor:
        case WallFace::Ceiling:
            // 地面与天花板平面为 X-Z
            return std::abs(hit.x - panel.center.x) <= halfW &&
                   std::abs(hit.z - panel.center.z) <= halfH;
    }
    return false;
}
} // namespace

double AcousticEngine::computeCornerPressureWeight(
    const Vec3& p,
    const RoomSpec& room
) noexcept {
    // 物理原理：矩形房间内所有简正驻波在边界面法向速度为 0，声压幅值正比于 cos(n*pi*x/L)。
    // 靠近墙壁/墙角 (x->0 或 x->L) 时所有阶数模式的余弦平方趋近于 1，声压叠加最强！
    auto boundaryProximity = [](double coord, double span) -> double {
        const double distToWall = std::min(coord, span - coord);
        // 距离墙面 0.5m 以内指数上升（约等于 125Hz 四分之一波长区域）
        return std::exp(-distToWall / 0.55);
    };

    const double wx = boundaryProximity(p.x, room.width);
    const double wy = boundaryProximity(p.y, room.height);
    const double wz = boundaryProximity(p.z, room.length);

    // 统计靠近几个边界面：墙心(1面) ≈ 0.55，两面墙棱角(2面) ≈ 1.0，三面墙顶角(3面) ≈ 1.30
    const double boundaryScore = wx + wy + wz;
    return std::clamp(0.38 + 0.36 * boundaryScore, 0.40, 1.35);
}

BandArray AcousticEngine::computeEyringRT60(
    const RoomSpec& room,
    const std::vector<PlacedTreatment>& treatments
) {
    const double volume = room.width * room.height * room.length;
    const double areaLR = 2.0 * (room.length * room.height);
    const double areaFR = 2.0 * (room.width * room.height);
    const double areaFloor = room.width * room.length;
    const double areaCeil = room.width * room.length;
    const double totalSurface = areaLR + areaFR + areaFloor + areaCeil;

    // 空气高频吸收系数 m (4kHz 在常温常湿下更明显)
    constexpr BandArray airAbsorptionM = {0.0001, 0.0003, 0.0006, 0.0010, 0.0024, 0.0060};

    BandArray rt60{};
    for (int b = 0; b < NUM_BANDS; ++b) {
        // 1. 裸房基础吸音面积 A_base (Sabine m^2)
        double equivalentA =
            (areaLR + areaFR) * room.wallAlpha[b] +
            areaFloor * room.floorAlpha[b] +
            areaCeil * room.ceilingAlpha[b];

        // 2. 叠加所有摆放的声学处理模块净增吸音量
        for (const auto& item : treatments) {
            const double area = item.panelWidth * item.panelHeight;
            double posWeight = 1.0;
            if (item.kind == TreatmentKind::BassTrap && b <= 1) {
                // 低频陷阱在 125Hz / 250Hz 的有效吸音强烈依赖是否放在角落声压高压区
                posWeight = computeCornerPressureWeight(item.center, room);
            }

            double underlyingAlpha = room.wallAlpha[b];
            if (item.face == WallFace::Floor) underlyingAlpha = room.floorAlpha[b];
            if (item.face == WallFace::Ceiling) underlyingAlpha = room.ceilingAlpha[b];

            // 低频陷阱双斜面暴露在空气中，等效吸音面积大于单侧投影
            const double exposedArea = (item.kind == TreatmentKind::BassTrap) ? area * 1.45 : area;
            const double deltaA = exposedArea * item.alpha[b] * posWeight - area * underlyingAlpha;
            equivalentA += deltaA;
        }

        const double avgAlpha = std::clamp(equivalentA / totalSurface, 0.015, 0.94);
        // Eyring-Norris 混响公式（比 Sabine 在大吸音率录音室里更准确）
        const double denom = -totalSurface * std::log(1.0 - avgAlpha) + 4.0 * airAbsorptionM[b] * volume;
        rt60[b] = (0.161 * volume) / std::max(denom, 0.05);
    }

    return rt60;
}

std::vector<ReflectionRay> AcousticEngine::traceFirstOrderReflections(
    const RoomSpec& room,
    const Vec3& source,
    const Vec3& listener,
    const std::vector<PlacedTreatment>& treatments
) {
    std::vector<ReflectionRay> rays;
    rays.reserve(6); // C++ 性能优化习惯：提前预分配容量，避免动态扩容拷贝

    const double directDist = std::max(source.distanceTo(listener), 0.1);

    // 6 个一阶镜像源坐标（关于 6 个边界面做镜面对称）
    const std::array<std::pair<WallFace, Vec3>, 6> imageSources = {{
        {WallFace::Left,    {-source.x, source.y, source.z}},
        {WallFace::Right,   {2.0 * room.width - source.x, source.y, source.z}},
        {WallFace::Floor,   {source.x, -source.y, source.z}},
        {WallFace::Ceiling, {source.x, 2.0 * room.height - source.y, source.z}},
        {WallFace::Front,   {source.x, source.y, -source.z}},
        {WallFace::Rear,    {source.x, source.y, 2.0 * room.length - source.z}}
    }};

    for (const auto& [face, imgSrc] : imageSources) {
        const Vec3 dir = listener - imgSrc;
        double t = 0.5;
        switch (face) {
            case WallFace::Left:    t = (0.0 - imgSrc.x) / dir.x; break;
            case WallFace::Right:   t = (room.width - imgSrc.x) / dir.x; break;
            case WallFace::Floor:   t = (0.0 - imgSrc.y) / dir.y; break;
            case WallFace::Ceiling: t = (room.height - imgSrc.y) / dir.y; break;
            case WallFace::Front:   t = (0.0 - imgSrc.z) / dir.z; break;
            case WallFace::Rear:    t = (room.length - imgSrc.z) / dir.z; break;
        }

        const Vec3 hitPoint = imgSrc + dir * t;
        const double reflDist = imgSrc.distanceTo(listener);
        const double delayMs = ((reflDist - directDist) / SPEED_OF_SOUND) * 1000.0;

        // 默认基底墙面反射能量 (取 500Hz~2kHz 中高频均值)
        double alphaMid = (room.wallAlpha[2] + room.wallAlpha[3] + room.wallAlpha[4]) / 3.0;
        if (face == WallFace::Floor) {
            alphaMid = (room.floorAlpha[2] + room.floorAlpha[3] + room.floorAlpha[4]) / 3.0;
        } else if (face == WallFace::Ceiling) {
            alphaMid = (room.ceilingAlpha[2] + room.ceilingAlpha[3] + room.ceilingAlpha[4]) / 3.0;
        }

        double scatterMid = 0.05;
        bool hitAbsorber = false;
        bool hitDiffuser = false;

        // 检测该第一反射点是否被用户摆放的板材覆盖
        for (const auto& panel : treatments) {
            if (panel.face == face && isPointOnPanel(face, hitPoint, panel)) {
                alphaMid = (panel.alpha[2] + panel.alpha[3] + panel.alpha[4]) / 3.0;
                scatterMid = (panel.scatter[2] + panel.scatter[3] + panel.scatter[4]) / 3.0;
                if (panel.kind == TreatmentKind::PorousAbsorber ||
                    panel.kind == TreatmentKind::BassTrap) {
                    hitAbsorber = true;
                } else if (panel.kind == TreatmentKind::Diffuser) {
                    hitDiffuser = true;
                }
            }
        }

        // 镜面反射剩余能量比例 = (1 - 吸音率) * (1 - 散射率)
        const double specularEnergy = std::max((1.0 - alphaMid) * (1.0 - scatterMid * 0.75), 0.02);
        const double distRatio = directDist / reflDist;
        const double gainDb = 20.0 * std::log10(distRatio) + 10.0 * std::log10(specularEnergy);

        rays.push_back({
            face, hitPoint, reflDist, delayMs, gainDb, hitAbsorber, hitDiffuser
        });
    }

    return rays;
}

std::vector<RoomModeInfo> AcousticEngine::solveRoomModes(
    const RoomSpec& room,
    const Vec3& source,
    const Vec3& listener,
    double lowFreqAbsorptionRatio
) {
    std::vector<RoomModeInfo> modes;
    for (int nx = 0; nx <= 4; ++nx) {
        for (int ny = 0; ny <= 3; ++ny) {
            for (int nz = 0; nz <= 4; ++nz) {
                if (nx == 0 && ny == 0 && nz == 0) continue;
                const double termX = static_cast<double>(nx) / room.width;
                const double termY = static_cast<double>(ny) / room.height;
                const double termZ = static_cast<double>(nz) / room.length;
                const double freq = 0.5 * SPEED_OF_SOUND * std::sqrt(
                    termX * termX + termY * termY + termZ * termZ
                );
                if (freq > 250.0) continue;

                // 发声源与收音点在该驻波模态下的空间耦合系数
                const double phiSrc =
                    std::cos(nx * PI * source.x / room.width) *
                    std::cos(ny * PI * source.y / room.height) *
                    std::cos(nz * PI * source.z / room.length);
                const double phiMic =
                    std::cos(nx * PI * listener.x / room.width) *
                    std::cos(ny * PI * listener.y / room.height) *
                    std::cos(nz * PI * listener.z / room.length);

                const double dampingScale = 1.0 / (1.0 + 3.2 * lowFreqAbsorptionRatio);
                const double coupling = std::abs(phiSrc * phiMic) * dampingScale;
                const double gainDb = 12.0 * coupling;
                modes.push_back({nx, ny, nz, freq, gainDb});
            }
        }
    }

    std::sort(modes.begin(), modes.end(), [](const RoomModeInfo& a, const RoomModeInfo& b) {
        return a.frequencyHz < b.frequencyHz;
    });
    return modes;
}

SimulationSummary AcousticEngine::runSimulation(
    const RoomSpec& room,
    const Vec3& source,
    const Vec3& listener,
    const std::vector<PlacedTreatment>& treatments
) {
    SimulationSummary out;
    out.rt60Untreated = computeEyringRT60(room, {});
    out.rt60Treated = computeEyringRT60(room, treatments);
    out.rt60Mid = 0.5 * (out.rt60Treated[2] + out.rt60Treated[3]);
    out.bassRatio = (out.rt60Treated[0] + out.rt60Treated[1]) /
                    std::max(out.rt60Treated[2] + out.rt60Treated[3], 0.05);
    out.reflections = traceFirstOrderReflections(room, source, listener, treatments);

    // 根据早期能量 (<50ms) 与晚期混响比估算语音/瞬态清晰度指数 C50 (dB)
    double earlyEnergy = 1.0; // 直达声归一化为 1
    for (const auto& r : out.reflections) {
        if (r.delayMs <= 50.0) {
            earlyEnergy += std::pow(10.0, r.gainDb / 10.0);
        }
    }
    const double tailFraction = std::exp(-0.69 / std::max(out.rt60Mid, 0.08));
    const double lateEnergy = std::max(tailFraction * 1.8, 0.04);
    out.clarityC50Db = 10.0 * std::log10(earlyEnergy / lateEnergy);

    const double lowAbsRatio = std::clamp(
        1.0 - (out.rt60Treated[0] / std::max(out.rt60Untreated[0], 0.1)),
        0.0, 0.85
    );
    out.dominantModes = solveRoomModes(room, source, listener, lowAbsRatio);
    return out;
}

} // namespace acoustic
