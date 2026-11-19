# Checkmate · 中国象棋

一个轻量的 Windows 中国象棋桌面程序，基于 Electron + TypeScript，内置真实 Pikafish 引擎与 NNUE 权重。

## 功能

- 人机对战：执红或执黑，入门 / 进阶 / 高手三档难度
- 实时评估：每走一步自动计算红黑双方分数，并标出本步质量（好棋 / 可行 / 失误 / 漏着）
- 多种提示：一次给出 3 个较优解，棋盘上以编号箭头展示
- 赛后复盘：ACPL、失误数与漏着数，逐手给出更好选择
- 棋谱保存：对局结束自动保存为 JSON
- 300×360 小窗，默认贴屏幕右下角，菜单可收起

## 环境

- Windows 10 / 11
- Node.js 24+
- 仓库已包含 Windows 版 Pikafish 引擎与 `pikafish.nnue`；相关授权见根目录文本文件

## 开发

```bash
npm install
npm run gui        # 构建并启动桌面程序
npm test           # 运行测试（含真实引擎集成测试）
npm run typecheck  # 类型检查
```

## 打包

```bash
npm run package
```

产物位于 `release/Xiangqi-win32-x64/Xiangqi.exe`。棋谱保存在 `%APPDATA%\Xiangqi\records`。
