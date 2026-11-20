# 联机对战（内网穿透）设计文档

- 日期：2026-11-20
- 状态：待评审
- 目标读者：实现者（本人）
- 关联文档：`docs/superpowers/specs/2026-11-19-xiangqi-cli-pikafish-design.md`

## 1. 背景与目标

当前桌面版只有本地人机对弈。用户希望在同一软件内与朋友联机：

1. 房主点击“联机对战”，软件生成一个邀请 URL。
2. 对方在软件中粘贴 URL 加入；房主手动同意后开始对局。
3. 对局运行在房主机器的渲染进程内，房主是唯一权威。
4. 软件关闭、取消联机、窗口关闭或渲染进程崩溃时，内网穿透必须立即停止。

安全底线：**绝对不能遗留僵尸穿透进程**。本设计从架构上消除外部穿透进程，而不是依赖退出时清理。

## 2. 范围

### 做

- 单客联机：一个房主、一个对手，同一时间一局
- 邀请 URL 生成、复制、粘贴加入
- 房主手动同意/拒绝加入
- 20:00 总时 + 2:30 单步限时的棋钟
- 断线重连（2 分钟窗口，断线期间暂停棋钟）
- 悔棋请求、求和请求、认输
- 联机期间关闭引擎辅助（提示、实时评估、推演、赛中复盘）
- 对局结束后回到本地模式，可复盘、保存、导出
- 全生命周期清理：取消、退出、窗口关闭、崩溃、异常

### 不做

- 观战、匹配大厅、账号体系、战绩云同步
- 聊天、表情、语音
- 多步悔棋、裁判介入、长将判负等竞赛规则扩展
- 局域网直连或自建公网中继服务器
- 联机过程中从 FEN/存档开局
- 端到端加密（穿透服务可见明文，详见 12.4）
- 防作弊（房主理论上可用外部引擎，v1 只做功能层面的关闭）

## 3. 已确认的关键决策

| 主题 | 决策 |
|---|---|
| 传输 | 内嵌内网穿透，分享 URL |
| 穿透实现 | 纯 Node 实现，运行在 Electron 主进程内，不产生子进程 |
| 依赖 | npm `localtunnel`（纯 JS 客户端，无子进程），由 esbuild 打进主进程包 |
| 对局协议 | HTTP 长轮询 + 全量快照 + 单调 revision |
| 权威方 | 房主渲染进程：棋局、棋钟、请求裁决全部在房主侧 |
| 主进程职责 | HTTP 服务、穿透、长轮询、存活检测、生命周期清理；不含棋规 |
| 本地服务绑定 | 仅 `127.0.0.1`，随机端口 |
| 鉴权 | 256 位随机邀请令牌，放在 URL fragment；仅进内存，不落盘 |
| 房间规模 | 单客；房主同意后才进入对局 |
| 计时 | 每方总时 20:00；轮到走子时单步限时 2:30；走子时两者同时扣减；任一耗尽即判负 |
| 断线 | 12 秒无心跳判定离线并暂停棋钟；2 分钟内可重连；超时判离线方负 |
| 悔棋 | 恢复到请求方上一手之前，并恢复当时的双方棋钟；需对手同意 |
| 求和 | 请求需对手同意；走子视为拒绝 |
| 公平性 | 联机期间引擎 IPC 在渲染进程与主进程双重禁用 |

## 4. 总体架构

