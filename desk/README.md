# 发布台 · B 站投稿

本地视频做完后，在这个窗口里填标题、标签、简介、分区、封面上传，一键投稿。
**不打开哔哩哔哩网页**，不走网页填表，直接调用 B 站投稿接口。

## 打开与关闭

**打开**：双击仓库根目录的 `打开发布台.command`。终端窗口会自动关掉，发布台作为独立窗口出现。
重复双击不会开出第二个窗口，只会把已有的窗口切到前面。

也可以命令行启动：

```bash
npm run desk
```

**关闭**：直接点窗口左上角红点，或按 `Cmd+Q`。关掉窗口就是完全退出，不留在后台。

如果窗口卡住点不动，双击 `关闭发布台.command`（先正常请求退出，3 秒内没退出才强制结束）。

首次运行会自动装 Electron 运行时（约 100MB，只装一次）。

## 扫码之后就能发吗？

**能，但有一个前提：登录成功 ≠ 能投稿。** 所以扫码成功后会自动做一次只读体检：

| 检查项 | 说明 |
|---|---|
| 登录状态 | 账号名与等级 |
| 创作中心接口 | 能否读到分区（证明登录态与设备标识被接受） |
| 上传线路 | 能否申请到 UPOS 线路（证明上传链路可用，**不传任何数据**） |

三项都通过才显示预检通过；这不保证 B 站最终接受投稿。任一失败，界面会直接写出原因。

体检只读，不创建草稿、不投稿。窗口每次打开也会体检一次，登录过期或风控会在右上角显示「投稿受限」。

## 分区怎么选

B 站新版有独立的「人工智能」分类，**发布台现在已经支持直接选择**，不再要求你的账号选旧版计算机技术。

2026-10-28 实查本机账号：`archive/pre.type_mode=2`；官方页面另取 `archive/human/type2/list`，返回 30 个可选分类，其中包含 **人工智能（1011）**。旧 `typelist` 仍在响应里，不代表账号只能使用旧分类。之前据此判断“新版不能选”是错的。

**你的 Agent／智能体、大模型原理、开发实操，直接选「人工智能」。** 搜 `AI`、`Agent`、`人工智能` 即可找到；检索不替你自动选择。一般编程、算法、计算机课程可考虑「知识」，科技产品测评可考虑「科技数码」。后两项是内容建议，不是声称官方定义了新的子分类。

发布台自动按账号模式使用相应协议：

- **新版（type_mode=2）**：读取单层新版列表，用 `human_type2` 提交；人工智能为 `human_type2=1011`。旧 `tid` 使用官方客户端同款兼容值 21，它不是对人工智能的旧分区映射。
- **旧版（type_mode=0）**：仍读取旧二级分区，用 `tid` 提交，AI 技术内容可选「科技 · 计算机技术（231）」。
- 新列表读取失败、选项失效或账号模式变化时阻断并要求刷新，不自动偷换旧分区。未验证的模式不猜测支持。

以下表格仅适用于仍处于旧版模式的账号：

| 内容类型 | 分区 | tid |
|---|---|---|
| AI 工具、模型、开发、原理 | **科技 · 计算机技术** | **231** |
| 用 AI 软件做东西、软件测评 | 科技 · 软件应用 | 230 |
| 面向大众的自然科学科普 | 知识 · 科学科普 | 201 |
| AI 行业分析、商业解读 | 知识 · 财经商业 | 207 |
| AI 生成的影像作品 | 影视 · AI影像 | 259 |
| AI 生成的音乐作品 | 音乐 · AI音乐 | 265 |

旧版中，搜索 `AI`、`Agent`、`人工智能`、`智能体`、`计算机科学` 或 `231` 可找到「计算机技术」；不会篡改官方名称。不要只因视频用了 AI 制作就选择旧版「AI影像」「AI音乐」，应按内容主题选择。

