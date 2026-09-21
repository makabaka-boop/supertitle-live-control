# 歌剧舞台字幕控制台（opera-stage）

演出时歌剧双语字幕与黑场的**本地单页控制台**。核心约束：**舞台上同时只能有一个有效操控者**，
旧排练窗口误触不得让投影跳句。TypeScript + React + Vite 构建，纯前端、**不联网**，
状态保存在浏览器同源的 IndexedDB / Web Locks / BroadcastChannel 中。

## 页面

| 路由 | 用途 |
| --- | --- |
| `#/editor` | 节目单编辑：增删双语字幕/黑场提示、排序、实时预览；点击「采用节目单」冻结在演版本 |
| `#/stage` | 开演控制台：竞争唯一锁、切句/黑场；未持锁时只读显示当前画面与控制者 |
| `#/projection` | 投影页：纯只读，黑底大字；重开时从持久状态恢复 |

## 边界与不变式（这是本项目的契约）

1. **冻结边界**：只有点击「采用节目单」才把当前排序与文本深拷贝快照写入 IndexedDB；
   之后继续编辑草稿不影响在演版本。空节目单、缺中文/原文的字幕条目不可采用（按钮禁用并列明原因）。
2. **唯一控制者**：开演时竞争同名 Web Lock（exclusive，FIFO 等待）。胜者在**同一个
   IndexedDB 事务**中读取并递增代次（generation）、写入起始黑场帧；事务提交后才经
   BroadcastChannel 发布。其他页面只读显示画面与控制者。
3. **切句/黑场**：在同一个 readwrite 事务中核对「持久帧的 controllerId 与 generation」，
   通过才把 seq+1 覆盖画面。事务提交（成功）后才更新本机 UI 并广播——
   **不会先报成功、刷新后回退**。
4. **投影仲裁**：投影页只接受「更高代次，或同代次更大 seq」的帧；迟到的旧代次/旧序号消息
   一律丢弃。页面重开先读 IndexedDB 持久帧。
5. **接管**：控制页关闭 → 锁释放 → 等待队列头部自动获锁，以**新代次**重新开始（seq 归零、
   起始黑场）。无论旧消息何时抵达、投影是否重载，观众最终只能看到新代次确认的画面。
6. **失锁即禁用**：持锁页检测到锁失效（`locks.query()` 轮询确认持有者已变更）后立刻进入
   `lost` 状态，所有切句/黑场操作被拒；其迟到消息因代次更小不会覆盖任何画面。
7. **写入失败**：事务失败时保留上一幅已确认画面并显示错误，不产生乐观帧、不广播。
8. **能力降级**：缺少 Web Locks / IndexedDB / BroadcastChannel 任一项时，节目单编辑仍可用；
   开演页列明缺项并禁止开演。

## 技术要点

- 状态层 `src/lib/db.ts`：IndexedDB 单仓库（`program` / `frame` / `counter`），
  代次递增与帧写入在同一事务；控制者+代次不符抛 `StaleControlError` 并 abort。
- 运行时 `src/lib/engine.ts`：锁生命周期、先写后发、失锁禁用、帧新旧仲裁（`isNewerFrame`）。
- 端口适配 `src/lib/ports.ts`：浏览器 Web Locks/BroadcastChannel 实现；失锁检测基于
  `navigator.locks.query()`（规范未提供持锁者被抢占的直接事件）。
- 无后端、无第三方网络请求；构建产物为纯静态文件。

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build      # tsc --noEmit + vite build -> dist/
npm run preview
```

## 测试

- `npm run test`（Vitest，Node + fake-indexeddb）：节目单校验/冻结深拷贝、IndexedDB
  持久状态、代次递增、同事务控制者/代次核对、并发代次不重复、失锁拒绝发布、迟到消息仲裁、
  写入失败保持上一幅。
- `npm run e2e`（Playwright，多页面）：同一浏览器上下文中「主控台 / 旧窗口 / 投影」
  三页争用——唯一胜者发布、只读页显示控制者、关闭后接管新代次、投影重载恢复、
  抢占后旧页禁用且伪造 g1 迟到消息被拒、冻结边界与空单禁用。
- `npm run verify`：构建 + Vitest + Playwright 一次跑完（Docker `verify` 服务入口）。

## Docker

宿主端口由 `WEB_PORT` 覆盖（默认 8080）：

```bash
WEB_PORT=8080 docker compose up --build web
# 打开 http://localhost:8080
```

一次性验收服务（构建镜像、跑全部校验后退出，退出码即验收结果）：

```bash
docker compose build verify
docker compose run --rm verify
```

`verify` 使用 Playwright 官方镜像（内含浏览器与系统库）；`web` 为 nginx 静态镜像，
两个目标在同一个多阶段 `Dockerfile` 中。

## 明确不做的事（非目标）

- 无账号/鉴权、无多房间、无网络同步；所有协调仅限同一浏览器同源标签页。
- 不处理「不同浏览器 profile 之间」共享状态的场景（物理上即不同 IndexedDB 存储）。
- 投影与控制台必须在同一浏览器实例的同源页面打开（Web Locks/BroadcastChannel 的作用域）。
- 不内置字幕时间轴/自动播放；切句由控制者手动触发，避免误触歧义。