```
┌──────────────────────── 房主电脑 ────────────────────────┐
│  Electron 渲染进程（权威）          Electron 主进程         │
│  ┌──────────────────────┐   IPC   ┌────────────────────┐  │
│  │ Game + 棋钟 + 请求裁决 │◄───────►│ 会话状态机          │  │
│  │ OnlineGame 控制器     │ host-   │ 127.0.0.1 HTTP 服务 │  │
│  │ UI（棋盘/棋钟/面板）   │ snapshot│ 长轮询队列          │  │
│  └──────────────────────┘         │ localtunnel 客户端   │  │
│                                   └─────────┬──────────┘  │
└─────────────────────────────────────────────┼─────────────┘
                                              │ 出站 TCP/TLS
                                    ┌─────────▼──────────┐
                                    │ localtunnel 公共服务 │
                                    └─────────┬──────────┘
                                              │ HTTPS
┌──────────────────────── 客人电脑 ───────────┼─────────────┐
│  Electron 渲染进程                          │             │
│  ┌──────────────────────┐   IPC   ┌─────────▼──────────┐  │
│  │ 快照重建的只读棋局     │◄───────►│ 客人 HTTP 客户端     │  │
│  │ UI（棋盘/棋钟/面板）   │ snapshot│ 长轮询 + 心跳        │  │
│  └──────────────────────┘         └────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

要点：

- 穿透与本地 HTTP 服务都只存在于主进程，且都是普通 I/O，不启动任何子进程。
- 客人永远不直接裁决对局。它提交动作，由房主渲染进程校验并回传完整快照。
- 渲染进程崩溃或窗口关闭时，主进程立即 `stop()`；即使清理钩子异常，进程退出也会让操作系统关闭所有套接字。

## 5. 代码边界

| 文件 | 职责 |
|---|---|
| `src/net/protocol.ts` | 协议常量、类型、邀请 URL 解析、快照/动作校验（纯函数） |
| `src/net/clock.ts` | 棋钟模型：扣时、暂停、恢复、走子、超时判定（纯函数，时间由参数注入） |
| `src/net/onlineGame.ts` | 房主权威控制器：包住 `Game`、棋钟、每手棋钟快照、pending 请求、revision |
| `src/net/snapshotGame.ts` | 由快照重建客人侧 `Game`，生成中文记谱 |
| `electron/online/hostServer.ts` | 本地 HTTP 服务、令牌校验、单客会话、长轮询队列、心跳时间戳 |
| `electron/online/tunnel.ts` | `localtunnel` 封装：启动、URL、幂等关闭、异常回调 |
| `electron/online/client.ts` | 客人 HTTP 客户端：join、poll、ping、action、重试与关闭 |
| `electron/online/session.ts` | 主进程会话状态机与 IPC 桥接；所有清理钩子都调用它的幂等 `stop()` |
| `electron/online/ipc.ts` | 注册 `online:*` IPC，校验来自渲染进程的参数 |
| `src/ui/online.ts` | 联机面板：创建/加入/邀请 URL/审批/棋钟/请求；不持有对局权威 |
| `src/ui/app.ts` | 模式切换、落子路由、公平性门禁、结束后恢复本地功能 |
| `src/ui/api.ts`、`electron/preload.ts` | 暴露联机 IPC |
| `electron/main.ts` | 接入会话、退出钩子、引擎禁用守卫 |

依赖方向：`src/net/*` 不依赖 Electron 或 DOM，可在 vitest 中直接测试；`electron/online/*` 不依赖棋规，只处理网络与生命周期；对局权威只存在于 `onlineGame.ts` 与房主渲染进程。

## 6. 网络与鉴权

### 6.1 邀请 URL

- 令牌：`crypto.randomBytes(32).toString('base64url')`，43 个字符，256 位熵。
- URL：`${tunnel.url}/#${token}`。
- 令牌放在 fragment：浏览器与 localtunnel 服务端都不会把 fragment 发送到服务器，只有粘贴到本软件后由主进程解析。
- 令牌只保存在主进程内存；不写入设置、日志、棋谱。
- 客人加入时把令牌放入 `Authorization: Bearer <token>`。
- 接受格式：
  - `https://<任意主机>/` + `#<43 位 base64url>`
  - `http://127.0.0.1:<port>/` + 同上（仅用于本机集成测试与冒烟）
- 拒绝：非 http(s)、带用户名密码、公网 http、fragment 长度不符、包含额外路径或查询串。

### 6.2 HTTP API

所有路由位于 `/xq/v1`，只接受 JSON，`Content-Type: application/json`，请求体上限 16 KB。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/join` | 客人凭令牌加入；返回 `{phase}`；已有客人在线/重连窗口内返回 409 |
| `GET` | `/poll?rev=N` | 长轮询；`N` 小于最新 revision 立即返回快照，否则最多挂起 25 秒，超时 204 |
| `POST` | `/ping` | 客人每 5 秒心跳；主进程本地处理，不经过渲染进程 |
| `POST` | `/action` | 提交客人动作；转发给房主渲染进程，成功后返回最新快照，房间不可用返回 410 |
| 其他 | 任意 | 404 |

- 错误统一为 `{error: {code, message}}`：`bad_request`、`unauthorized`、`busy`、`rejected`、`timeout`、`host_unavailable`、`closed`。
- 令牌比较使用 `crypto.timingSafeEqual`。
- 单客：令牌对应唯一会话；同一时间只允许一个已批准的客人。
- 简单令牌桶限流：每令牌 20 请求/秒，超出 429。
- 客人客户端统一发送 `User-Agent: Xiangqi/0.1`、`Accept: application/json`、`Bypass-Tunnel-Reminder: true`，避免 localtunnel 的浏览器提醒页拦截 API 请求。
- 不返回 HTML，不提供静态文件，不接受任意路径参数。

### 6.3 会话与重连

- 主进程维护 `sessionId`（32 字节随机）、`token`、`lastSeen`、`approved`、`disconnectedAt`。
- 判离线：`now - lastSeen > 12s`（心跳、轮询、动作都会刷新）。客人每 5 秒心跳，12 秒宽限可容忍一次丢包。
- 重连：客人的轮询与心跳在 2 分钟内持续重试；令牌仍有效时自动恢复，无需重新审批。
- 2 分钟未恢复：主进程通知房主渲染进程 `guest-timeout`，房主裁决为客人负、`endReason = 'disconnect'`。
- 房主取消联机或退出：服务与穿透关闭，客人收到 410/连接失败。
- 大厅 30 分钟无人加入自动关闭房间；对局结束 10 分钟后自动关闭会话。
- 穿透断开（`close`/`error`）不自动重连，直接结束会话并提示，避免在后台形成长期驻留。

### 6.4 快照与 revision

- 房主每次权威变化递增 `rev`（从 1 开始），只保留最新快照。
- 客人动作的 HTTP 响应带最新快照；同时长轮询也返回同一快照，两条路径都以 `rev` 去重。
- 客人忽略 `rev` 不大于本地的快照。

```ts
interface OnlineSnapshot {
  version: 1;
  rev: number;
  phase: 'lobby' | 'playing' | 'ended';
  hostSide: Side;
  initialFen: string;        // 联机固定标准开局
  moves: string[];           // UCI，客人本地重建中文记谱
  result: GameResult | null;
  endReason: EndReason | null;
  clock: ClockSnapshot;
  paused: boolean;
  pending: { kind: 'undo' | 'draw'; by: Side } | null;
  message: string | null;    // 例如“对方断线，等待重连”
}
```

- 全量快照而不是增量事件：棋谱最多几百手，体积几 KB，避免增量丢失与乱序问题。
- 客人收到快照后从 `initialFen` + `moves` 重建 `Game`，所有合法性、终局信息由房主给出。
- `suppress` 不需要：客人 UI 只渲染快照。

## 7. 对局权威与数据流

### 7.1 房主落子

1. 房主点击棋盘 → `onlineGame.applyMove(hostSide, move, now)`。
2. 校验行棋方、合法性、棋钟未超时。
3. `Game.move` → 扣时、切换回合并重置单步 2:30 → 保存该手后的棋钟快照 → `rev++`。
4. 渲染进程调用 `hostSnapshot(snapshot)`；主进程更新最新快照并唤醒长轮询。

### 7.2 客人落子

1. 客人 UI 只在“轮到自己且未暂停”时允许选子。
2. 渲染进程调用 `online:guest-action {type:'move', uci}`。
3. 主进程 `POST /action` 到房主主机；房主主进程转发 `online:host-event {type:'action'}`。
4. 房主渲染进程校验并应用；拒绝时返回原因（非法着法、未轮到、已暂停、有未决悔棋）。
5. 主进程以宿主快照回应客人的 HTTP 请求；客人渲染进程按快照重绘。
6. 房主渲染进程对每次动作在 5 秒内必须回应；超时后客人收到 `timeout`，以长轮询结果为准。

### 7.3 客人侧重建

- 客人 `Game` 仅用于显示与中文记谱，不接受本地直接落子。
- 重建失败（快照非法）视为协议错误：断开并提示，不进入对局。

### 7.4 开始条件

- 房主创建房间时选择红/黑；红方先行。
- 房间创建时不初始化棋局；房主同意加入时才创建 `Game(INITIAL_FEN)` 并发布 `phase='playing'` 的快照。
- 棋钟在房主同意、发布首张 playing 快照时开始走红方。
- 联机固定标准开局，不支持 FEN/存档开局。

## 8. 计时

### 8.1 参数

- 每方总时：`TOTAL_MS = 20 * 60_000`。
- 单步限时：`STEP_MS = 2 * 60_000 + 30_000`。
- 固定值，v1 不提供设置项。

### 8.2 规则

- 只有当前行棋方的两个倒计时同时走：总时与单步限时从同一段真实时间扣减，不重复扣。
- 走子时：
  1. 先按当前时间扣时；
  2. 若单步剩余 ≤ 0 → 行棋方负，`endReason='timeout_step'`；
  3. 若该方总时 ≤ 0 → 行棋方负，`endReason='timeout_total'`；
  4. 否则落子、切换行棋方，新行棋方单步重置为 2:30。
- 红方第一步同样受 2:30 单步限制。
- 房主渲染进程每 250ms 检查一次超时；即使双方都不操作，也会裁决并发布快照。
- 客人本地只做显示倒计时，归零后等待房主裁决，不自行判负。

### 8.3 棋钟快照与悔棋

- 房主在每手结束后保存一份棋钟快照（双方总时、当前单步、行棋方）。
- 悔棋获准时恢复到“请求方上一手之前”的那份快照，相当于退还该手及之后消耗的时间。
- 暂停期间不扣时；恢复时从冻结值继续。
- 快照中的时间：`{redMs, blackMs, stepMs, turn, running}`；客人用收到快照的时刻做本地插值，收到新快照即校正。

### 8.4 显示

- 常驻联机信息条：`红 18:23 · 步 2:14`、`黑 20:00`、对方连接状态。
- 剩余 20 秒内显示到 0.1 秒；超时后显示“红方单步超时”或“黑方总时耗尽”。

## 9. 悔棋、求和、认输

### 9.1 悔棋

- 任意一方可在 `playing` 阶段发起，前提是自己至少走过一手。
- 同一时间只允许一个未决请求（悔棋或求和）。
- 悔棋请求未决期间双方都不能落子；请求方可撤回。
- 对手同意：回退到请求方上一手之前，行棋方变为请求方，恢复该时点棋钟快照，清除 pending，`rev++`。
- 对手拒绝或请求方撤回：清除 pending，棋钟继续（累计时间不退还）。
- 请求与回应都通过快照广播；客人只能通过 `online:guest-action` 发起/回应。
- 不限制次数；对局结束时未决请求自动作废。

### 9.2 求和

- 任意一方可在 `playing` 阶段发起；对手同意则 `result='draw'`、`endReason='agreement'`。
- 求和未决期间允许落子；任一方落子即视为拒绝并清除 pending。
- 对手也可明确拒绝。

### 9.3 认输

- 任意一方可认输，立即结束，`endReason='resign'`。
- 客人点击“离开”且对局进行中时，先提交认输并等待房主处理（最多 5 秒），再离开；认输无法送达或超时则按断线规则处理。

## 10. 断线、暂停与结束

| 事件 | 行为 |
|---|---|
| 客人 12 秒无心跳/轮询/动作 | 主进程通知房主渲染进程；房主标记离线、暂停棋钟、禁止双方落子，快照 `message='对方断线，等待重连'` |
| 客人在 2 分钟内恢复 | 标记在线，恢复棋钟，发布校正快照 |
| 客人 2 分钟未恢复 | 客人负，`endReason='disconnect'`，`phase='ended'` |
| 房主网络/穿透断开 | 会话结束；客人 2 分钟重试后仍失败，显示“与房主失去连接”，本地棋局标记中止 |
| 房主点击“结束联机”且对局进行中 | 二次确认；确认后双方对局中止（`aborted`），关闭服务与穿透 |
| 房主关闭窗口/退出/崩溃 | 立即 `stop()`；客人按上一行处理 |
| 对局自然结束 | 棋钟停止，双方显示结果；会话保持到房主点击“结束联机”，10 分钟后自动关闭 |
| 大厅 30 分钟无人加入 | 自动关闭房间并停止穿透 |

- 断线暂停时，“客人 2 分钟未恢复”的计时从首次判定离线开始。
- 房主侧不区分“客人主动离开”和“客人断网”：主动离开会先发认输，因此通常显示认输结果。

## 11. 生命周期与僵尸穿透防护

### 11.1 结构保证

- 不调用 `child_process`、`spawn`、`exec`、`fork`、`worker_threads` 启动任何外部穿透程序。
- `localtunnel` 是普通 npm 库，在主进程内用 TCP/TLS 套接字工作；没有可被“遗留”的进程。
- 穿透连接、HTTP 服务、计时器、待决轮询全部由一个会话对象持有。

### 11.2 幂等 stop

```ts
interface OnlineSession {
  stop(reason: string): Promise<void>; // 幂等，重复调用返回同一个 Promise
}
```

`stop()` 依次执行且每步容错：

1. 标记会话结束，拒绝新的 IPC/HTTP 请求；
2. 清除心跳、离线检测、自动关闭等所有定时器；
3. 结束所有挂起的长轮询（返回 410/204）；
4. `server.closeAllConnections()` 后 `server.close()`；
5. `tunnel.close()`（内部关闭所有套接字）；
6. 通知渲染进程会话已结束；
7. 置空引用，释放端口。

每一步用 `try/catch` 包裹并记录非敏感日志；任一步失败不阻止后续步骤。

### 11.3 触发点

- 渲染进程“结束联机/取消联机”
- 渲染进程“离开房间”（客人）
- 主窗口 `closed`
- `webContents` 的 `render-process-gone`
- `app.on('before-quit')`
- `app.on('window-all-closed')` 触发的退出
- 穿透 `close`/`error`
- HTTP 服务 `error`
- 主进程未捕获异常导致退出

`before-quit` 处理：

```ts
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !online.isActive()) return;
  event.preventDefault();
  quitting = true;
  Promise.race([online.stop('app-quit'), delay(3000)])
    .finally(() => app.quit());
});
```

- `stop()` 正常在数百毫秒内完成；3 秒仅作为兜底。
- 即使 `stop()` 卡住，进程最终退出时操作系统会关闭所有 TCP 套接字，穿透服务端会收到连接断开，不会留下本地进程。
- 穿透异常断开时直接结束会话，不做无限自动重连。

### 11.4 可验证性

- `stop()` 后 `server.listening === false`，端口可再次绑定。
- `stop()` 后对邀请 URL 的请求在 5 秒内失败或返回 404（穿透端已无目标）。
- 仓库中联机相关目录不得出现 `child_process` 导入（自动化静态检查）。
- 任务管理器中不存在任何穿透相关进程，因为从未创建。

## 12. 安全设计

### 12.1 网络暴露面

- 本地服务只绑定 `127.0.0.1`，不对局域网开放。
- 唯一入口是 HTTPS 邀请 URL。
- 路由固定、参数白名单、请求体上限、JSON 解析失败即 400。

### 12.2 鉴权

- 256 位邀请令牌；常量时间比较。
- 令牌同时是加入凭证与会话凭证；主进程不落盘、不写日志。
- 房主手动同意是第二道门；仅持令牌不能直接落子。
- 单客与单房间限制；拒绝后可继续等待新的加入请求。

### 12.3 对局完整性

- 客人所有动作在房主侧重新校验：轮次、合法性、计时、pending 状态。
- `actionId` 去重（保留最近 20 个），重复提交返回最新快照，不重复落子。
- 快照 `rev` 单调；客人忽略过期快照。
- 房主不接受客人发来的快照或棋谱。

### 12.4 信任与隐私

- 穿透服务（localtunnel 公共服务）可见转发的明文 HTTP 内容：棋步、令牌、房间状态。
- 邀请令牌不在 HTTP 请求路径或查询串中，避免被穿透服务日志记录；但加入后仍在请求头中出现。
- 不传输任何个人身份信息；不保存远端地址。
- 房主拥有完全权威，理论上可使用外部引擎作弊；v1 不防作弊，仅关闭软件内引擎功能。

### 12.5 资源限制

- 单客户、单房间、最多 2 个并发长轮询。
- 每令牌 20 请求/秒限流；`/join` 全局最多 30 次/分钟，防止未知令牌被持续尝试。
- 快照与存档一致，最多 1000 个半回合；超出按协议错误拒绝。
- 长轮询上限 25 秒，超时释放连接，避免连接堆积。

## 13. UI 与公平性

### 13.1 入口与面板

- 控制栏新增“联机”按钮，打开联机模态框（复用现有 `modal` 样式）。
- 创建房间：
  - 选择房主执红/执黑；
  - “创建房间”后显示邀请 URL（只读文本框）+“复制”+“结束联机”；
  - 状态：穿透启动中 / 等待加入 / 对方请求加入 / 对局中 / 已结束 / 启动失败。
- 加入房间：
  - 粘贴 URL +“加入”；
  - 状态：连接中 / 等待房主同意 / 已拒绝 / 对局中。
- 房主收到加入请求时弹窗：“有玩家请求加入”，提供“同意/拒绝”。
- 对局中面板显示：双方总时、当前单步、对方连接状态、悔棋/求和/认输按钮。
- 收到请求时显示“对方请求悔棋/求和”，提供“同意/拒绝”；悔棋请求方额外有“撤回”。
- 联机信息条常驻棋盘上方；模态框可关闭但会话继续。

### 13.2 公平性门禁

联机会话处于 active（lobby/playing/ended 且未 stop）时：

| 功能 | 状态 |
|---|---|
| 提示 | 禁用 |
| 实时评估 | 隐藏分数，显示“联机模式已关闭评估” |
| 推演 / 上一步 / 下一步 | 禁用 |
| 赛中复盘 | 禁用 |
| 新局 / 导入 FEN / 载入存档 / 从文件载入 | 禁用 |
| 难度与执方选择 | 禁用 |
| 本地悔棋 | 替换为联机悔棋请求 |
| 认输 | 走联机认输 |
| 保存 / 导出 | 允许 |
| 棋谱查看 | 允许 |

- 渲染进程门禁用于界面；主进程在 `engine:search` 处理器中再次检查会话是否 active，active 时直接拒绝，确保不会误调用引擎。
- 会话 `stop()` 后恢复本地功能；当前棋盘保留为本地棋局，可正常复盘、保存、导出。
- 客人同样禁用引擎功能，保持行为一致。

### 13.3 模式与本地棋局

- 应用模式：`local`、`online-host`、`online-guest`。
- 创建/加入房间前，若当前本地棋局已有走子，确认“联机对战会替换当前棋局”。
- 进入联机前取消进行中的 AI 落子、提示、评估、推演与复盘；沿用现有 generation 机制忽略迟到的引擎结果。
- 联机固定标准开局，执方由房主决定。
- 会话结束后，联机棋局成为当前本地棋局；此前的本地棋局不自动保存。

## 14. 类型与接口

### 14.1 协议类型

```ts
export const PROTOCOL_VERSION = 1;
export const TOTAL_MS = 1_200_000;
export const STEP_MS = 150_000;

export type OnlinePhase = 'lobby' | 'playing' | 'ended';
export type OnlineRole = 'host' | 'guest';

export interface ClockSnapshot {
  redMs: number;
  blackMs: number;
  stepMs: number;
  turn: Side;
  running: boolean;
}

export interface OnlineSnapshot {
  version: 1;
  rev: number;
  phase: OnlinePhase;
  hostSide: Side;
  initialFen: string;
  moves: string[];
  result: GameResult | null;
  endReason: EndReason | null;
  clock: ClockSnapshot;
  paused: boolean;
  pending: { kind: 'undo' | 'draw'; by: Side } | null;
  message: string | null;
}

export type GuestAction =
  | { type: 'move'; uci: string }
  | { type: 'undo-request' }
  | { type: 'undo-response'; accept: boolean }
  | { type: 'undo-cancel' }
  | { type: 'draw-offer' }
  | { type: 'draw-response'; accept: boolean }
  | { type: 'resign' };
```

### 14.2 结束原因扩展

在 `src/types.ts` 的 `EndReason` 中增加：

```ts
| 'timeout_step'
| 'timeout_total'
| 'disconnect'
| 'agreement'
```

- 现有 `checkmate`、`stalemate`、`move_limit`、`repetition`、`resign`、`aborted` 不变。
- 存档 `SavedGame.endReason` 沿用同一联合类型；旧文件可正常读取。
- 同步更新 `src/storage/archive.ts` 的 `REASONS` 白名单，否则新结束原因会被导入/载入拒绝；旧文件无需迁移。

### 14.3 棋钟 API

```ts
interface ClockState {
  redMs: number;
  blackMs: number;
  stepMs: number;
  turn: Side;
  running: boolean;
  updatedAt: number;
}

createClock(turn: Side, now: number): ClockState
tick(state: ClockState, now: number): ClockState
pause(state: ClockState, now: number): ClockState
resume(state: ClockState, now: number): ClockState
commitMove(state: ClockState, now: number, mover: Side):
  { state: ClockState; timeout: 'step' | 'total' | null }
clockSnapshot(state: ClockState): ClockSnapshot
restoreClock(clock: ClockSnapshot, now: number): ClockState
```

- 所有函数以传入的 `now` 为准，模块内部不启动定时器，便于测试。
- `tick` 只扣当前行棋方，总时与单步扣同样多。
- `commitMove` 校验 `mover === state.turn`，然后扣时并判定超时。

### 14.4 房主控制器 API

```ts
class OnlineGame {
  constructor(hostSide: Side, now: number);
  begin(now: number): OnlineSnapshot;
  applyHostMove(move: Move, now: number): ActionResult;
  applyGuestAction(action: GuestAction, now: number): ActionResult;
  checkTimeout(now: number): OnlineSnapshot | null;
  onGuestDisconnected(now: number): OnlineSnapshot;
  onGuestReconnected(now: number): OnlineSnapshot;
  onGuestTimeout(now: number): OnlineSnapshot;
  endByHostAbort(now: number): OnlineSnapshot;
  snapshot(now: number): OnlineSnapshot;
}

interface ActionResult {
  accepted: boolean;
  message: string | null;
  snapshot: OnlineSnapshot;
}
```

- 控制器不直接发网络请求；快照由渲染进程通过 IPC 交给主进程。
- 客人动作中的 `move` 只允许来自客人执方；房主自己的落子走 `applyHostMove`。

### 14.5 IPC

渲染进程可见：

```ts
interface OnlineApi {
  hostStart(hostSide: Side): Promise<{ url: string; localUrl?: string }>;
  hostStop(): Promise<void>;
  hostDecision(accept: boolean): Promise<void>;
  hostSnapshot(snapshot: OnlineSnapshot): Promise<void>;
  hostReply(
    actionId: string,
    accepted: boolean,
    message: string | null,
    snapshot: OnlineSnapshot,
  ): Promise<void>;
  guestJoin(url: string): Promise<{ phase: OnlinePhase }>;
  guestAction(action: GuestAction): Promise<{ snapshot: OnlineSnapshot | null }>;
  guestLeave(): Promise<void>;
  getOnlineStatus(): Promise<OnlineStatus>;
  onOnlineEvent(callback: (event: OnlineEvent) => void): () => void;
}
```

- `hostSnapshot` 用于房主主动变化（房主落子、断线暂停/恢复、超时、结束）。
- `hostReply` 同时携带并发布最新快照，作为客人动作 HTTP 请求的响应，避免“回复先于快照”的竞态。
- 所有快照都由房主渲染进程生成并递增 `rev`；主进程只做单调性校验与转发。

主进程 → 渲染进程事件：

```ts
type OnlineEvent =
  | { type: 'status'; status: OnlineStatus }
  | { type: 'host-guest-joined'; sessionId: string }
  | { type: 'host-guest-closed'; reason: string }
  | { type: 'host-action'; actionId: string; action: GuestAction }
  | { type: 'host-guest-disconnected' }
  | { type: 'host-guest-reconnected' }
  | { type: 'host-guest-timeout' }
  | { type: 'snapshot'; snapshot: OnlineSnapshot }
  | { type: 'closed'; reason: string };
```

- `localUrl` 仅在 `XIANGQI_ONLINE_SMOKE_LOCAL=1` 时返回，供冒烟测试绕过公网穿透；该模式下跳过 localtunnel，只启动 `127.0.0.1` 服务。正常运行时 `localUrl` 为 `undefined`，真实穿透路径不受影响。
- 所有 IPC 入参在主进程重新校验；渲染进程不可信值不直接进入网络或文件。

## 15. 错误处理

| 场景 | 行为 |
|---|---|
| 邀请 URL 无法解析 | 输入框下方提示格式错误，不发起连接 |
| 穿透启动失败/超时（15 秒） | 关闭本地服务，面板显示“内网穿透不可用”，可重试 |
| 穿透中断开 | 立即结束会话；房主提示“穿透连接中断” |
| 令牌错误 | 401；客人显示“邀请无效或房间已关闭” |
| 房间已有玩家 | 409；客人显示“房间已有玩家” |
| 房主拒绝 | 客人显示“房主拒绝加入”，本次会话结束，房间继续等待 |
| 房主 5 秒未回应动作 | 客人收到超时提示；长轮询会补齐最终状态 |
| 非法/越权动作 | 房主拒绝并回传原因，棋局不变 |
| 快照校验失败 | 客人断开并提示协议错误，不渲染可疑局面 |
| 客人 2 分钟未重连 | 房主判客人负；客人重连后看到结果 |
| 房主退出 | 客人 2 分钟内持续重试，失败后标记对局中止并回到本地模式 |
| 引擎在联机中被调用 | 主进程拒绝并返回错误，不执行搜索 |
| `stop()` 中某步失败 | 记录日志并继续后续清理；3 秒兜底后退出 |

## 16. 测试与验收

### 16.1 单元测试（vitest）

- `tests/net/protocol.test.ts`
  - 邀请 URL：合法 https、本机 http、非法协议、缺 fragment、错误长度、带路径/查询串
  - 快照校验：字段类型、moves 上限、rev 正整数、UCI 格式
  - 客人动作校验：未知类型、多余字段、非法 UCI
- `tests/net/clock.test.ts`
  - 初始 20:00/2:30；单步与总时同步扣减
  - 走子切换行棋方并重置单步
  - 单步超时、总时超时、红方第一步超时
  - 暂停期间不扣时；暂停后恢复
  - 快照/恢复往返一致；负数钳制为 0
- `tests/net/onlineGame.test.ts`
  - 房主与客人只能在自己的回合落子
  - 非法着法、重复 actionId、过期 rev
  - 悔棋回退到请求方上一手之前并恢复棋钟
  - 悔棋 pending 阻止落子、可撤回；求和被走子隐式拒绝
  - 求和同意、认输、超时裁决、断线暂停/恢复/判负
  - 快照可由客人侧重建为等价 `Game`
- `tests/net/snapshotGame.test.ts`
  - 由快照重建后的 FEN、中文记谱、结果与房主一致

### 16.2 主进程集成测试（回环）

- `tests/electron/hostServer.test.ts`
  - 仅绑定 `127.0.0.1`
  - 无令牌/错令牌 401；单客 409；未批准动作拒绝
  - 长轮询：无新快照时挂起，发布后立即返回；`rev` 落后立即返回
  - 心跳刷新 `lastSeen`；12 秒后标记离线；2 分钟触发超时回调
  - `close()` 后端口释放、挂起请求结束、再次 `close()` 安全
- `tests/electron/session.test.ts`
  - 注入假穿透对象（仅测试用），验证 `stop()` 幂等、`tunnel.close()` 恰好一次
  - 模拟 `before-quit`/窗口关闭/渲染崩溃路径，均调用 `stop()`
  - 会话结束后所有定时器清理，事件循环无残留句柄
- `tests/electron/staticGuard.test.ts`
  - 扫描 `electron/online/**`、`src/net/**`，禁止 `child_process`、`worker_threads`、`spawn`、`exec` 导入

### 16.3 真实穿透集成（可选，需显式开启）

- 设置 `XIANGQI_ONLINE_TUNNEL=1` 时运行 `tests/electron/tunnel.live.test.ts`：
  - 启动本机 HTTP 服务 → 建立真实 localtunnel → 通过公网 URL 请求 `/xq/v1/...`
  - 关闭 → 5 秒内 URL 不可用、端口释放
- 默认 `npm test` 不启用，避免公网抖动导致失败；发布前至少手动跑一次。
- 回环测试中的隧道替换只用于确定性地验证清理路径，真实依赖由本节与手动验收覆盖，不构成“桩引擎”式的功能降级。

### 16.4 UI 冒烟（Playwright Electron）

- 设置 `XIANGQI_ONLINE_SMOKE_LOCAL=1` 启动两个独立用户目录的实例：
  - 房主创建房间并取得 `localUrl`；客人用 `localUrl#令牌` 加入
  - 房主同意后双方看到同一棋盘
  - 双方各走一手，棋钟在走子后切换与扣减
  - 悔棋请求被拒绝/同意各一次；求和同意结束对局
  - 联机期间提示、评估、推演、复盘、新局按钮不可用
  - 房主结束联机后，双方恢复本地功能，可复盘
- 手动验收（真实穿透）：
  - 两台机器加入、完整下一局
  - 客人断网 30 秒后恢复，棋钟从冻结值继续
  - 客人断网超过 2 分钟判负
  - 房主取消联机后邀请 URL 立即失效
  - 关闭房主软件后邀请 URL 失效，任务管理器中无穿透进程

### 16.5 验收清单

1. 房主 15 秒内拿到可复制 URL。
2. 客人粘贴 URL 后能进入等待审批状态。
3. 房主拒绝后房间仍可接受下一次加入。
4. 联机期间所有引擎辅助功能均不可用，主进程也拒绝引擎搜索。
5. 20:00 总时与 2:30 单步同时生效，任一耗尽正确判负。
6. 悔棋恢复局面与双方棋钟；求和/认输结果正确。
7. 断线 12 秒暂停、2 分钟内恢复继续、超时判负。
8. 取消联机、关闭窗口、强制结束进程后，URL 失效且无穿透进程与端口占用。
9. 结束后可对同一棋局复盘、保存、导出。

## 17. 依赖与构建

- 新增运行时依赖：`localtunnel`（固定到 `^2.0.2`），仅主进程使用；启动参数为 `{ port, local_host: '127.0.0.1' }`。
- `scripts/build.mjs` 已对主进程 `bundle: true`，`localtunnel` 及其依赖会被打进 `dist-electron/main.cjs`；`external` 仍只有 `electron`。
- 为 `localtunnel` 增加本地类型声明 `src/net/localtunnel.d.ts`（该包不自带类型）。
- 打包脚本无需新增资源文件；不复制 `node_modules`。
- 首次实现时验证：`npm run build` 无动态 require 警告、打包版能启动穿透并正常关闭。
- 不引入 WebSocket、数据库、原生模块。

## 18. 风险与取舍

- **localtunnel 公共服务可用性**：依赖第三方中继，网络受限或服务抖动时联机不可用；失败时明确报错，不做静默降级。v1 不接受自建中继的额外部署成本。
- **第三方可见流量**：穿透服务可观察明文棋步与令牌；不传个人数据，令牌不落盘。端到端加密留待以后。
- **长轮询延迟**：正常情况下百毫秒级；极端网络下棋钟以房主为准，客人显示可能有轻微偏差，收到快照即校正。
- **房主权威即信任房主**：房主可篡改结果或使用外部引擎；v1 不做仲裁与防作弊。
- **`localtunnel` 打包兼容性**：依赖较老但在 Node 24 下为纯 JS；实现时先做一次真实隧道验证，若 esbuild 打包出现问题，则在 `tunnel.ts` 中使用 `createRequire` 加载并调整打包配置，仍不引入子进程。
- **断线判负**：2 分钟窗口内恢复不扣时；这对双方一致，但可能被恶意断线用来暂停棋钟，超时即判负作为约束。
- **UI 体量**：窗口较小，联机面板采用可滚动模态框与常驻信息条，避免挤压棋盘。

## 19. 里程碑

1. **协议与棋钟**：`protocol.ts`、`clock.ts`、`snapshotGame.ts` 与单测
2. **本地服务**：`hostServer.ts`、长轮询、心跳、限流与回环集成测试
3. **房主权威**：`onlineGame.ts`、悔棋/求和/认输、断线与超时裁决、单测
4. **穿透与生命周期**：`tunnel.ts`、`session.ts`、全部退出钩子、静态防子进程检查
5. **客人客户端**：`client.ts`、重连、快照重建与应用
6. **UI 集成**：联机面板、棋钟条、审批、公平性门禁、IPC 与 preload
7. **验收**：UI 冒烟、真实穿透双实例对局、打包版验证