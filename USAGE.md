# jiuyi 使用说明

本文档用于记录 `jiuyi` 的日常使用、打包和部署步骤。

## 1. 项目用途

`jiuyi` 是一个直播流录制工具，支持：

- 桌面版（Electron GUI）：macOS / Windows
- 命令行版（CLI）：Linux amd64 服务器

核心能力：

- 输入直播 URL 开始录制
- 手动停止录制
- 录制中持续输出进度（文件大小、磁盘剩余）
- 磁盘剩余低于阈值（默认 10GB）自动停止
- 录制结果保存为 `.mkv`

---

## 2. 开发环境运行（桌面版）

### 2.1 安装依赖

```bash
npm install
```

### 2.2 启动

```bash
npm start
```

启动后可在界面中：

- 输入直播链接
- 选择保存目录
- 点击「开始录制 / 停止录制」

---

## 3. 桌面版打包

### 3.1 macOS

```bash
npm run dist:mac
```

### 3.2 Windows x64

```bash
npm run dist:win
```

### 3.3 Windows x86 (ia32)

```bash
npm run dist:win:x86
```

### 3.4 Windows x64 + x86 同时打包

```bash
npm run dist:win:all
```

打包输出目录：

- `dist/`

说明：

- Windows 的 `*-unpacked` 目录可直接复制到目标机运行（需完整目录，不可只拷贝 exe）。
- 项目已配置打包内置 ffmpeg，目标机通常无需额外安装 ffmpeg。

---

## 4. Linux amd64 服务器（无界面）使用

如果服务器没有图形界面，请使用命令行版本。

### 4.1 本地直接运行 CLI（需要 Node.js）

```bash
npm run cli:record -- --url "https://your-live-url.flv?token=xxx" --out-dir /data/records
```

### 4.2 打包 Linux amd64 CLI 单文件

```bash
npm run dist:linux:cli
```

产物：

- `dist/jiuyi-cli-linux-x64`

### 4.3 在 Linux 服务器上运行

```bash
chmod +x ./jiuyi-cli-linux-x64
./jiuyi-cli-linux-x64 --url "https://your-live-url.flv?token=xxx" --out-dir /data/records
```

---

## 5. CLI 参数说明

```text
--url, -u              直播流地址（必填）
--out, -o              输出文件完整路径
--out-dir, -d          输出目录（默认 ./records）
--ffmpeg               自定义 ffmpeg 路径
--interval             进度输出间隔（秒，默认 5）
--threshold-gb         磁盘自动停止阈值（GB，默认 10）
--no-low-disk-protect  关闭低磁盘自动停止
--help, -h             查看帮助
```

示例：

```bash
./jiuyi-cli-linux-x64 \
  --url "https://your-live-url.flv?token=xxx" \
  --out /data/records/live-001.mkv \
  --threshold-gb 5
```

---

## 6. 常见问题

### 6.1 链接可播放但无法录制

- 直播 URL 可能过期（带签名参数如 `hwTime/hwSecret`）
- 重新获取最新拉流地址再试

### 6.2 录制很快停止

- 检查磁盘剩余是否低于阈值（默认 10GB）
- 可使用 `--threshold-gb` 调整，或 `--no-low-disk-protect` 关闭保护

### 6.3 复制到其他机器后无法启动

- `win-*-unpacked` 必须完整复制整个目录
- Linux 二进制需要 `chmod +x`

---

## 7. 推荐实践

- 长时间录制建议使用 Linux CLI（更适合服务器）
- 使用固定输出目录并定期清理历史文件
- 生产环境建议用进程守护（如 `systemd` / `pm2`）
