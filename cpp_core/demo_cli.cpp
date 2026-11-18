#include "acoustic_engine.hpp"
#include <iomanip>
#include <iostream>

/**
 * 独立命令行测试入口（等你安装 MinGW g++ 或 Visual Studio 后可直接编译运行）：
 *   g++ -std=c++17 -O2 cpp_core/acoustic_engine.cpp cpp_core/demo_cli.cpp -o demo_sim.exe
 *   ./demo_sim.exe
 */
int main() {
    using namespace acoustic;

    RoomSpec room;
    room.width = 3.6;
    room.height = 2.8;
    room.length = 4.8;
    room.wallAlpha = {0.10, 0.08, 0.05, 0.04, 0.04, 0.04};    // 石膏板乳胶漆墙
    room.floorAlpha = {0.15, 0.11, 0.10, 0.07, 0.06, 0.07};   // 木地板
    room.ceilingAlpha = {0.10, 0.08, 0.05, 0.04, 0.04, 0.04}; // 石膏顶

    Vec3 speaker{1.8, 1.2, 0.9};
    Vec3 listener{1.8, 1.2, 1.85}; // 38% 黄金听音点附近

    // 放置 4 个角落低频陷阱 + 左右第一反射点 10cm 吸音板
    std::vector<PlacedTreatment> panels = {
        {1, TreatmentKind::BassTrap, WallFace::Front, {0.25, 1.2, 0.25}, 0.45, 2.0, 0.45,
         {0.68, 0.88, 0.95, 0.92, 0.85, 0.80}, {0.1, 0.1, 0.1, 0.1, 0.1, 0.1}, 0.0},
        {2, TreatmentKind::BassTrap, WallFace::Front, {3.35, 1.2, 0.25}, 0.45, 2.0, 0.45,
         {0.68, 0.88, 0.95, 0.92, 0.85, 0.80}, {0.1, 0.1, 0.1, 0.1, 0.1, 0.1}, 0.0},
        {3, TreatmentKind::PorousAbsorber, WallFace::Left, {0.0, 1.2, 1.38}, 0.6, 1.2, 0.10,
         {0.38, 0.76, 0.98, 0.99, 0.96, 0.92}, {0.05, 0.05, 0.05, 0.05, 0.05, 0.05}, 0.0},
        {4, TreatmentKind::PorousAbsorber, WallFace::Right, {3.6, 1.2, 1.38}, 0.6, 1.2, 0.10,
         {0.38, 0.76, 0.98, 0.99, 0.96, 0.92}, {0.05, 0.05, 0.05, 0.05, 0.05, 0.05}, 0.0},
    };

    const auto summary = AcousticEngine::runSimulation(room, speaker, listener, panels);

    std::cout << "=== AcousticLab C++17 Engine Report ===\n";
    std::cout << std::fixed << std::setprecision(2);
    std::cout << "Mid-band RT60: " << summary.rt60Mid << " s | Bass Ratio: " << summary.bassRatio
              << " | C50 Clarity: " << summary.clarityC50Db << " dB\n\n";

    for (int i = 0; i < NUM_BANDS; ++i) {
        std::cout << std::setw(5) << static_cast<int>(OCTAVE_BANDS[i]) << " Hz : "
                  << "Raw " << summary.rt60Untreated[i] << "s  ->  Treated "
                  << summary.rt60Treated[i] << "s\n";
    }
    return 0;
}
