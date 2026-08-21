# RK3588 离线 Kiosk 部署运行手册

> 目标形态:RK3588(Ubuntu 22.04)单机自治。RoboFrame + bridge 原生运行,n8n(fork)以
> docker 容器运行,触控屏全屏 kiosk 显示 n8n 编辑器。**全程不联外网。**
>
> 拓扑:
>
> ```
> ┌─ RK3588 ─────────────────────────────────────────────┐
> │ [原生] RoboFrame (ros2 humble) + roboframe-bridge    │
> │            ↑ subprocess: robot-skill CLI             │
> │ [docker·host网络] n8n fork (localhost:5678)           │
> │            ↑ HTTP 127.0.0.1:8090 (bridge 仅回环)      │
> │ [桌面自启] Chromium kiosk → http://127.0.0.1:5678    │
> └──────────────────────────────────────────────────────┘
> ```

## 交付物清单(`deploy/rk3588/`)

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | n8n fork 镜像(基于官方 2.35.4 Dockerfile 摘要钉扎,arm64) |
| `docker-compose.yml` | host 网络模式运行 n8n(仅回环可达) |
| `env.offline.example` | 离线加固环境变量模板(遥测/模板/AI 全关) |
| `systemd/roboframe-bridge.service` | bridge 原生 systemd 单元(bash -lc source ROS 环境) |
| `systemd/n8n-rk3588.service` | `docker compose up --wait` 引导单元 |
| `kiosk/kiosk.sh` | 等 n8n 健康 → xset 防休眠 → Chromium 全屏 |
| `kiosk/autostart-kiosk.desktop` | 桌面会话自启入口 |
| `build-bundle.sh` | 构建机上产出镜像 tar + 文件 tar + SHA256 |
| `install.sh` | 板上一键安装(载镜像、装单元、生成密钥) |

## 构建机侧(任意 arm64,Apple Silicon Mac 亦可——与 RK3588 同架构)

```bash
# 前置:pnpm install 已完成、docker 运行中
./deploy/rk3588/build-bundle.sh            # 产出 bundle/ 目录
# 可选:bridge 离线 wheels(板子无网时装依赖用)
mkdir -p bundle/wheels
pip3 download -d bundle/wheels \
  -r <(grep -E '^(fastapi|uvicorn|pydantic)' services/roboframe-bridge/pyproject.toml || true) || \
  pip3 download -d bundle/wheels fastapi uvicorn
cp -r services/roboframe-bridge bundle/roboframe-bridge
```

整个 `bundle/` 通过 U 盘/SD 卡传到 RK3588。

## RK3588 侧安装

### 前置条件

1. Ubuntu 22.04,docker 已装(离线装法见下节)
2. RoboFrame 已跑通:`source /opt/IB_Robot/install/setup.sh && robot-skill --help` 正常
3. 桌面用户已启用自动登录(kiosk 需要桌面会话)

### 离线安装 docker(仅首次)

```bash
# 构建机上提前下载:
#   docker download: https://download.docker.com/linux/ubuntu/dists/jammy/pool/
#     containerd.io_<v>_arm64.deb  docker-ce_<v>_arm64.deb  docker-ce-cli_<v>_arm64.deb
#板上:
sudo dpkg -i containerd.io_*.deb docker-ce_*.deb docker-ce-cli_*.deb
sudo systemctl enable --now docker
```

### 执行安装

```bash
cd /path/to/bundle
IB_ROBOT_DIR=/opt/IB_Robot sudo -E ./install.sh
```

install.sh 自动完成:载入镜像 → 安装文件到 `/opt/n8n-rk3588` → 生成 bridge token
(`/etc/roboframe-bridge.env`)与 `N8N_ENCRYPTION_KEY` → 装 bridge venv(用离线 wheels)
→ 注册并启动两个 systemd 单元 → 写入 kiosk 自启。

### 验证

```bash
systemctl status roboframe-bridge --no-pager     # bridge active (running)
curl -s http://127.0.0.1:8090/v1/health          # {"status":"ok",...}
systemctl status n8n-rk3588 --no-pager           # active; --wait 已过健康检查
curl -s http://127.0.0.1:5678/healthz            # {"status":"ok",...}
# 触屏上:注销重登(或直接跑 /opt/n8n-rk3588/kiosk/kiosk.sh)应见全屏编辑器
```

### 首次配置(触屏上操作)

1. n8n 首启建管理员账号(本地 SQLite,离线无碍)
2. 建 `RoboFrameBridgeApi` 凭据:Base URL `http://127.0.0.1:8090`,Token 填
   `/etc/roboframe-bridge.env` 里的值
3. 放入工作流(导出 JSON → UI 导入;或预先烘进镜像的 workflow 模板)
4. 触控适配:Blockly 工作区在 10 寸屏可用;若字号偏小,Chromium 启动参数加
   `--force-device-scale-factor=1.25`

## 备份与恢复(仅有的两份必须备份的资产)

| 资产 | 位置 | 丢失后果 |
| --- | --- | --- |
| `N8N_ENCRYPTION_KEY` | `/opt/n8n-rk3588/env.offline` | 所有凭据不可解密 |
| n8n 数据(工作流/凭据/执行史) | docker volume `n8n-data` | 全部工作流丢失 |

```bash
# 备份(插 U 盘):
sudo tar -C /var/lib/docker/volumes -czf /media/usb/n8n-data.tgz n8n-rk3588_n8n-data
sudo cp /opt/n8n-rk3588/env.offline /media/usb/
```

## 故障排查

| 症状 | 排查 |
| --- | --- |
| kiosk 白屏 | `journalctl -u n8n-rk3588`;kiosk.sh 有 120 s 健康等待,慢启动属正常 |
| Robot 节点连不上 bridge | `curl 127.0.0.1:8090/v1/health`;bridge 单元依赖 ROS 环境,看 `journalctl -u roboframe-bridge` 是否 source 失败 |
| bridge 起但 status 报错 | RoboFrame 未启动/`ROS_DOMAIN_ID` 不一致;systemd 单元与手动 shell 需同域 |
| 屏幕黑屏休眠 | kiosk.sh 已 xset s off;若接的是 Wayland 会话改用 `wlr-randr`/GNOME 设置禁息屏 |

## 安全边界(离线形态仍需守住)

- bridge 只绑 `127.0.0.1`(compose 用 host 网络正是为了让 n8n 走回环;无任何端口暴露局域网)
- 运动授权仍只在 RoboFrame launch 时人工开启(bridge 无 authorize_motion 入口,设计红线)
- 触屏 kiosk 的浏览器是唯一 UI 面;不装 SSH 转发、不开 n8n REST 到局域网
