# 会话回收站 · Session Recycle Bin

给 DSH 补上它本来没有的「删除会话」。删除 = 移入回收站，随时可恢复；只有「彻底删除」才真正销毁。
**子会话跟随主会话**：删一个会话会把它名下的子代理会话整棵树一起带走，回收站里是**一条条目**，
恢复、彻底删除都按整棵树处理；删除前和销毁前的确认框都会先说明「其中 N 个子会话会一并移入/销毁」。
侧栏有独立入口（**右键还能一键清空**），会话菜单里还有**红色删除项**与**工作区批量归档/删除**，
回收站页里每条会话带**复选框**，可以勾选后批量恢复或批量彻底删除。

> **维护者请看** [二次开发与维护](#二次开发与维护)：改哪里、怎么重载、哪些不变量不能破坏。
> 本仓库只包含插件本体（清单 / Host 半 / Client 半 / 图标 / 文案），以本地目录方式安装，源码即运行代码。

## 为什么需要它

DSH 内核**没有删除会话的接口**（这是设计选择，不是遗漏）：

| 层 | 包 | 事实 |
| --- | --- | --- |
| 持久化 | `@deepseek-ai/dsh-session-persistence-jsonl` | README：「不删除会话文件——日志在 `root` 下累积，直到外部移除；seam 无删除接口」 |
| 工作区注册表 | `@deepseek-ai/dsh-workspace` | 只有 `archiveSession` / `unarchiveSession` / `pinSession` / `unpinSession` |
| 会话控制器 | `@deepseek-ai/dsh-api-session-controller` | 只有 create / resume / list / follow |
| 投影缓存 | `@deepseek-ai/dsh-session-projection-cache` | 「无淘汰或保留接口」 |

所以任何删除插件都是**绕开内核直接动磁盘**。本插件把这件危险的事做成两步：先移进回收站，再（可选）彻底删除。

> 上表结论来自对 DSH 安装包内各包的 README、类型声明（`lib/types/**/*.d.ts`）与运行行为的逐条查证：
> 持久化层与投影缓存明确没有删除 / 淘汰接口，工作区注册表只提供归档与置顶，会话控制器只提供
> create / resume / list / follow。插件机制（槽位注册、Client bundle 的 Module Loader、HTTP 信任栅栏）
> 见各 `@deepseek-ai/dsh-client-*` 与 `@deepseek-ai/cordis` 包的 README。

## 一次删除做了什么

Host 上按顺序完成，每步都可回退：

1. **解析整棵树**：按持久化 header 里的 `origin: 'subagent'` + `parentSession` 找到该会话的
   全部子代理会话（任意深度；fork 虽然也带 `parentSession` 但没有这个 origin，不会被带走）。
   树从 `sessionPersistence.list()` 读，不依赖侧栏，也不依赖子会话的 Agent 是否还活着。
2. **归档准入**：调 `workspaceRegistry.archiveSession(id)`。它先问一遍
   `workspace/session-activity` 瀑布（回合 / 后台 job / 子代理 / 定时提醒），
   有工作就抛错 → 插件回 409 `session-open`。父会话的准入已经把**运行中的子代理**算进
   `subagent` 家族；插件还会对树里每个成员再查一次 `agent.status` / inbox，挡住竞态。
   这一步同时把侧栏行藏起来，并装上归档门禁（门禁沿血缘生效，子会话的步骤同样被挡）。
3. 把根会话的日志目录 `~/.dsh/sessions/<projectDir>/<id>/` **移动**到
   `~/.dsh/session-recycle-bin/<时间戳>-<id>/session/`；
   每个子会话移到同一 bin 条目的 `children/<encodedId>/session/`。
4. 把每棵树的投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json` 移到
   同一 bin 条目的 `projcache.json` / `children/<encodedId>/projcache.json`。
5. 写一份 `entry.json`（schema 2），根会话字段照旧记 `sessionId` / `cwd` / 实际找到的 `projectDir` /
   `title` / `createdAt` / `deletedAt` / 原工作区 / 原归档与置顶状态 /
   `hadDirectory` / `hadProjectionRecord`，另加 `childCount` 与 `children[]`
   （每个子会话的 `sessionId` / `projectDir` / `title` / 原有状态与两个 `had*`）。
6. 清掉每个成员的登记：从各 Workspace 的 `sessionIds` 摘除、从归档与置顶集合移除，
   再发 `api-session/removed` 让前端列表当场掉行（根会话与每个子会话各发一次）。
7. 如果任一成员的 Agent 仍在本进程存活，把 id 记入隐藏集合，并由
   `installHiddenSessionFilter()` 包住 `sessionQuery.listSessions` 过滤掉它。
   `listSessions` 会把 `ctx.sessions` 里的**活会话合并到持久记录之上**，否则下一次
   列表刷新时被删会话会以侧栏合成分组「未分组」的形式重新冒出来（1.1.0 的回归，1.1.1 修）。
   子会话本来就不渲染侧栏行，但保持同一规则可以避免它们从别的语料读路径漏回来。

任何一步失败都会把已经移动的东西**搬回原位**、把准入时藏起来/取消置顶的会话还原，
不会丢字节（见 `trash()` 的 try/catch、`rollback()` 与 `restoreAccounting()`）。

**恢复与彻底删除都是整条处理**：`restore` 先把树里每个目标路径检查一遍，任何一条冲突就整条拒绝
（不会出现「父会话回来了、子会话还在回收站」的半棵树）；`purge` 直接删掉条目目录，子会话自然一起销毁。

**打开过但没在跑的会话可以删**：DSH 只要打开过会话就会在 Host 里保留一个空闲 Agent
（session controller 的 background activation，直到 Host 退出才释放）。这不是「工作」，
不能成为拒绝理由；它的日志写句柄跟随文件对象跨 rename 有效，所以移动目录不会破坏它，
恢复后仍可继续对话。删除后这个活 Session 对象还在内存里，所以必须靠上面的列表过滤器
把它从语料列表里遮住；插件重载后 `repopulateHidden()` 会按 bin 条目重建隐藏集合（含每个子会话）。

**永远不做的事**：不碰 `~/.dsh/attachments/v1/objects`（附件按内容寻址、跨会话共享），
不删 `~/.dsh/sessions` 下的项目目录本身，不覆盖同 ID 的既有目录（恢复冲突直接报错）。

### 子会话为什么跟随主会话

DSH 里的子代理会话（`subagent` / fork / Agent Team 成员）是一个**有主的子会话**，不是平级会话：

- header 带 `origin: 'subagent'` 与 `parentSession`，`delegationDepth` 表示层级；
- 从不进 Workspace 的 `sessionIds`（`session.create` / `fork` 才 `attachSession`），
  所以**没有侧栏行**，官方 browser 的 `sessionVisible()` 对 `origin === 'subagent'` 直接返回 false；
- 只能在父会话的 `subagentCatalog` 浮层/血缘条里打开。

因此把它当独立会话删是错的：父会话一旦进回收站，子会话的 `parentSession` 就指向一个不存在
（或不可达）的 id，UI 没有入口再找到它，只能在磁盘上占空间。所以本插件把「一个会话」定义成
**一棵树**：`trash` 带整棵树，bin 条目代表整棵树。只有一种例外被保留——**孤儿子会话**
（父会话已经不在持久化里，例如旧版本留下的残留）仍可用 `delete_session` 按 id 单独删，
方便清理；而父会话还在时直接删子会话会被拒绝（`session-child`，HTTP 409），
因为「删父会话」才是正确动作。

## 入口一览

共 11 项入口：会话菜单两行、浮层四个、侧栏面板一个、回收站页及其批量操作、设置页一个、模型工具一个。

| 入口 | 位置（代码） | 说明 |
| --- | --- | --- |
| 「批量操作…」菜单项 | `client.js` → slot `sidebar.workspaces.session.menu.item` | `order: 480`，紧贴在「删除会话…」上方，**前置一张「列表 + 勾选」图标**；打开该会话所属工作区的批量面板 |
| 「删除会话…」菜单项 | `client.js` → slot `sidebar.workspaces.session.menu.item` | `order: 500`，在「复制 Session ID」(450) 下方；**用 `--dsw-alias-state-error-primary` 红字 + 淡红 hover + 垃圾桶图标**；先弹确认框，不会单击即删 |
| 确认框 | `client.js` → slot `shell.overlay` | 标题/正文/会话 ID/「取消」「移入回收站」；Esc 与点背景可关 |
| 批量面板 | `client.js` → slot `shell.overlay` | 作用域 = 该会话所属工作区；**第一行是工作区说明，第二行才是全选 + 已选计数**；关闭是**右上角的 × 图标**（不再是文字按钮）；逐会话复选框；底部「归档」「删除」 |
| 批量删除确认框 | `client.js` → slot `shell.overlay` | **独立对话框**（`layer: 50`），叠在批量面板之上；打开期间**批量面板整体 sealed**：`pointerEvents: none`、`aria-hidden`、去掉自身 `aria-modal`、Esc/背景关闭失效、全部复选框与按钮 disabled |
| **销毁确认对话框**（1.3.1） | `client.js` → slot `shell.overlay`（`bin-confirm`） | **唯一**的销毁确认：回收站页的「清空回收站」、选择栏的「彻底删除」、单条的「彻底删除」、侧栏右键的「清空回收站」**全部走这一个对话框**。打开期间回收站页整体 frozen：所有复选框、全选、刷新、恢复、两个批量按钮全部 disabled；正文写明条数 |
| 「会话回收站」侧栏页 | `client.js` → slots `sidebar.panellist`（id `session-recycle-bin`, order 20）+ `main`（key `session-recycle-bin`） | 侧栏图标与「插件」「定时」「市场」并排，点击后**中央主区**渲染回收站页；点任意会话会自动切回聊天区（官方 `replaceMain(..., 'reveal')` 行为） |
| 回收站条目的**勾选 + 批量恢复/彻底删除** | 同上（`BinPanel`） | 每条会话**行首复选框**、**行尾右侧**放该条的「恢复」「彻底删除」（不再是底部一行）；标题旁标出「附 N 个子会话」；列表上方是选择栏：全选、已选计数、**恢复**、**彻底删除** |
| 侧栏图标的**右键菜单** | `client.js` → slot `shell.overlay`（`bin-menu`） | 在侧栏「会话回收站」行上右键（图标或标题都行）弹出「清空回收站…」；选择后打开统一的**销毁确认对话框** |
| 「会话回收站」设置页 | `client.js` → slot `settings.section` | 与侧栏页同一 `BinPanel`；`order: 45`（按你的选择保留） |
| `delete_session` 工具 | `index.js` | `preview`/`trash`/`trashMany`/`archiveMany`/`list`/`restore`/`restoreMany`/`purge`/`purgeMany`/`purgeAll`，与 UI 共用同一批 Host 方法 |

UI 与工具走的是同一套服务方法（`SessionRecycleBin`），只有传输层不同：UI 走
`POST /dsh-session-recycle-bin/api`，工具走 `ctx.tools.register`。

### 三个对话框里的子会话提示

子会话没有侧栏行，Client 无法从自己的 store 数出来，所以对话框在**打开时**向 Host 要一个
只读的 `preview`（`{ action: 'preview', sessionIds }` → `{ sessions, childCount, missing }`）：

| 对话框 | 提示文案 | 数据来源 |
| --- | --- | --- |
| 单条「删除会话…」确认框 | 「其中 {count} 个子会话会一并移入回收站（子会话跟随主会话，恢复时也一起回来）。」 | 打开时 `preview` 该会话 |
| 批量删除确认框 | 「其中 {count} 个子会话会一并移入回收站，恢复时也一起回来。」 | 打开时 `preview` 整个选中集合 |
| 「彻底删除」销毁确认框 | 「其中 {count} 个子会话的日志会一并销毁。」 | 回收站条目自带 `childCount`；侧栏右键「清空」路径由 `list` 探测补齐 |

`preview` 是建议性的：真正的树由 `trash()` 自己在动任何字节前重新解析。所以预览失败只会让
对话框少一句计数（删除照常），预览过期也只会把数字说错，不会移错东西。

### 侧栏位置是怎么定下来的

侧栏骨架由官方 `ui-sidebar` 写死：品牌行 → 新会话 → **`sidebar.panellist`（全局面板图标）** →
`sidebar.workspaces` → **`sidebar.footer.action`** + 设置。第三方能追加的只有加粗的两个 list 座位。
本插件选 `sidebar.panellist`，因为它的语义正是「打开一个主区面板」，与「插件」「定时」「市场」完全同构；
`main` 的 key 必须与 `sidebar.panellist` 的 id 相同（`layout.selectPanel(id)` 会校验 `main` 已注册）。

### 批量操作为什么在会话菜单里

工作区行自己的「…」菜单（重命名 / 删除工作区）是 `ui-workspace` 里 `ProjectRowItem` 的内联数组，
**不是槽位**；要往里加第三项只能整体替换 `sidebar.workspaces`（`replaceRisk: shadows-shipped-ui`），
等于把官方侧栏浏览器复制进插件、DSH 一升级就坏。所以批量入口放在**会话行菜单**（同一个可扩展座位），
作用域由该会话所属工作区决定 —— 交互上就是「在某个工作区的会话上点批量，作用于这个工作区」。

### hover 为什么用 `--dsw-alias-interactive-bg-hover`（1.3.0）

1.2.x 的菜单行 hover 用的是 `--dsw-alias-bg-layer-2`。那是**表面** token（浅色下等于
`neutral-bluish-00`，纯白），拿它当 hover 底色，在侧栏上就是一块白斑；而原生的
菜单行（`ui-primitives` 的 `._item:hover`）与侧栏自己的 `PanelRow:hover` 用的都是
`--dsw-alias-interactive-bg-hover`（浅色 `#2631480f`、深色 `#ffffff14`，一层很淡的灰蓝）。
1.3.0 把它抽成 `client.js` 里的 `HOVER_FILL` 常量，四处 hover（批量项、批量面板的行、
右键菜单项、对话框右上角 ×）全部改用它；`validate-bundle.mjs` 也加了一条不许再拿表面
token 当 hover 的断言。

### 回收站页的排版为什么改成「行首勾选 + 行尾操作」（1.3.0）

用户要求：每条会话前面加复选框、恢复与彻底删除从下侧挪到右侧。实现上就是把条目从
「竖排卡片」改成**一行三段**：`Checkbox | 身份区(flex:1，标题/时间/ID/目录) | 操作区(flex:none)`。
操作区固定宽度，所以长列表里每一行的「恢复 / 彻底删除」都能对齐。勾选之后，列表上方的
**选择栏**（全选 / 已选计数 / 恢复 / 彻底删除）才是批量入口。

### 销毁确认为什么是「对话框 + 整页 frozen」（1.3.1）

1.3.0 的确认是页面里的**内联确认条**，只有 `busy` 会禁用控件。问题：确认条开着时 `busy`
还是 `false`，所以下层的复选框照样能点 —— 用户可以在「要删除这 1 个吗？」还开着的时候，
又勾上第 2 个。这是**真 bug**，1.3.1 修。

现在：

- 确认是**独立对话框**，注册在 `shell.overlay`（`bin-confirm`），由 store `binConfirmRequest`
  驱动；对话框本体 **portal 到 `document.body`**（见下一节）。**四个销毁入口共用它**：
  侧栏右键的「清空回收站」、页面标题栏的「清空回收站」、选择栏的「彻底删除」、单条的「彻底删除」；
- 打开期间回收站页整体 `frozen`：所有行复选框、全选、刷新、恢复、两个批量按钮全部 `disabled`，
  并且 `toggle()` / 全选 handler 内部也直接 return（不只是视觉变灰）；
- 请求里**捕获计数与精确的 binId 列表**（`{ kind, count, binIds }`），所以对话框问的是
  「刚才那一刻的选择」，不会在背后被改掉；
- 三个 kind 各有自己的标题与正文（`bin.purgeOneTitle/Body` 等），正文永远写明条数/标题。

侧栏右键那条路径拿不到条数（那里什么都没加载），所以 `{ kind: 'all' }` 不带 count，
由对话框自己先 `list` 一次补上；条数为 0 时确认按钮 disabled。

### 对话框为什么要 portal 到 `document.body`（1.3.2）

用户报告：从「设置 → 会话回收站」点彻底删除，**确认框被设置面板盖住**。

根因是**层叠上下文**，不是 `zIndex` 写小了：

```
body
└─ .AppFrame_frame                     position: relative
   └─ .AppFrame_overlayLayer           position: absolute; z-index: 20   ← 层叠上下文！
      └─ <我们的 session-recycle-bin.overlay />   z-index 写多大都 ≤ 20
└─ .SettingsRoot_overlay               position: fixed;    z-index: 1000  ← 盖住上面全部
```

`shell.overlay` 看起来是「全框浮层」，但宿主把它塞进一个 `z-index: 20` 的绝对定位容器里，
该容器建立了**独立的层叠上下文**——子元素再大的 `z-index` 也不会超过 20。而设置面板是
`position: fixed; z-index: 1000` 的 `body` 级浮层。所以在设置页里弹出的确认框必然在下层。

修法：用 React 的 **`createPortal` 把对话框挂到 `document.body`**，跳出那个层叠上下文。
宿主自己的 `Modal` / `Menu` / `Tooltip` 原语也是这么做的（`createPortal(..., document.body)`），
所以这是与宿主同构的做法，而不是 hack：

- `react-dom` 在 Module Loader 的**静态模块表**里（`react` / `react/jsx-runtime` /
  `react-dom` / `react-dom/client` / `cordis` / `zod` / `tanstack/react-virtual` /
  `dsh-client-store` / `ui-slots` / `ui-primitives` / `ui-dockkit`），所以 `require('react-dom')`
  是合法解析，不需要声明白名单；
- 主题 token 不受影响：`ui-theme` 把调色板声明在 `body` 上，而 portal 的目标正是 `body`；
- 层序常量 `DIALOG_Z_BASE = 1200`（> 设置面板的 1000），`Dialog` 的 `layer` 在此基础上叠加，
  所以「批量面板 40 → 删除确认 50」的相对顺序不变；
- 右键菜单同样 portal（`DIALOG_Z_BASE - 10`），否则在设置页里右键侧栏图标也会被盖住；
- `portalize()` 在 `document.body` 或 `createPortal` 不可用时**原地渲染**，所以测试宿主 /
  极端环境不会白屏。

`validate-bundle.mjs` 的模块白名单同步放宽到那张静态表（原来只许 `react`）。

### 「已彻底删除 undefined 个条目」——HTTP 通道漏了计数（1.3.1）

这是**两个传输层形状不一致**造成的：

| 通道 | 返回 | 谁算的 count |
| --- | --- | --- |
| 工具 `delete_session` | `{ trashedCount, archivedCount, … }` | `execute()` 里自己拼 |
| HTTP → `dispatch()` | `{ purged: [...] }` / `{ restored: [...] }` | **没人算** |

Client 走 HTTP，读的是 `payload.purgedCount` → `undefined`。

修法：把计数做成 **`dispatch()` 的契约**，四个批量动作统一返回
`{ <items>: [...], <items>Count, failed, failedCount }`，`dispatch` 因此 `export` 出去，
`test-bin.mjs` 直接对着它断言 `purgedCount === purged.length`。
工具那一侧保持不变（它本来就算对了），两条通道现在同形。

Host 侧为此新增两个批量动作 `restoreMany` / `purgeMany`：**逐项走单条 `restore()` / `purge()`**，
返回 `{ restored|purged, failed[] }` 的成败拆分。这样一条恢复冲突（目标目录已被同 ID 占用）
不会把同批其它条目卡在回收站里，也不会出现「整单失败但其实动了一半」。

### 侧栏右键菜单为什么挂在 `document` 上（1.3.0）

侧栏那行按钮由官方 `ui-sidebar` 的 `PanelRow` 渲染，**不是槽位**；插件能画的只有
`sidebar.panellist` 里的那枚图标（宽 16/18px）。要让「整行右键」都能弹出菜单，只有两条路：
替换官方侧栏（`shadows-shipped-ui`，否决），或让图标给自己打一个
`data-session-recycle-bin-nav` 标记、再在 `document` 上监听 `contextmenu`：
命中「有该标记的按钮」才 `preventDefault()` 并弹菜单。监听器的生命周期由
`React.useEffect` 管（图标不在就不监听），不碰宿主 DOM。

菜单本身注册在 `shell.overlay` 而不是侧栏里：侧栏列 `overflow: hidden` 且带 transform，
`position: fixed` 的弹层在里面会被裁掉。`shell.overlay` 是全框浮层、明确 click-through，
正是这类 popup 的座位。选「清空回收站…」后弹的是**确认对话框**（先 `list` 读条数写进正文，
条数为 0 时确认按钮禁用），确认后调 `purgeAll`，再通过 `binRevision` 让所有已挂载的
回收站页重读（侧栏页与设置页可能同时挂着两份 `BinPanel`）。

复选框放在批量面板自己的列表里，而不是侧栏行首：行首唯一的槽位
`sidebar.session.row.leading` 只有 16px，且**有状态点的行（运行中/待处理/新消息）、已归档行、空白行
根本不渲染该槽位**，无法承载完整选择。

### 批量删除确认为什么是「对话框 + 封存」而不是内嵌确认条

1.2.1 起，点「删除」不再在面板底部挤一条确认条，而是**再叠一个独立对话框**
（`Dialog layer: 50`，标题「确认移入回收站」）。同时，下层的批量面板进入 **sealed** 状态：

- 遮罩层 `pointerEvents: none`（下层完全不接收点击，彻底避免"确认框开着还能勾选"）；
- `aria-hidden` + 去掉自身的 `aria-modal`（读屏器只读最上层的确认框）；
- Esc / 点背景的关闭路径停用，右上角 × 与 `busy` 同步禁用；
- 所有复选框、全选、归档/删除按钮渲染为 disabled。

实现上 `Dialog` 增加了两个 prop：`layer`（层序）与 `sealed`（被封存），`BatchPanel`
在 `confirmingDelete` 为真时把面板传 `sealed: true` 并返回 `[panel, confirmDialog]` 两棵树。
注意 `run()` 的守卫只看 `busy` 而不是 `frozen`——否则确认框自己的「移入回收站」按钮会被
它自己触发的封存挡住（这个坑踩过，`test-client.mjs` 现在有交互测试覆盖）。

## 验证状态（2026-10-19 / 1.4.0）

> 下表的验证在作者本地环境完成：离线套件见 [测试](#测试)，**不随本仓库发布**。
> 列出来是为了说明每项能力曾被什么方式验证过、以及哪些还需要人眼验收。

| 层 | 怎么验的 | 结果 |
| --- | --- | --- |
| 目录名推导 | `verify-paths.mjs` 对着真实会话目录逐一对照 | ✅ |
| 事务 + 回滚 | `test-bin.mjs`：trash/list/restore/purge/purgeAll + 拒绝码 + 半途失败回滚 + 准入失败还原 | ✅ |
| 批量操作（1.2.0） | `test-bin.mjs`：`trashMany` 部分成功/去重/空表/超长/穿越 id 全拒绝 + 全部可恢复；`archiveMany` 走官方归档、运行中项报 `session-open` 且保持未归档 | ✅ |
| **批量恢复/彻底删除（1.3.0）** | `test-bin.mjs`：`restoreMany` 全部成功、**一条冲突只失败那一条**、空表/非数组/超长/穿越 id 拒绝；`purgeMany` 全部销毁、未知条目只报那一条、空表/穿越 id 拒绝；`purgeAll` 数清空并保持活会话隐藏 | ✅ |
| 真实数据镜像 | `test-mirror.mjs`：真实 `$DSH_HOME` 拷贝上 3.3 MB 会话删除→恢复，SHA-256 一致 | ✅ |
| **子会话整树（1.4.0）** | `test-bin.mjs`：父 + 子 + 孙三层树上 `trash` 只产生**一条**条目、父与全部子目录/投影缓存都进同一目录、`list` 报 `childCount`、`restore` 整树回原位、`purge` 整树销毁；任一子会话有运行中工作 → 整树拒绝且一字节未动；任一子目标冲突 → 整条拒绝且条目完整；父会话还在时删子会话报 `session-child`；孤儿子会话（父已不在）仍可单删并带走自己的子树；`trashMany` 同时传入父与子不会把子报成失败 | ✅ |
| **preview 与对话框计数（1.4.0）** | `test-bin.mjs`：`dispatch('preview')` 的两种请求体都返回 `childCount`；`test-client.mjs` 真跑：单条删除框、批量删除框各发出 `preview` 并在正文写出子会话数，销毁确认框写出「其中 N 个子会话的日志会一并销毁」，回收站行显示「附 N 个子会话」 | ✅ |
| **真实父子树镜像（1.4.0）** | `test-mirror.mjs` 读真实日志 header 识别血缘，挑一个带 5 个真实子会话的 4.3 MB 根会话做 trash→restore：5 个子目录与日志全部进同一 bin 条目、字节数一致、恢复后全部回原位 | ✅ |
| Client 渲染 | `test-client.mjs`：React shim 下全部座位渲染 + 跨 slot 请求链路 + 红色 token 断言 + 文案全覆盖 | ✅ |
| 批量确认交互（1.2.1） | `test-client.mjs` 用**有状态 mount** 真跑：勾选 → 点删除 → 断言第二层对话框（layer 50）→ 下层面板 `sealed` → 取消回到单面板 | ✅ |
| **hover token（1.3.0）** | `test-client.mjs`：断言只有一个 `HOVER_FILL`、指向 `--dsw-alias-interactive-bg-hover`、没有任何 hover 还在用表面 token、菜单项实际触发时写入的就是该 token | ✅ |
| **回收站页排版（1.3.0）** | `test-client.mjs` 挂载真实 `BinPanel`（带 `fetch` 双）跑完整交互：mount 只发一次 `list` → 两条目两行 → 行首是 checkbox、行尾是操作区、身份区 `flex:1` → 勾选后批量按钮解禁 → 「恢复」发出 `restoreMany`（binIds 精确） | ✅ |
| **销毁确认是对话框且整页 frozen（1.3.1）** | `test-client.mjs` 真跑：点批量「彻底删除」后页面**不出现内联 alertdialog**、下拉复选框 / 全选 / 两个批量按钮全部 `disabled`、**再点复选框也改不了已选计数** → 对话框标题/正文写明条数 → 取消则不发 `purgeMany` 且页面解冻 → 确认才发 `purgeMany`（binIds 精确）→ 弹框关闭；空回收站时确认按钮 `disabled` | ✅ |
| **`undefined` 计数回归（1.3.1）** | `test-bin.mjs` 直接对着 `export` 出去的 `dispatch()`（UI 真正走的通道）断言四个批量动作都带 `xxxCount` 且等于数组长度；工具侧形状不变 | ✅ |
| **对话框层序 / 设置页遮挡（1.3.2）** | `test-client.mjs`：`react-dom` 替身记录 `createPortal` 调用 —— 断言确认框与右键菜单**都经过 portal**、目标容器存在、渲染出的层壳 `zIndex > 1000`（宿主设置面板的值）；`validate-bundle.mjs` 断言模块白名单只含宿主的静态模块表 | ✅ |
| **侧栏右键清空（1.3.0）** | `test-client.mjs`：图标带 `data-session-recycle-bin-nav` 标记、mount 装 1 个 document `contextmenu` 监听、**右键点在行标题上**也命中、unmount 后监听被移除 → 菜单按指针定位、项为红色「清空回收站…」→ 选中后打开**同一个销毁确认对话框**并先 `list` 读条数 → 确认前不发 `purgeAll`、确认后发出、弹框关闭 | ✅ |
| 侧栏槽位注册 | 重载后用 `cordis_inspect_query` 查 `Slots.listSubTree`：`sidebar.panellist` 出现 `session-recycle-bin@20`，`main` 出现 key `session-recycle-bin`，`shell.overlay` 出现 4 个条目（含 `bin-menu` / `bin-confirm`） | ✅ |
| Host 工具调用 | 子代理在真实 Host 上跑了 2 个完整 trash→restore 循环 | ✅ |
| 真实 UI 全链路 | 人眼手点：菜单 → 确认框 → 删除 → 回收站 → 恢复 | ✅（1.1.1） |
| 空闲活跃会话可删 | 在真实 Host 上对一个已打开、Agent 空闲的会话执行 trash→restore：日志与投影缓存 SHA-256 一致，Agent 仍存活、可继续对话 | ✅ |
| 运行中工作拒绝 | `test-bin.mjs` 覆盖 running Agent / 排队 inbox / 活动提供方三种拒绝 | ✅ |
| 「未分组」幽灵修复 | 在真实 Host 上执行 trash→`sessionController.list()`→restore：删除前在列表、删除后不在、清空隐藏集并按 bin 重建后仍不在、恢复后重新出现 | ✅ |

未覆盖：视觉细节（配色/间距是否符合宿主风格）没有自动化校验，只能人眼确认；也没有
Dark 主题下的截图对比。**1.3.2 的层序修复（对话框 portal 到 body）需要在设置页里再点一次彻底删除来验收。** 右键菜单的触发依赖真实 DOM 的
`Element.closest`/`querySelector`，离线测试用桩验证了逻辑，但「在侧栏那一行上右键」仍需手点一次。
**1.4.0 的子会话提示也建议手点一次**：删一个带子代理的会话，确认删除框、批量删除框、
回收站「彻底删除」框都写明了子会话数，并且回收站里只有**一条**条目（标题旁「附 N 个子会话」）。

## 安全约束

- **只有「还有工作」的会话拒绝删除**：`trash()` 先走归档准入（DSH 官方的
  `workspace/session-activity` 检查），命中即抛 `session-open`（HTTP 409），不会把正在
  写的日志搬走；准入后再查一次 `agent.status` / inbox 待处理项，挡住刚准入就开工的
  竞态。**空闲 Agent 不再阻止删除**（见上一节）；1.0.0 用
  `ctx.get('agents').get(id) !== undefined` 当护栏，导致打开过但没输入内容的会话永远删不掉。
- **删除的活会话必须从语料列表里遮住**：移动文件不会移除内存里的 Session（空闲 Agent
  还在），而 `sessionQuery.listSessions()` 会把 `ctx.sessions` 的活会话合并到持久记录上。
  `installHiddenSessionFilter()` 只包一层 `listSessions`、按隐藏集合过滤，并在插件卸载时
  还原；找不到该方法时只 warn 并降级（不会崩）。别把它当成可以省略的锦上添花——省掉它，
  被删会话会以「未分组」幽灵行回来（1.1.0 回归）。
- **路径由 id 重算 + 全树定位**：`sessionDirectory()` 先按 `projectKey(cwd)` 猜，
  猜不中则由 `locateSessionDirectory()` 在 sessions 树里找名为 `encodeSegment(id)` 的目录。
  调用方永远不能传路径，只能传 id。
- **编码与后端逐字节一致**：`lib/session-paths.js` 的 `projectKey` / `encodeSegment` 是
  `dsh-session-persistence-jsonl` 内部实现的镜像；不一致只会导致「找不到目录」，不会误删，
  因为有目录名校验兜底。
- **HTTP 路由过信任栅栏**：与 DSH 自己的 `/api`、插件市场用同一个
  `ctx.connection.requestRejection`，未认证/跨站请求一律 401/403（实测 curl 得到 401）。
- **无 postinstall、无二进制、无第三方依赖**：Host 半只 import `node:*` 与自己的
  `./lib/session-paths.js`。
- **唯一真正销毁的路径是 `purge` / `purgeMany` / `purgeAll`**，且 UI 上四个销毁入口全部共用同一个确认对话框（`bin-confirm`）。

## 二次开发与维护

### 开发循环

插件以本地目录安装（`link:`），源码就是运行代码，不需要 rebuild 或重新安装：

```
改 index.js（Host 半）  → plugin_manager: set_bundle enabled:false 再 true  → 生效
改 client.js（Client 半）→ 同上，然后浏览器刷新页面（Ctrl+F5）
改 lib/session-paths.js → 两边都受影响，按上面的方式重载
改 locale/*.json         → 插件管理页的标题/描述，重载后可见
```

- `set_bundle` 的 `application: applied` 才算生效；`restart-required` 意味着需要重启桌面端。
- 客户端 bundle 的 HMR 只在 DSH 源码 checkout 上跑着 `pnpm run dev:web` 时才会自动换版；
  发布版安装下**改完必须刷新页面**（Ctrl+F5）。
- 改完先按 [不变量（别破坏）](#不变量别破坏) 逐条自查，再手动点一次确认行为没变；
  离线校验套件在开发工作区（见 [测试](#测试)），本仓库不包含。

### 改哪里

| 想改什么 | 位置 |
| --- | --- |
| 删除菜单项颜色 | `client.js` `DeleteMenuItem` 的 `style.color`（`--dsw-alias-state-error-primary`）与 `onMouseEnter` 的淡红底 |
| **任何行的 hover 底色** | `client.js` 的 `HOVER_FILL`（`var(--dsw-alias-interactive-bg-hover, transparent)`）；**不要再改回 `bg-layer-*` 之类的表面 token**，那是填充色不是 hover 色，`validate-bundle.mjs` 有断言 |
| 菜单项位置/顺序 | `client.js` 的 `MENU_ORDER_DELETE`（500）与 `MENU_ORDER_BATCH`（480，必须小于删除项） |
| 侧栏回收站图标位置 | `client.js` 里 `sidebar.panellist` 注册的 `order`（当前 20；官方 plugins=0、market=1、schedules=10） |
| 侧栏图标 / 面板 key | `client.js` 的 `PANEL_ID`（`'session-recycle-bin'`）；**`main` 的 key 与 panellist 的 id 必须是同一个字符串** |
| 回收站条目排版 | `client.js` `BinPanel` 里 rows 的三段（`Checkbox` / 身份区 `flex:1` / 操作区 `flex:none`）；批量入口在上面的 `selectionBar` |
| **侧栏右键菜单** | `client.js` `BinNavIcon`（`data-session-recycle-bin-nav` 标记 + document `contextmenu`）→ `BinContextMenu`（弹层）→ 同一个销毁确认对话框；文案键 `bin.clearMenu` |
| **销毁确认（唯一入口）** | `client.js` 的 `binConfirmRequest` store + `BinConfirmDialog`（`shell.overlay` 的 `bin-confirm`）；**不要再加内联确认条**，四个销毁入口都 `binConfirmRequest.set(...)` |
| **清空/销毁后各页联动刷新** | `client.js` 的 `binRevision` / `binFlash` 两个 store：写侧 `BinConfirmDialog`，读侧 `BinPanel` 的两个 `useEffect` |
| **确认期间整页 frozen** | `client.js` `BinPanel` 的 `frozen = busy \|\| confirmRequest !== null`；新增可交互控件必须挂 `disabled: frozen`，toggle/全选 handler 也要先判 |
| **批量计数的形状** | `index.js` `dispatch()` 里每个批量动作都返回 `<items>` + `<items>Count` + `failedCount`；UI 只读 `xxxCount`，**别只返回数组** |
| 批量面板作用域 | `client.js` `BatchMenuItem` 里按会话反查所属工作区的逻辑；`BatchPanel` 的 `members` 过滤（排除 blank / subagent-origin） |
| 批量上限 | `index.js` 的 `BATCH_LIMIT`（200），`normalizeBatch()` 与 `normalizeBinIds()` 统一校验 |
| 回收站根目录 | `index.js` `binRoot()` |
| bin 条目命名 | `index.js` `stamp()` + `trash()` 里的 `entryId` |
| **条目 = 一棵树** | `index.js` 的 `entryNodes()` / `entryArtifacts()`（schema 2 的 `children[]` 与 `children/<encodedId>/` 布局），以及 `trash()` / `restore()` / `purge()` 三个入口；**三条路径都必须按整树走**，不能只处理根会话 |
| **树怎么解析** | `index.js` `childIndex()` / `descendants()`：只认 header 的 `origin === 'subagent'` + `parentSession`（fork 也带 `parentSession` 但没有 origin，必须排除） |
| **子会话跟随策略** | `trash()` 开头的 `session-child` 守卫（父还在时拒删子会话）+ `trashMany()` 的父子去重；改这里等于改用户语义，先读[子会话为什么跟随主会话](#子会话为什么跟随主会话) |
| **对话框里的子会话计数** | `index.js` `preview()`（只读）+ `client.js` 三个对话框的 `preview` 调用与 `delete.children` / `batch.confirmChildren` / `bin.purgeChildren` 文案；`preview` 失败必须降级成「不显示计数」而不是阻塞 |
| 回收站行上的「附 N 个子会话」 | `client.js` `BinPanel` 里的 `childCountOf(entry)` 与 `bin.childCount` 文案 |
| 拒绝理由与 HTTP 状态码 | `index.js` `statusFor()`；新增码要同时加到 `client.js` 的 `zh`/`en` 字典（`error.<code>`），否则 `test-client.mjs` 会失败 |
| 删除准入判据 | `index.js` `isBusy()` + `admit()` + `assertTreeIdle()`；**别退回「存在 Agent 即拒」**（见不变量 4） |
| 清单新增字段 | `index.js` `trash()` 里的 `manifest` + `restore()`/`reattach()` 对应读取；记得升 `schema` 并保持旧条目可读（`entryNodes()` 是兼容层） |
| 新增一个动作 | ① `dispatch()` 加分支 ② `deleteSessionTool()` 的 `parameters.action.enum` 与 `execute` 的 switch ③ `client.js` 里 `callHost({ action })` ④ 两边字典 |
| 新增一个 UI 入口 | `client.js` 末尾的 `ctx.slots.inject(...)`；先 `cordis_inspect_query` → `Slots.listSubTree` 确认槽位名与 props |
| 丢弃悬空 id 的清理策略 | `index.js` `forget()`；准入失败的还原见 `restoreAccounting()` |
| 「未分组」幽灵 | `index.js` `installHiddenSessionFilter()` + `hideWhileLive()` / `repopulateHidden()`；隐藏集在 `trash` 后加入、`restore` 时移除、插件重载时按 bin 重建 |

### 不变量（别破坏）

> 下文提到的 `verify-paths.mjs` / `validate-bundle.mjs` / `test-*.mjs` 是**开发工作区里的离线校验套件**
> （见 [测试](#测试)，不随本仓库发布）。这里写它们，是为了说明每条不变量**已经被什么方式钉住过**——
> 改代码时照着每条的说明自查即可，不必真的去跑这些脚本。

1. **只移动、不删除**（除 `purge*`）。任何搬动失败都要能 `rollback()` 回原位。
2. **路径只能由 id 推导**，并校验目标目录名等于 `encodeSegment(id)`；永远不要接受调用方传路径。
3. **编码函数必须与 `dsh-session-persistence-jsonl` 保持一致**。升级 DSH 后第一件事就是
   拿真实会话目录核对一遍（离线套件的 `verify-paths.mjs` 会把每个真实项目目录反向解码再比对）。
   不一致时表现为「删除报 session-unknown」或「找不到目录」，而不是误删——这是刻意留的安全余量。
4. **只有「还有工作」的会话必须拒绝**，判据不是「存在 Agent」。被打开过的会话必然有
   一个空闲 Agent（background activation，Host 退出才释放）；用
   `ctx.get('agents').get(id) !== undefined` 当护栏会让刚点开的会话永远删不掉（1.0.0
   的 bug，2026-10-19 修）。正确准入是 `workspaceRegistry.archiveSession(id)`（DSH 官方
   `workspace/session-activity` 检查）+ 再查 `agent.status`/inbox；不要为了「方便」绕过。
5. **UI 与工具共用同一批方法**。新增删除类能力时两边必须一致，不要出现「UI 能删、模型不能」。
6. **Host 半不引入第三方依赖**，只用 `node:*`；否则 `link:` 安装会因解析失败而激活失败。
7. **Client 半只 `require` Module Loader 静态模块表里的包**（`react`、`react-dom`、
   `react/jsx-runtime`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、
   `@deepseek-ai/dsh-client-store` / `-ui-slots` / `-ui-primitives` / `-ui-dockkit`），
   **不** require 表外的 Harness 客户端包；样式只用 `--dsw-alias-*` 主题 token
   （`validate-bundle.mjs` 检查白名单）。
8. **locale 的 zh/en 必须键集合相同**，且代码里 `t('...')` 用到的键都要在字典里
   （`test-client.mjs` 双向检查，含 `error.<Host 码>` 的覆盖）。
9. **删掉的活会话必须遮出语料列表**。移动文件不会拆掉内存里的 Session，而
   `sessionQuery.listSessions()` 会合并活会话；删了不遮 → 侧栏「未分组」幽灵
   （1.1.0 回归）。隐藏集在 `trash` 成功后加入、`restore` 时移除、插件重载时
   `repopulateHidden()` 按 bin 重建；过滤器卸载时必须还原原方法。
10. **批量操作必须逐项走单条路径**。`trashMany` 是循环调 `trash()`、`archiveMany` 是循环调
    官方 `workspaceRegistry.archiveSession()`、`restoreMany` 是循环调 `restore()`、
    `purgeMany` 是循环调 `purge()`；**不要**为了「快」写批量直搬或直写 registry，
    否则准入、回滚、隐藏集、语料过滤这些护栏会全部失效。部分失败必须如实返回
    `{ trashed/archived/restored/purged, failed }`，不能整单报成功。
11. **`main` 的 key 必须等于 `sidebar.panellist` 的 id**。`layout.selectPanel(id)` 对没有
    `main` 注册的 id 会抛错；两者分叉的表现是「点侧栏图标什么也不发生 / 控制台报错」。
12. **hover 只用 `--dsw-alias-interactive-bg-hover`**（`HOVER_FILL`）。`bg-layer-*` 是表面/填充色，
    浅色主题下是纯白，拿来当 hover 就是「白色斑块」——这是 1.2.x 的实际缺陷，1.3.0 修。
    `validate-bundle.mjs` 守着这条（不许出现 `background = 'var(--dsw-alias-bg-layer-2)'`）。
13. **侧栏右键菜单不碰宿主 DOM**。官方 `PanelRow` 不是槽位，插件只在图标上打
    `data-session-recycle-bin-nav` 标记，并在 `document` 上监听 `contextmenu`，
    命中「含该标记的按钮」才拦截；监听器随图标 mount/unmount 安装/移除。
    **不要**去 `querySelector` 官方侧栏结构或给它挂 style，DSH 升级必坏。
14. **弹层注册在 `shell.overlay`，不要塞进侧栏**。侧栏列有 `overflow: hidden` 与 transform，
    在里面画 `position: fixed` 也会被裁；`shell.overlay` 是全框、click-through 的专用座位。
15. **销毁后要联动所有已挂载的 bin 页**。侧栏页与设置页可能同时挂着两份 `BinPanel`，
    销毁后必须 `binRevision.set(binRevision.get() + 1)`，否则另一份面板还显示旧条目并把它们
    当成可操作对象。
16. **销毁确认只有一个实现**（`BinConfirmDialog`），且必须是**对话框**而不是页内确认条：
    确认条开着时下层控件仍可交互，用户能改掉正在被确认的那个选择（1.3.0 实际 bug）。
    `BinPanel` 在 `confirmRequest !== null` 期间必须整体 frozen。
17. **批量动作的返回值必须同时给数组和计数**。`dispatch()`（UI 通道）与工具通道形状要一致：
    `<items>` 给调用方、`<items>Count` 给显示。只给数组会让 UI 打印 `undefined`（1.3.0 bug）。
18. **弹层必须 portal 到 `document.body`**。`shell.overlay` 被宿主包在
    `.AppFrame_overlayLayer { z-index: 20 }` 这个层叠上下文里，**在里面写 `zIndex` 无法超过 20**，
    于是设置面板（`z-index: 1000`）会盖住它（1.3.2 修的实际 bug）。所有 `Dialog` 都走
    `portalize()`；新增弹层也必须走它，并从 `DIALOG_Z_BASE`（1200）起算层级。
19. **一个 bin 条目 = 一棵会话树**。`trash()` 只创建一个条目，根会话 + 全部子会话都在里面；
    `restore()` / `purge()` 必须按整树处理，**不要**把子会话拆成独立条目（唯一例外是清理
    **孤儿子会话**：父已不在持久化里，它自己成一棵树）。恢复要先检查全部目标再动字节，
    冲突就整条拒绝——半棵树回来比拒绝更糟。
20. **树只按持久化 header 的血缘解析**：`origin === 'subagent'` 且 `parentSession` 是字符串。
    fork 也带 `parentSession` 但**没有** `origin`，它是独立对话，永远不能被父会话带走；
    `parentSession` 缺失/不可读的子会话视为孤儿，不参与父树。
21. **对话框必须在动作前拿到子会话计数**。单条删除与批量删除在打开时调只读的 `preview`；
    销毁确认用条目 manifest 的 `childCount`，侧栏「清空」路径用 `list` 探测补齐。
    `preview` 只许读、不许移动任何字节，且失败时降级为「不显示计数」，不能阻塞删除。

### 升级 DSH 后要复查的点

- `session-persistence-jsonl` 的目录布局与编码函数（`projectKey` / `encodeSegment`）——
  对照真实会话目录核对（`lib/session-paths.js` 是它的镜像实现）。
- 投影缓存记录的嵌套形状（当前是 `{ version, record: { identity, rows: { <key>: { ver, seq, val } } } }`，
  `index.js:104` `titleOf()` 兼容旧扁平形状）——看 `~/.dsh/storages/session_projcache/sessions/*.json`。
- `sessionQuery.listSessions()` 是否仍存在、仍是「持久记录 + `ctx.sessions` 活会话合并」的实现，
  以及 `sessionController.list()` 是否仍走它——被删活会话的「未分组」幽灵靠
  `installHiddenSessionFilter()` 在这层过滤；形状变了会 warn 降级（幽灵可能回归，但不影响字节安全）。
- 槽位是否还在、props 是否变化——`cordis_inspect_query` 查 `Slots.listSubTree`。
  **1.3.1 起是九个注册、五个槽位**：`sidebar.workspaces.session.menu.item`（两行）、
  `shell.overlay`（四个：删除框 / 批量面板 / 右键菜单 / 销毁确认）、
  `main`（key `session-recycle-bin`）、`sidebar.panellist`（id 同名）、`settings.section`。
- **`sidebar.panellist` 的 owner props 是否仍只有 `size` / `active`**：右键菜单靠
  `BinNavIcon` 自己的 `useEffect` 挂 document 监听，不依赖 owner 给的回调；若哪天宿主
  给 panellist 追加了 `onContextMenu` 之类的 prop，可以改成直接用它（更省一个全局监听）。
- **`PanelRow` 的 DOM 是否仍是「一个 `<button>` 包住 glyph span」**：右键命中判定是
  `target.closest('button')` + `row.querySelector('[data-session-recycle-bin-nav]')`。
  若宿主把那一行改成 div 或加了嵌套 button，命中会失败（表现为「右键没反应」，不会崩）。
- 菜单 / 弹层的层序是否能盖住宿主菜单：当前右键菜单 `zIndex: 60`，批量删除确认框用
  `Dialog layer: 50`。
- `main` / `sidebar.panellist` 这一对是否仍是「点图标 → `selectPanel(id)` → 按 key 渲染」的实现
  （读 `ui-sidebar` 的 `PanelRow` / `ui-layout` 的 `MainPanel`）。
- `ui-workspace` 的 `SessionNodeItem` / `ProjectRowItem`：若某天工作区菜单也变成槽位，
  批量入口可以搬回工作区行菜单。
- `useSessions` / `useWorkspaces` / `useSessionStatus` 这几个标准 slot props 的形状
  （批量面板读 `state.items[].sessionIds`、`state.byId[id].{title,updatedAt,blank,origin,running}`、
  `state.archivedSessionIds`）。
- 插件清单约定（`dsh.bundle.patch` / `dsh.client`）——核对 `package.json` 的 `dsh` 段与 **exports、
  files、icon、locale 四者一致**（离线套件的 `validate-bundle.mjs` 曾逐条断言这一点）。

### 当前设计取舍

- 删除 = **归档准入**（顺便隐藏 + 装门禁）+ 移动 + 清登记 + **遮出语料列表**；归档集合在
  `forget()` 里清掉，恢复按 `entry.json` 的 `archived` 字段复原。准入失败时
  `restoreAccounting()` 会把隐藏/取消置顶还原，`rollback()` 把已移动的字节搬回。
- 空闲 Agent 不拆卸：插件没有、也不该有拆别人 Agent 的句柄（`AgentHandle` 是创建者的能力）。
  空闲 Agent 不写日志、不跑步骤，移动目录对它无影响；删除后它仍持有 Session 对象，所以
  用一层 `sessionQuery.listSessions` 过滤器把该 id 遮掉（`installHiddenSessionFilter`），
  而不是去拆 Agent；恢复后同一 Agent 还能继续对话。
- 过滤器的代价：包了 DSH 的一个内部读路径（卸载会还原）。找不到方法时只 warn 降级，
  最坏结果是幽灵行回归，不会影响删除事务本身。
- 恢复后侧栏可能需要刷新页面：删除方向 Host 会发 `api-session/removed`（会话控制器据此移除行），
  但**恢复方向没有对应的 added 事件**——`api-session/added` 需要一个活的 Session 对象来合成摘要，
  而刚恢复的日志要等某次打开/激活才有。Client 服务面（`retain`/`using`/`fork`/`search`/
  `refreshProjections`/…）**没有** `refresh()`，1.1.1 里那行 `ctx.sessions.refresh?.()` 是静默空操作
  （1.2.0 已删，改为在 UI 文案里如实提示「侧栏可能需要刷新一次页面」）。
- 回收站有**两个入口但只有一份实现**：侧栏页（`main` 面板）与设置页共用 `BinPanel`；
  侧栏页是「主动打开」的页面，设置页是按你要求保留的旧入口。两份实例通过 `binRevision`
  互相知道「别处刚清空了回收站」。
- **回收站页的每行是「勾选 + 身份 + 操作」三段**（1.3.0）：复选框永远在最左，恢复/彻底删除
  永远在最右，长列表里对齐；批量动作在选择栏里，不复用行内按钮。
- **批量恢复/彻底删除逐项执行**：与批量删除同构，N 次单条事务，`failed[]` 如实列出。
  `restoreMany` 里一条 `restore-conflict` 不会阻断其余条目。
- **侧栏右键只做一件事：清空回收站**。没有做「右键菜单里也放恢复/彻底删除」——那需要先选条目，
  而右键发生在侧栏图标上（不是条目上），语义对不上；逐条操作留在回收站页。
- **清空是不可逆操作，所以永远走确认框**：确认框会先 `list` 一次把条数写进正文，条数为 0 时
  确认按钮 disabled，避免「点了没反应」的误导。
- **批量归档用的是 DSH 原生归档**（`workspaceRegistry.archiveSession`），因此「已归档」的语义
  与侧栏「显示已归档」筛选完全一致：文件保留、行隐藏、可 `unarchiveSession` 取回。
- **批量入口在会话菜单里而不是工作区菜单里**：工作区菜单没有槽位（详见上文「批量操作为什么在会话菜单里」），
  作用域由该会话所属工作区推导，效果等价于「对这个工作区批量操作」。
- **批量面板的复选框与回收站页的复选框是两套**：前者选「要归档/删除的会话」（还在侧栏里），
  后者选「回收站里要恢复/销毁的条目」。侧栏行首仍然不放复选框（16px 槽位对有状态点/已归档的行
  根本不渲染，做不出完整选择）。
- 回收站条目不会自动过期，磁盘占用由用户显式「彻底删除」控制。

## 已知限制

- 删除仍有**运行中工作**的会话被拒绝（回合 / 后台 job / 子代理 / 定时提醒）。这是 DSH
  归档准入的语义，插件只是把它映射成 409 `session-open`。**批量删除/归档同样如此**：
  运行中的会话会被跳过并在结果里标出，其余照常执行。
- 批量上限 200 个 id（`BATCH_LIMIT`），**批量恢复/彻底删除同样按 200 条上限**；超出直接拒绝
  而不是截断。请求体上限 `MAX_BODY_BYTES`（64 KiB）必须容得下最大批量，`test-bin.mjs` 有一条
  断言把两者钉在一起（8 KiB 的旧上限会让满批在到达服务前就被 `body-too-large` 拒绝）。
- **「清空回收站」没有软撤销**：`purgeAll` 直接 `rm -rf` 每个条目目录。确认框、条数提示、
  危险色都是为此服务的，没有回收站的回收站。
- 回收站页的勾选是**页面内状态**，刷新页面或切走再回来会清空；不会跨面板同步。
- 侧栏右键菜单**不拦截宿主的浏览器右键**（在页面其它地方右键照常）；只在
  「含 `data-session-recycle-bin-nav` 标记的按钮」上拦截。
- 空闲但打开中的会话**可以**删除；日志写句柄随文件对象跨 rename 保持有效，恢复后继续对话。
  被删会话的 Agent/Session 对象会留在内存直到 Host 退出（DSH 本来就这样），期间由列表过滤器
  遮住；`purge` 后它同样不再出现在列表里。**彻底删除后如果用户仍想用该 id 续聊，只能恢复**。
- 准入与搬动不是原子操作：极小窗口内新开始的回合会先被归档门禁挡住模型步骤，插件也会在
  搬动前再查一次 Agent 状态；DSH 自己的归档也有同样窗口。
- 启用 **Auto review** 权限预设时，`delete_session` 的写调用可能被逐工具自动审核拒绝——
  那是 DSH 的权限策略，不是插件行为；换权限预设或从 UI 操作即可（UI 走 HTTP 路由，不过该审核）。
- 回收站条目**仍占磁盘**，直到彻底删除；没有自动过期清理。
- 如果将来启用全文搜索后端（`dsh-session-query-sqlite` 的 `openAt` 改成
  `startup`/`first-search`），它会另建 SQLite 索引，本插件不清理那个索引库。
- **子会话只能跟随主会话删除**：父会话还在时直接删子会话会被拒绝（`session-child`）；
  这是刻意的，因为 UI 没有子会话入口，而单独删子会话会在父会话的 `subagentCatalog`
  里留下打不开的悬挂条目。旧版本留下的**孤儿**子会话（父已不在持久化里）仍可用
  `delete_session` 按 id 清理，它会带走自己的子树。
- 树只按**持久化 header** 解析：子会话如果连日志都没落盘（只存在于别的进程内存里），
  本进程看不到，也就无法搬走；正常 DSH 里子会话创建即持久化，不构成实际缺口。
- 树规模没有单独上限：一个父会话带多少子会话就搬多少（DSH 的 `maxActiveSubagents`
  只限制并发，不限制历史）。恢复是「全有或全无」，不会半棵树回来。
- 彻底删除父会话后，它的子会话也一起销毁；如果之前单独把某个子会话删进回收站，
  那个条目是独立的，不会跟着父条目一起走。
- Windows 上跨卷移动走 `EXDEV` 的复制回退；同卷内是原子 `rename`。

## 目录结构

```
package.json          清单：name（dsh-recycle-bin）+ dsh.bundle.patch + dsh.client + repository / publishConfig
cordis.patch.yml      插入 Host 半的一行（row id: session-recycle-bin，name = 包名）
index.js              Host 半：服务 + HTTP 路由 + delete_session 工具（preview / 子会话整树 trash / trashMany / archiveMany / restoreMany / purgeMany）
client.js             Client 半：Module Loader 工厂，五个槽位的九个注册（菜单两行 / 四个浮层 / 侧栏图标 / main 面板 / 设置页），三个确认框带子会话计数
lib/session-paths.js  与 jsonl 后端一致的目录名推导（encodeSegment / projectKey）
locale/{zh,en}.json   插件管理页的标题与描述
icon.svg              插件图标（原创 SVG）
README.md             本文件
LICENSE               MIT
.gitignore            忽略 node_modules / .env / 日志 / 编辑器与系统噪声
```

## 测试

> **本仓库不含测试脚本。** 插件的离线校验套件（`verify-paths` / `validate-bundle` / `test-bin` /
> `test-mirror` / `test-client`）由作者在独立的开发工作区维护，不属于发布包；`package.json` 的
> `files` 也不包含它们。下面列出的覆盖项是**已跑过的校验内容**，供了解可靠性边界，
> 而不是让你在本目录里执行命令。

校验环境是一个临时的 `$DSH_HOME`：`test-bin` 在临时目录里建一套会话树，
`test-mirror` 只**读**真实 `$DSH_HOME` 做拷贝后再操作，两者都**不会**动到你的真实数据。

| 套件 | 覆盖什么 |
| --- | --- |
| `verify-paths.mjs` | 目录名推导与真实会话目录逐一对照（含反向解码） |
| `validate-bundle.mjs` | 清单、exports、locale、图标、补丁、无 postinstall、只用主题 token、**hover 不许用表面 token** |
| `test-bin.mjs` | trash/list/restore/purge/purgeAll + 回滚 + 拒绝码（运行中 / 排队 / 活动提供方 / 子会话） + 准入失败还原 + **trashMany / archiveMany 的批量部分失败、去重、空表/超长/穿越 id** + **restoreMany 的冲突隔离与 purgeMany 的部分失败/未知条目** + **子会话整树的 trash/restore/purge/冲突/孤儿/preview** + 语料列表过滤器与隐藏集生命周期 |
| `test-mirror.mjs` | 真实 `$DSH_HOME` 的映射拷贝上，挑一个带真实子会话的根会话做完整删除→恢复，校验父与全部子会话的字节数 |
| `test-client.mjs` | Client 半在 React shim 下渲染全部座位，校验跨 slot 请求链路、红色 token、批量面板交互、`main` key 与侧栏 id 一致、文案覆盖（含 `batch.*` 与 `error.*`）；用到带 `fetch` 双 + 可跑 effect 的 mount 真跑：回收站页勾选→批量恢复/彻底删除（含确认前不发请求）、侧栏右键→清空确认框→`purgeAll`、三个对话框的**子会话计数**与回收站行的「附 N 个子会话」、hover token 断言 |

上面这些断言对应的**不变量**写在下文「不变量（别破坏）」一节——改代码时按那份清单自查，
等价于在跑这套校验。

## 安装与卸载

**从市场 / npm 安装**（插件名 `dsh-recycle-bin`）：

```powershell
dsh plugin --profile <profile> add dsh-recycle-bin
```

**以本地目录安装**（开发用，`link:` 安装，源码即运行代码，不需要 build）：

```
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

装完刷新页面。Client 半由 `dsh.client` 清单发现，Host 半由 `cordis.patch.yml` 插入。
两边的 row id / 包名必须与 `package.json` 的 `name` 一致，离线校验套件的
`validate-bundle.mjs` 逐条钉住这一点。

卸载用 `remove_bundle`；回收站里尚未恢复的条目会留在 `~/.dsh/session-recycle-bin`。

## 手动恢复（插件不在时的兜底）

**schema 2（1.4.0 起的条目 = 一棵树）**：

```
~/.dsh/session-recycle-bin/<entry>/session/                              → ~/.dsh/sessions/<projectDir>/<id>/
~/.dsh/session-recycle-bin/<entry>/projcache.json                        → ~/.dsh/storages/session_projcache/sessions/<id>.json
~/.dsh/session-recycle-bin/<entry>/children/<encodedChildId>/session/    → ~/.dsh/sessions/<childProjectDir>/<childId>/
~/.dsh/session-recycle-bin/<entry>/children/<encodedChildId>/projcache.json → ~/.dsh/storages/session_projcache/sessions/<childId>.json
```

根会话用 `entry.json` 顶层的 `projectDir`；每个子会话用自己的节点
（`entry.json` 的 `children[i].projectDir` / `sessionId`），`<encodedChildId>` 就是
`encodeSegment(sessionId)`。`entry.json` 没有 `children` 的是 schema 1 旧条目，按第一行两条路径恢复即可。

`projectDir` 是删除时实际找到的项目目录名，比从 `cwd` 反推更可靠。恢复后刷新页面即可见。
