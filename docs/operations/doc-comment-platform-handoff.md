# 评论个人权限：Linux 阶段与 Mac 接力

本分支是阶段候选，不是整体发布许可。禁止用测试通过代替安全验收。macOS 的个人 token、OAuth request/status 目前固定拒绝，功能尚未完成；Bot 回复不依赖此个人权限门。不得在 Mac 上通过恢复稳定 capability tuple 直通来“修复”403。

## 当前 Linux 权限门

- 只允许本地 PTY/Tmux，session 冻结模式为 full（`true` 或 `oncall`），当前 worker 私有 IPC 提供实际 CLI/engine PID:start。配置布尔值、credential-only 标志和客户端自报 PID 都不是证明。
- daemon 观察真实 Linux mount/PID namespace、NoNewPrivs/seccomp 与 tmpfs 根；安装代码及实际依赖目录必须只读且对应宿主 inode，不允许另一路径可写映射。negative/epoch/audit 根必须隐藏，宿主 token/OAuth/凭据目录不能暴露，未来 token 文件也不能从宽泛只读 data/home 映射泄露。
- bound lark-tool `--as user`、`botmux auth request/wait` 每次校验实际 loopback socket peer、当前 worker/CLI lifetime/turn lineage 与回合开始时已有后台进程快照；token/OAuth await 后再次验证。旧后台派生的新 wrapper 即使读到当前 tuple，也不能借新作者身份。
- off、credential-only、scratch、远端或不能证明的 backend、adopt 评论保持 Bot 匿名。RPC engine 若运行在宿主而非 full sandbox，也匿名。错误/缺证据拒绝个人权限，不退回默认登录、owner 或历史 IM 身份。
- 评论不向稳定 `cli-identity` 文件发布 raw token/JWT；仅使用 bound 逐请求 broker。未绑定的评论 auth-request/status 拒绝。普通 IM/Ask 的既有独立身份流程保留。
- cold refork 在真实 CLI 证明到达前匿名；到达后还须匹配当前 exact reply 的 fresh human 记录及 managed origin。CLI restart/exit/replay、跨 daemon 旧记录不得直接恢复身份。
- poll 没有权威编辑主体时匿名；same-author WS follower 可合并正向证据，异人编辑 follower 同步否决。持久 exact negatives、预先 uncertain epoch、同 daemon guard、签名宿主恢复协议保持，见 [持久否决与恢复](doc-comment-negative-recovery.md)。

full 配置不是必然获得个人权限：安装目录作为可写项目、数据布局暴露宿主授权目录、内核证明不可读、namespace 不完整等都只会匿名。此门防受控 sandbox 中的 agent，不声称能抵御已在宿主运行的同 UID 恶意进程、被修改的 daemon 安装、内核失陷或文件系统虚假 fsync。

## Mac 继续开发前

阶段通过并推送后，在个人仓库获取精确分支；尚未推送时下面命令不可当作产物已存在：

```sh
git clone --branch fix/comment-turn-human-provenance-20261023 https://github.com/chengweiv5/botmux.git
cd botmux
git rev-parse HEAD
git status --short
```

核对交付的远端 SHA；保留该分支，不擅自 merge/rebase 已前进的 master。全新 clone 可按项目约定安装依赖；共享 node_modules 的 worktree 禁止 install。无需真实 Lark token、文档评论或 OAuth，所有验收使用假 provider。

需要 arm64 和 x86_64 的实际 Darwin 执行资源、目标 macOS 版本、Xcode/CLT SDK、Bun 项目固定版本、Node 22、tmux。先记录 `sw_vers`、`uname -m`、`xcrun --show-sdk-path`、运行时版本与受信安装/权限根布局。交叉编译、Linux mock 与签名成功不等价于目标架构内核验收。

## 最小 Mac 实现及正反验收

1. 用目标 SDK 验证原生 Mach 每消息 audit trailer 的实际 sender 身份，使用官方 BSM 解码及 PID version/birth 防复用；libproc 核对 CLI/engine/worker 父链。用户 payload、环境变量、PID 文件、稳定 bearer 不得提供主体证明。
2. 建立受信 native helper 到 daemon 的私有管道，完整个人 broker 请求经内核 sender 证明，不发可转移/replay 的外部 HTTP 放行 bearer。helper/daemon 安装及管理员信任目录必须对 agent 不可写；不引入未经授权的独立 UID 服务。
3. 验证实际 Seatbelt full policy 与当前 CLI lifetime，不复用 credential-only 标志；不可测量的 backend/adopt 匿名。保留 Linux proof，不恢复 tuple-only 放行。处理 standalone 原生资源与受信加载路径，不能使用进程外不存在的 `/$bunfs` 路径。
4. 真正 Darwin PTY 和私有 Tmux 都执行：A 作者产生常驻后台，B 新作者开始；A 通过真实 wrapper/new helper 重读 B tuple 后 token/OAuth/status 必须 provider 前拒绝，B 新 tool mock 成功。覆盖旧 ancestor 派生新工具、Mach send-right/回复权转移、FD 传递、PID 复用/reparent、异 app/session/reply、CLI restart/crash/replay。
5. token、human lookup、OAuth issue/status await 中注入回合旋转、CLI exit、否决与 epoch 变化，返回不得泄露 token；OAuth 同人门禁、IM/Ask 与 Bot 评论输出均有正反测试。实际写入探测必须证明 workingDir/sandboxPaths/extraWrite/路径别名不能重开安装/negative/audit/trust 根。
6. arm64/x86_64 分别保存命令、退出码与 mock provider 计数，跑相关回归、`bun x tsc --noEmit`、`bun run build`、`git diff --check`；无真实授权、无 live daemon 重启、无部署。双平台安全准出前不得建 PR。

当前 Linux 验证使用实际 bwrap、生产 PTY/Tmux backend、实际 worker 私有 IPC、真实 lark-tool/auth CLI wrapper及假 provider。不是所有 CLI/backend/编译态组合的端到端证明；缺少证明的组合按匿名处理。Mac 尚无实现与真机验收，接力完成前不能称整体 GO。
