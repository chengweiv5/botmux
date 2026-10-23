# 评论个人授权的持久否决与恢复

评论作者身份仍由当前应用 exact reply 回读、fresh human 校验与当前 turn/worker/CLI lineage 证明取得。以下索引只负责否决与故障隔离，不能提供或替代作者身份，不使用订阅 owner。

## 运行边界

每个 app/file 的 `doc-comment-negative/<sha256>/state.json` 与 SQLite 由 daemon 宿主持有，0600/0700。首次开放个人授权前持久写入 `uncertain`（进程出生身份、PID、随机epoch），fsync 文件与目录链。标记写入或fsync失败时保持匿名，进程guard防止可见但未确认持久的字节在重试时被当授权。

没有 clean shutdown 清标记、TTL、自动恢复或退订删除。进程重建/正常退出/异常退出后，旧 app/file epoch 不匹配即匿名。被持久授权过的文档重启后新旧reply均需显式恢复；同daemon旧合法pending不被其他exact否决影响，未触达文档独立。持久空间O否决项，连接最多8个，异常guard最多1024文档；异常容量满则仅评论个人授权进程级fail-stop，IM/Ask/bot输出不受该索引影响。

主marker和目录fence同时写失败时，只要个人权限之前已开放，提前fsync的uncertain仍在，新daemon拒绝。这里依赖文件系统如实报告fsync及已确认数据不被介质永久丢弃；不能保证硬件说谎、损坏/回滚全部历史、或首次标记全写失败时能凭空留下痕迹。首次标记未可靠完成从不开放个人权限。DB/标记缺失、替换、symlink保持拒绝，不作为恢复指令。

## 显式宿主离线恢复

此操作不是 Bot owner 逐条审批，也不授权某作者。它是存储故障/epoch重启后的管理员证据审计：确认完整negative可重放，再允许未来daemon重新取得作者证明。

1. 停止目标bot评论入站，排空在途WS/poll/author admission/provider解析；停止daemon并确认无其它消费者。不要在运行daemon旁直接改文件。
2. 取得故障/退出期间完整权威编辑主体历史，核对所有丢失的异人编辑并保留exact comment/reply。无法取得权威完整回放（仅reply作者/当前文本不是edit主体历史）时**不得恢复**，旧reply保持匿名。不得把“看起来正常”填成complete。
3. 由独立OS管理员审计并签名证据payload：`version:1`、`appId`、`fileToken`、`previousEpochId`（旧state的uncertain.id）、`ingressStoppedAndDrained:true`、`authoritativeHistoryComplete:true`、`evidenceReference`（审计资料引用）、`operator`（宿主管理审计标识）、`negatives:[{commentId,replyId}]`。已有pending必须在negatives中核对；已有索引项不会删除。0600输入文件格式为`{payload: "原始JSON字节字符串", signature: "Ed25519签名base64"}`，修改任何字段会使签名无效。
4. 在宿主非agent环境显式运行：

   ```sh
   bun scripts/recover-doc-comment-negative.ts <dataDir> <0600-evidence.json> --confirm-offline-audited
   ```

   验签锚点固定为`/etc/botmux/comment-recovery/public-key.pem`，所有祖先/root-owned且不可group/other写，无symlink，不能由env/dataDir选择。密钥缺失/不安全/未签名均拒绝；本改动不生成或安装管理员密钥。private key必须由独立管理员掌握、不能放在daemon/agent同UID可读范围。命令还拒绝botmux agent上下文，检查dataDir内daemon PID均不存在活进程，并拒绝原epoch holder仍存活或不可验证；这些只是附加安全门，不是认证来源。签名管理员对停入站/排空/完整历史负责，不能签自填但未核实的声明。

5. 操作先持久审计文件和SQLite FULL合并，再写单次recovery handoff；不清uncertain。不接收token或作者open_id。恢复进程不能授权，只有之后启动的daemon能在session restore/入站前原子认领handoff并在开放前重新durable uncertain。启动会扫描已退订文档的hand-off；认领失败则拒绝启动入站，不由首次token请求延迟认领。多个进程不得共享单个app文档写者。

命令失败、DB身份不符/损坏、state缺失或审计缺失都不得手工删state、删negative或chmod后宣称已恢复。修复持久索引需要另行受审计的保留/重建流程；本入口不提供丢弃证据兜底。恢复启动仍需fresh exact reply/human与当前turn门禁，无权威历史时保持匿名是安全默认。

## 存储隔离限制

full file sandbox强制隐藏negative全树（含SQLite sidecars、epoch和恢复audit），更深workingDir/userPaths/extraWrite不得重开，Seatbelt最后再次拒绝以覆盖write-regex。scratch/credential-only同样掩蔽该目录。不隔离配置若工作目录或明确write路径覆盖negative根，启动拒绝。PID文件不再认证管理恢复；其可删性不能绕过签名。

非sandbox同UID恶意任意代码仍拥有宿主文件权限，能够直接修改存储/加载同checkout源码；拒绝路径重叠并不能隔离绝对路径，也不能保护同UID可改代码的credential-only模式。需要full sandbox（含代码完整性）或独立UID/宿主服务权限边界才能对恶意agent给出完整保证。这是阶段未闭合限制，不把本补改宣称整体安全GO。
