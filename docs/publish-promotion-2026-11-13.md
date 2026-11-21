# 发布台商业推广声明

> **协议纠正**：本文首次接入只实现了 `porder`，不能据此认定播放页「内容含营销信息」已生效。当前官方新投稿页使用 `creation_statement: { id: 3 }`；已补齐该字段及收稿后回读，见 [营销标注修复](publish-marketing-fix-2026-11-13.md)。下文旧脚本的 `porder` 依据仍保留，但不再作为新标注依据。

> 同日后续优化已将页面的「保存本作品声明」合并为「保存作品投稿资料」，标题、简介、标签、封面选择和声明一起保存；旧声明文件/接口仍兼容。当前使用方式以 [发布台可靠性优化](publish-reliability-2026-11-13.md) 为准，本文保留首次接入时的协议依据和验证边界。

## 用户口径

增加「包含商业推广」；品牌 / 网站名称、行业、推广形式均为选填，空值不发。没有甲方也可声明普通推广，不把网站介绍绑定到花火商单。项目不额外要求品牌、商单编号或甲方身份。

这里的“选填”指本工具不设必填校验。尚未用真实账号投稿验证 B 站是否接受仅含声明的参数；不承诺不同账号/行业都可省略补充项。若平台拒绝，显示原错误并停止，不自动去掉声明、不重试，也不推断勾选会消除下架风险。

## 协议依据

2026-11-13 只读查看 B 站公开投稿页及其当前脚本，未读取用户凭据或提交投稿：

- 页面：<https://member.bilibili.com/video/upload.html>
- 状态和 payload 组装：<https://s1.hdslb.com/bfs/static/studio-upload-v3/static/js/app.a5dfb4dc4e4933fa4a36.js>
- 商业声明组件：<https://s1.hdslb.com/bfs/static/studio-upload-v3/static/js/0.b7154e5d701b1f20ee90.js>

组件区分「含商业推广信息」与「花火商单」。普通推广映射 `porder.flow_id=1`；未关联认证品牌时 `official=0`；名称非空才发 `brand_name`，行业为 `industry_id`，推广形式 ID 用逗号连接到 `show_type`。本实现不沿用官方页面的默认行业，避免将未知网站误报为某行业。B 站网页内部接口不是稳定的公开 API 合同，未来变化须按平台实际响应处理。

行业和形式来自 `GET https://member.bilibili.com/x/vupre/web/archive/pre` 的 `industry_list` / `showtype_list`，不硬编码行业和形式列表；读取失败仍可留空。仅声明对应：

```json
{ "porder": { "flow_id": 1, "official": 0 } }
```

未勾选时整个 `porder` 不传，不发送 `order_id` / `adorder_id`，不改简介、口播或已发布视频。

## 本地接口与保存

- `GET /_api/publish/promotion-catalog`：需当前登录，读取平台补充选项。
- `POST /_api/publish/promotion`：`{id, promotion}`，无需登录，按已存在的项目保存声明，不触发上传、投稿或启用排程。写操作仍需同源、项目路径仍经 `resolveProject` 校验。
- 现有 `/plan`、`/submit` 接受 `promotion: { enabled: boolean, brandName?: string, industryId?: number|null, showTypes?: number[] }`。`/plan` 返回 `promotionSupported: true`，防止新前端把声明交给旧后端后被静默忽略。
- `GET /projects` 返回各项目已保存的 `promotion`，供回填。后台轮询不覆盖当前编辑。
- 项目根目录 `.publish-promotion.json` 为独立设置，原子写入。无文件时返回未勾选，不写回旧项目；损坏或格式无效则报错，不当成未声明。用户可在页面明确重新保存修复。
- 单次提交显式提供 `promotion` 时，以当前表单为准；排程、批量及旧 Electron 入口未提供时，公共服务在读取当前草稿后使用已保存的声明。手动投稿不会暗中修改后续自动发布配置。

## 验证

测试均用临时工程、假凭据和模拟平台，不发真实视频：

- `test/publish-promotion.test.mjs`：仅勾选/选填映射、规范化不丢字段、HTTP 投稿 JSON、平台拒绝不重提、配置损坏阻断、保存隔离、排程和批量接线、同源保护。
- `test/publish-schedule-ui.test.mjs`：桌面和手机显示选填、空补充资料可保存、按作品回填、选项失败、保存失败、旧后端阻断、单次模拟投稿和确认框。
- 回归公共发布服务、B 站客户端、投稿事务、分区与每日排程。

自动测试通过不等于 B 站实际保存了商业声明；未操作任何已发布视频，也未启用用户排程。

本轮相关回归累计 226 项通过，14 个修改/新增 JavaScript 模块通过语法检查。扩展回归首次发现旧 Electron UI 测试的静态资源替身缺少新依赖 `desk/promotion.mjs`，补齐映射后，两项失败测试与商业声明测试复跑全部通过。桌面 1280px 和手机 390px 截图已实际查看，见 `diagnostics/publish-promotion/`；无横向溢出，选填标识可见。

交付时检测到本机 8144 端口仍运行旧服务，且存在制作中的项目，因此未重启或结束用户进程。需在制作及投稿均空闲后重启工作台，再刷新发布台加载新接口。
