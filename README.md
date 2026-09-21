# 歌剧舞台提词台（opera-stage-prompter）

演出期间在多个标签页 / 窗口并存的情况下，保证**舞台上只有一个有效操控者**，
防止旧排练窗口误触导致投影“跳句”。纯前端、单页、**完全离线**：
TypeScript + React + Vite，无任何运行期网络请求。

## 解决的问题与边界

- 节目单（双语字幕 + 黑场提示）可随时编辑、排序、预览；这些只改**草稿**。
- 点击 **“采用节目单”** 才把当前内容**快照冻结**为在演版本；空节目单禁止采用。
  采用之后继续编辑不会影响正在演出的版本，直到再次“采用”。
- **开演页**竞争一把跨页面的 Web Lock（`opera-stage-controller`）：
  - 胜者在**同一个 IndexedDB 读写事务**里取得递增**代次（generation）**
    并写入本代次初始画面（接管时沿用上一代画面，不闪黑）；
  - 其他开演页只能**只读**排队等待，显示当前画面与在任控制者；
  - 控制页关闭 / 崩溃 → 浏览器自动释放锁，排队页自动接管，产生**新一代次**。
- 切句 / 黑场：在**同一事务**中
  1. 核对持久代次 == 本页代次（旧代次直接拒绝）；
  2. 核对当前画面控制者 == 本页身份（冒充者拒绝）；
  3. 序号（sequence）+1 并整帧落盘；
  事务提交成功后才经 `BroadcastChannel` 发布。
- 投影页严格只读，接收规则：**只接受更高代次，或同代次更大序号**。
  失锁旧页的迟到消息（哪怕序号很大）一律丢弃；重开页面时以 IndexedDB
  中最后一幅**已确认画面**为准。
- **写入失败语义**：事务失败则整体回滚，库内与屏幕都停留在上一幅确认画面，
  UI 报错；绝不存在“先报成功、刷新后回退”。
- 失锁瞬间旧页 UI 立即禁用（遮罩 + 按钮失效），其任何后续操作无效。

### 明确不做的事（边界）

- 不做多用户账号 / 鉴权；“唯一性”以**同源浏览器**为界（Web Locks 的作用域）。
- 不做云端同步、不做跨设备协同：锁与持久状态都在本机浏览器内。
- 不主动清除持久数据；节目单与最后画面重开浏览器后仍在（IndexedDB）。
- 浏览器必须同时具备 IndexedDB、Web Locks、BroadcastChannel、structuredClone。
  缺任一项时**编辑照常可用**，页面会逐项列明缺项，并**禁止开演**（不参与锁竞争）。
- 黑场即全黑，不投出任何文字；舞台备注只在控制端可见。

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:5173
```

路由（哈希，无服务端依赖）：

- `#/edit` 编辑 / 排序 / 预览 / 采用节目单
- `#/stage` 开演控制台（竞争唯一锁）
- `#/projector` 投影页（只读，可全屏投到舞台）

验收建议：开 1 个投影页 + 2 个开演页，关闭第一个开演页观察第二页自动接管。

## 构建与校验

```bash
npm run build      # 类型检查 + 产出 dist/
npm run test:unit  # Vitest：持久状态、代次事务、消息栅栏、写入失败
npm run test:e2e   # Playwright：同源多页面争用、接管、迟到消息、投影重载
```

## Docker

宿主端口由 `WEB_PORT` 覆盖（默认 `8080`）：

```bash
WEB_PORT=9000 docker compose up --build
# 打开 http://localhost:9000
```

`verify` 是**一次性**校验服务（构建镜像 → Vitest → Playwright → 退出）：

```bash
docker compose build verify
docker compose run --rm verify
# 也可只跑其中一段：
docker compose run --rm verify npm run test:unit
```

镜像分三阶段：`build`（编译）、`runtime`（仅 nginx 静态托管 dist）、
`verify`（含 Chromium 与其系统库）。运行镜像不包含测试依赖。

## 目录

```
src/
  types.ts               领域模型与线协议
  lib/db.ts              IndexedDB：单事务开代次/发画面/冻结节目单
  lib/locks.ts           Web Lock 排他封装（排队、失锁回调）
  lib/protocol.ts        纯函数：代次栅栏判定
  lib/sessions.ts        控制会话 / 投影只读会话
  lib/capabilities.ts    能力探测（缺项列明、禁止开演）
  lib/useProgram.ts      草稿编辑/排序/防抖持久化/采用
  pages/                 EditorPage / ControlPage / ProjectorPage
tests/unit              Vitest（fake-indexeddb + 锁/通道桩）
tests/e2e               Playwright 多页面验收
```