分区来源：[投稿预检接口](https://member.bilibili.com/x/vupre/web/archive/pre)、[新版可选分区接口](https://member.bilibili.com/x/vupre/web/archive/human/type2/list)和官方投稿页客户端代码。真实分区节选在 `test/fixtures/desk-partitions-tech.json`、`test/fixtures/desk-partitions-human-type2.json`；协议摘录在 `diagnostics/desk-human-type2-protocol-20261028.json`；真实只读核对在 `diagnostics/desk-human-type2-live-20261028.json`。均不含账号凭据；未真实上传或投稿。

## 用法

1. **首次登录**：点右上角「未登录，点此扫码」→ 手机 B 站 App 扫码 → 自动保存登录态。
   登录信息写在 `~/.config/video-harness/bilibili.json`（权限 600），不进项目、不进交付包。
   之后每次打开都已登录，除非登录过期。
2. **选项目**：左侧列出 `projects/` 下的项目，带出 `发布文案.md` 的标题/简介/标签，以及当前成片和已绑定封面。
3. **改内容**：标题、标签、简介可自由改；分区从列表里选（登录后来自你账号的真实分区）。
4. **试运行**：右侧显示将要提交的完整内容，包括封面尺寸、体积、比例提醒。**这一步不发任何请求。**
5. **提交投稿**：弹窗确认后重新读取实时分区、本地预检封面，再上传视频（分块）→ 上传封面 → 提交。失败不自动重提；提交结果未知时先查稿件管理。

投稿台即时显示表单缺项与审阅状态；审阅待核是提示，不自动当成已通过，也不等同投稿接口的硬拦截。表单改动后旧预览失效，需重新试运行。标签支持空格、逗号和顿号分隔。审阅记录与依据指纹不能证明实际看过/听过或事实准确。

## 边界

- **只做投稿，不做社群运营**：不自动发评论/动态/私信，不刷数据。
- **投稿不可撤销**：确认框是最后一道闸；程序不会自动提交、不会失败后重试提交（只重试上传分块）。
- **置顶评论**不通过接口发布（B 站没有对应公开接口），提交成功后点「复制置顶评论」手动贴。
- **商业推广**：当前投稿表单和 payload 没有经过验证的商业推广声明字段；不要认为工具已代勾。按平台当前界面和规则自行确认；自制/转载是另一项判断。
- **分区清单**：登录后按账号模式读取新版或旧版接口；离线清单只能参考。未知编号、旧版父分类、新旧字段混用、临提交时模式变化均阻断，不猜测映射。
- **封面要求**：≥ 960×600、≤ 5MB、建议 16:9。尺寸不够会直接拒绝（放大只会更糊）；仅体积超限时自动转码 JPEG，并在界面写明已转码。
- **凭据安全**：只保留登录必需 Cookie 及必要设备标识，不打印、不写日志；保留字段由 `bili.mjs` 管理。

## 结构与解耦

业务模块不依赖 Electron；只有 adapter 接触 harness 内部结构。投稿规则可单独测试：

| 文件 | 职责 | 依赖 |
|---|---|---|
| `desk/partitions.mjs` | 分区解析、离线参考、搜索别名、新旧编号边界 | 无外部依赖，前后端共享 |
| `desk/publish-contract.mjs` | 表单校验、标签解析、payload 映射的唯一规则 | 无外部依赖，前后端共享 |
| `desk/service.mjs` | 预览/提交用例、实时分区核对、防并发提交 | contract、partitions、publish；依赖注入 |
| `desk/bili.mjs` | B 站投稿协议：preupload / UPOS 分块 / 封面 / 提交 | `node:fs`、contract、partitions |
| `desk/login.mjs` | 扫码登录、凭据文件 | `bili.mjs` 的 cookie 工具 |
| `desk/cover-prep.mjs` | 封面合规检查与转码 | `ffprobe` / `ffmpeg` |
| `desk/publish.mjs` | 投稿编排：本地预检 → 上传 → 组 payload → 提交 | contract、注入的 `api` / `prepareCover` |
| `desk/draft.mjs` | 草稿组装、结构化素材 blockers | `node:path` |
| `desk/harness-adapter.mjs` | 唯一接触 `lib/*` 的地方 | harness 内部 |
| `desk/projects.mjs` | 目录扫描 + 调用 adapter/compose | 上面两层 |
| `desk/main.mjs` | Electron 窗口与 IPC 接线 | 以上全部 |
| `desk/ui/*` | 界面；复用纯合同与分区规则 | 外部能力只经 `preload.mjs` 白名单 |

预览和正式提交共享 payload 映射；IPC 不再维护一套投稿规则。媒体状态在每份草稿内只读一次，不跨请求缓存。核验失败/过期/只有静音母版时禁止提交；通知和临时文件清理失败不会把已确认的投稿改判失败。

## 测试

```bash
node scripts/test.mjs test/desk-bili.test.mjs test/desk-publish.test.mjs test/desk-partitions.test.mjs test/desk-service.test.mjs test/desk-harness-adapter.test.mjs test/desk-http.test.mjs test/desk-human-type2.test.mjs test/desk-ui.test.mjs
```

覆盖：分块上传参数、真实分区结构、AI/Agent 搜索、预览/提交一致性、封面预检零上传、清理异常、结果未知、响应体超时、媒体单次核验、凭据权限、草稿缺项降级。页面测试点击真实控件，但使用模拟 IPC/账号，不证明真实投稿成功。

自检（不投稿）：

```bash
VH_DESK_SMOKE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron desk/main.mjs
```

## 协议来源

- `GET  member.bilibili.com/preupload`（申请上传线路）
- `GET  member.bilibili.com/x/vupre/web/archive/pre`（账号模式、旧分区）
- `GET  member.bilibili.com/x/vupre/web/archive/human/type2/list`（新版分区，提交字段为 human_type2）
- `POST {upos}?uploads&output=json` → `PUT` 分块 → `POST` 合并
- `POST member.bilibili.com/x/vu/web/cover/up`（封面）
- `POST member.bilibili.com/x/vu/web/add/v3?csrf=…`（投稿）
- `GET  passport.bilibili.com/x/passport-login/web/qrcode/generate|poll`（扫码）

上传部分原对照 biliup 1.3.4；新版分区于 2026-10-28 对照官方投稿页客户端及真实只读响应补齐。B 站接口可能调整，失败时界面会显示服务端原因，不会假装成功。
