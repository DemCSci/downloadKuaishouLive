# jiuyi

使用 Electron + FFmpeg 保存直播流到本地文件，支持：

- 通用直播流录制（直接输入 `.flv/.m3u8` 等流地址）
- 抖音直播录制（输入 `live.douyin.com` 直播间页面地址，自动解析真实流地址）
- 自定义保存目录
- 开始录制
- 手动停止录制
- 自动处理直播结束（流断开）
- 录制中持续输出状态日志（文件大小、磁盘剩余）
- 磁盘剩余空间低于 10 GB 时自动停止并弹窗告警

## 运行环境

- Node.js 18+
- 本机已安装 `ffmpeg`，并可在终端执行 `ffmpeg -version`

## 安装与运行

```bash
npm install
npm start
```

## 打包

已配置 `electron-builder`，产物输出到 `dist/` 目录。

```bash
# 仅打包当前平台目录结构（不生成安装包）
npm run pack

# 打 macOS 安装包（dmg + zip）
npm run dist:mac

# 打 Windows x64 安装包（nsis + zip）
npm run dist:win

# 打 Windows x86(ia32) 安装包（nsis + zip）
npm run dist:win:x86

# 同时打 Windows x64 + x86(ia32)
npm run dist:win:all

# 打 Linux amd64 命令行二进制（适合无界面服务器）
npm run dist:linux:cli
```

建议：

- 在 macOS 机器上执行 `npm run dist:mac`
- 在 Windows 机器上执行 `npm run dist:win` 或 `npm run dist:win:x86`

虽然 `electron-builder` 支持跨平台构建，但在实际签名/依赖环境方面，使用目标系统原生构建最稳定。

说明：打包时会自动把 FFmpeg 一并带入安装包，目标机器通常无需额外安装 FFmpeg。
说明：本地 npm 打包脚本显式使用 `--publish never`，只构建，不直接发布。
说明：`dist:win*` 在构建前会自动下载较新 FFmpeg 到 `ffmpeg-custom/` 并随安装包分发（默认 `x64=b6.1.1`，`ia32=b6.0` 兼容回退）。

注意：

- mac 安装包建议在对应架构机器上打包（arm64 机器打 arm64 包，x64 机器打 x64 包）。
- Windows 默认按 x64 构建；x86 请使用 `npm run dist:win:x86`。
- x86 构建脚本会自动拉取 `@ffmpeg-installer/win32-ia32`，确保 x86 包内也自带 ffmpeg。
- Linux CLI 构建脚本会自动拉取 `@ffmpeg-installer/linux-x64`。
- 如需切换 FFmpeg 下载源或版本，可在打包前设置：
  - `FFMPEG_CUSTOM_RELEASE`（强制所有架构使用同一 release，默认按架构自动选择）
  - `FFMPEG_CUSTOM_BASE_URL`（默认 `https://cdn.npmmirror.com/binaries/ffmpeg-static`）

如果你用 GitHub，可以直接用仓库里的工作流同时出 mac 和 win 包：

- 文件：`.github/workflows/build.yml`
- 触发方式：GitHub Actions 手动运行 `Build Desktop App`

## GitHub 自动发布 Release

当前 workflow 已内置自动发布：

- 当你 push 标签（如 `v1.0.1`）时，会先构建 mac/win/linux 产物，再自动创建/更新对应 Release 并上传文件。
- 发布步骤使用 `secrets.GITHUB_TOKEN`（已映射到 `GH_TOKEN`），通常不需要手动创建 PAT。

如果你的仓库是私有或组织策略较严格，请确认：

- 仓库 `Settings -> Actions -> General -> Workflow permissions` 为 `Read and write permissions`
- 工作流文件中已包含 `permissions: contents: write`

## Linux 服务器 CLI 用法

如果你的服务器没有图形界面，使用 `cli.js` 或 `dist:linux:cli` 产出的命令行程序。

```bash
# 本地直接运行（需要 Node.js）
npm run cli:record -- --url "https://your-live-url.flv?token=xxx" --out-dir /data/records

# 打包 linux amd64 命令行程序
npm run dist:linux:cli

# 在 linux 服务器上执行
./dist/jiuyi-cli-linux-x64 --url "https://your-live-url.flv?token=xxx" --out-dir /data/records
```

常用参数：

- `--out` 指定完整输出文件路径
- `--out-dir` 指定输出目录
- `--threshold-gb` 磁盘保护阈值（默认 10）
- `--no-low-disk-protect` 关闭低磁盘自动停止
- `--ffmpeg` 自定义 ffmpeg 路径

## 使用说明

1. 选择录制来源：
   - 「通用直播流」：输入 `.flv/.m3u8` 等拉流地址
   - 「抖音直播」：输入 `https://live.douyin.com/...` 页面地址
2. 点击「开始录制」
3. 录制中可点击「停止录制」
4. 录制过程中会每 5 秒输出一次进度日志，包含当前文件大小和磁盘剩余空间
5. 直播结束时，程序会自动停止并提示「已结束」
6. 可点击「打开文件位置」打开保存目录
7. 若磁盘剩余空间低于 10 GB，程序会自动停止录制并弹出告警窗口

默认保存位置：系统视频目录（`app.getPath('videos')`），可在界面点击「选择保存目录」修改。

## 直播结束处理逻辑

程序会在以下情况判定为直播结束：

- FFmpeg 正常退出（退出码 0）
- FFmpeg 非正常退出，但检测到已写入媒体数据

若未拉到有效流且 FFmpeg 直接报错，则状态会显示为「异常」。

## 注意事项

- 某些平台直播链接带签名参数（如 `hwTime`/`hwSecret`）有时效，过期后会录制失败。
- 请确保你有权保存对应直播内容并遵守平台规则。
- 若 Windows 日志出现 `Video codec (c) is not implemented`，通常是 FFmpeg 版本过低。建议安装较新 FFmpeg（建议 5.x/6.x/7.x），并通过以下任一方式让应用优先使用：
  - 设置环境变量 `JIUYI_FFMPEG_PATH` 指向 `ffmpeg.exe` 完整路径
  - 将新版 `ffmpeg.exe` 放到 `jiuyi.exe` 同级目录（应用会自动检测）
