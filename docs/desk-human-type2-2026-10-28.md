# 新版人工智能投稿分区接入 · 2026-10-28

## 已修正的误判

首轮只看 `archive/pre.typelist`，看到旧分区还在，便判定账号只能走旧分区。这个推断不成立：本机账号实际返回 **type_mode=2**。官方网页在此模式读取另一份新版列表，通过独立字段 **human_type2** 选择分区；提交仍使用 `/x/vu/web/add/v3`，不需要先发一次真实投稿来“试编号”。

## 官方证据

- `GET /x/vupre/web/archive/pre`：本机账号 `type_mode=2`。
- `GET /x/vupre/web/archive/human/type2/list`：本机账号实时返回 30 个单层分类，包含 `{id:1011,name:"人工智能"}`；没有可选的“AI学习”等子类。真实分区字段保存于 `test/fixtures/desk-partitions-human-type2.json`。
- 官方投稿页加载的 `creator-monorepo/videoup/static/js/index.d5f1eae0.js`：`type_mode===2` 时取新版列表；构造 payload 时写 `human_type2`；旧 tid 未设置时使用 21 兼容；投稿仍为 `/x/vu/web/add/v3`。可定位摘录、URL 与 SHA-256 位于 `diagnostics/desk-human-type2-protocol-20261028.json`。
- 读取官方网页时拦截了所有非 GET/HEAD 请求；未上传测试素材、未创建草稿或提交稿件，也未保留 Cookie。

## 当前实现

- `desk/bili.mjs` 按 `type_mode` 选择新旧列表；新版获取失败不偷退旧版。请求使用注入的 origin/fetch，测试不接触真实账号。
- `desk/partitions.mjs` 分别解析新单层列表与旧二级列表，校验选择所属模式和实时成员资格；不拿首页频道表伪造可投稿子类。
- `desk/publish-contract.mjs` 与 `desk/service.mjs` 统一预览/提交映射。新版选择提交 `human_type2=1011`，旧 `tid=21` 仅作为同官方客户端的兼容字段，不解释成分区对应关系。旧模式继续使用真实旧 tid，不发送新版字段。
- UI 随账号自动展示“新版”或“旧版”；新版可直接搜索/选择“人工智能”。模式变化会清空选择，提交前重新查询模式与列表，防止把 1011 混进旧 tid。

你的 AI／Agent、智能体、大模型讲解与开发视频，当前账号直接选 **人工智能**。一般计算机课程可考虑“知识”，而不是把所有计算机内容都指向 AI；这属于内容建议，不是新建官方子分类。

## 验证与边界

- 使用真实账号只发两次 GET，服务端实取 30 个分类；以合成草稿跑真实发布服务的本地预览，得到 `human_type2=1011, tid=21`，无阻断项。记录见 `diagnostics/desk-human-type2-live-20261028.json`。合成草稿不代表某份真实成片通过验收。
- 页面回归点击“人工智能”，通过真实 service/contract 构造预览并核对 JSON，包含模式切换清空选择。网络与账号使用模拟桥；截图 `diagnostics/desk-human-type2-20261028.png` 明确显示模拟账号。
- 另启动真实 Electron，使用独立 user-data 隔离窗口实例，读取本机已有登录态，只做界面启动和只读查询；真实 preload/IPC 链路显示“投稿分区（新版）”、30 个选项及“人工智能（1011）”，无页面异常。记录 `diagnostics/desk-human-type2-electron-20261028.json`，未存储账号名或 Cookie。
- 发布台 8 个定向测试文件 **66 项通过、0 失败、0 跳过**，覆盖新版响应、失败不降级、字段映射、预览/提交一致、模式变动零上传，并保留旧版回归。命令见 `desk/README.md`。
- 本轮全仓测试 **1240/1242 通过，2 项失败**：`motion-study.test.mjs` 的乱序 seek 像素哈希不一致；`topic-entry.test.mjs` 的退出清理出现 `ENOTEMPTY`。只针对这两个文件以并发 1 复查，12 项均通过；这不证明全仓失败原因已排除，不把全仓改记为通过。本轮没有扩大修改动画或 worker 清理代码。
- 未执行正式投稿，尚不能声称 B 站已接收真实稿件或审核归属已确认。正式提交仍必须由用户确认，不自动重提。
