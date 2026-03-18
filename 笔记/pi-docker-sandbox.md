# pi coding-agent Docker 沙箱笔记

## 目标
- 用 Docker 隔离 `pi`（`@mariozechner/pi-coding-agent`）运行环境
- 复用宿主机 `~/.pi`（登录态和配置）和 `~/.npm`（缓存）
- 在项目目录里无感使用 `pi`

## 一、怎么弄（从零搭建）

### 1. 构建基础镜像（包含 sandbox 依赖）

`coding-agent` 的 `sandbox` 扩展在 Linux 需要：
- `ripgrep` (`rg`)
- `bubblewrap` (`bwrap`)
- `socat`

构建命令（在任意目录执行）：

```bash
docker build -t pi-elegant-base -<<'EOF'
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*
EOF
```

可选验证：

```bash
docker image ls pi-elegant-base
docker run --rm pi-elegant-base bash -lc 'rg --version | head -n 1 && bwrap --version | head -n 1 && socat -V | head -n 1'
```

### 2. 直接启动 `pi`（当前目录挂载进容器）

```bash
docker run --rm -it --init --name pi-elegant \
  -w /workspace \
  -v "$(pwd):/workspace" \
  -v "$HOME/.pi:/root/.pi" \
  -v "$HOME/.npm:/root/.npm" \
  -e TZ=Asia/Shanghai \
  pi-elegant-base \
  bash -lc 'npx -y @mariozechner/pi-coding-agent@latest'
```

说明：
- `$(pwd)` 挂载当前目录，不写死路径
- 共享 `~/.pi` 后，一般不需要再显式传 API Key
- `@latest` 很关键，避免在 monorepo 场景里被本地 workspace 解析干扰

## 二、最后怎么配（一条命令无感启动）

推荐用 `zsh function`（比 alias 更稳，参数透传更完整）。

把下面内容加到 `~/.zshrc`：

```zsh
pi() {
  docker run --rm -it --init \
    -w /workspace \
    -v "$PWD:/workspace" \
    -v "$HOME/.pi:/root/.pi" \
    -v "$HOME/.npm:/root/.npm" \
    -e TZ=Asia/Shanghai \
    pi-elegant-base \
    npx -y @mariozechner/pi-coding-agent@latest "$@"
}
```

生效：

```bash
source ~/.zshrc
type pi
pi --version
```

之后在任意项目目录直接执行 `pi` 即可。

## 三、怎么用（日常）

### 普通启动

```bash
pi
```

### 透传参数

```bash
pi --version
pi --model claude-opus-4-5
pi --help
```

### 复用宿主机历史会话（重要）

`pi` 的会话目录按 `cwd` 编码分组存储在 `~/.pi/agent/sessions/`。

如果容器里把项目挂载到 `/workspace`，那么 `cwd` 从宿主机的 `/Users/...` 变成 `/workspace`，看起来就像“没读到以前的 session”。

更稳的做法是让容器内的工作目录路径和宿主机一致：

```bash
docker run --rm -it --init --name pi-elegant \
  -w "$PWD" \
  -v "$PWD:$PWD" \
  -v "$HOME/.pi:/root/.pi" \
  -v "$HOME/.npm:/root/.npm" \
  -e TZ=Asia/Shanghai \
  -e PI_CODING_AGENT_DIR=/root/.pi/agent \
  pi-elegant-base \
  npx -y @mariozechner/pi-coding-agent@latest
```

### 当容器内二次沙箱有权限问题时

如果遇到 `bwrap` 权限相关问题，可临时关闭 `coding-agent` 扩展沙箱，仅保留 Docker 隔离层：

```bash
pi --no-sandbox
```

## 四、踩坑记录（这次实际遇到的）

### 1. `sh: 1: pi: not found`

触发场景：
- 在 monorepo 根目录里用 `npx -y @mariozechner/pi-coding-agent`，可能被 workspace 解析影响

处理：
- 显式写版本：`npx -y @mariozechner/pi-coding-agent@latest`

### 2. `Sandbox initialization failed: Required: rg, bwrap, socat`

触发场景：
- `sandbox` 扩展启用，但基础镜像缺依赖

处理：
- 在镜像中预装 `ripgrep`、`bubblewrap`、`socat`（见上文构建命令）

### 3. `Unable to find image 'pi-elegant-base:latest' locally`

触发场景：
- 直接 `docker run pi-elegant-base`，但本地未先 `docker build`

处理：
- 先执行构建命令，确认 `docker image ls pi-elegant-base` 可见后再运行

### 4. “映射了 `~/.pi` 但 pi 没读到”

关键点：
- `coding-agent` 的全局目录默认是 `~/.pi/agent`，不是 `~/.pi` 根目录
- 如有疑义，直接在容器里固定：`-e PI_CODING_AGENT_DIR=/root/.pi/agent`
