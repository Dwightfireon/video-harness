# 「内容含营销信息」标注修复 · 2026-11-13

## 原因与协议纠正

首次实现沿用了公开旧投稿页 `video/upload.html` 的商业声明组件，只提交 `porder`。模拟测试证明了参数传出，但没有证明平台保存了创作者声明，更没有证明观众端显示。不能把这些测试当作功能已经生效。

本次只读检查当前创作中心 `/platform/upload/video/frame`，发现实际加载的是新投稿微前端，而非旧 `studio-upload-v3`。没有上传素材、提交或编辑任何真实稿件。查看页面时在临时浏览器上下文拦截了全部非 GET 请求，浏览器已关闭，未启动本地工作台服务。

当前协议依据：

- `GET https://member.bilibili.com/x/vupre/web/archive/pre` 的 `data.neutral_mark.mark_list` 提供 `{ "id": 3, "content": "内容含营销信息" }`。`neutral_mark` 是选项来源，**不是本次应提交的字段**。
- 当前官方脚本：<https://s1.hdslb.com/bfs/static/creator-monorepo/videoup/static/js/index.9f5ceff0.js>。
- 选项读取原句：`this.pre ... neutral_mark ... mark_list`；组装提交参数原句：`creationStatementId)&&(c.creation_statement={id:_})`。脚本通过 `POST //member.bilibili.com/x/vu/web/add/v3` 发送表单。
- 官方脚本回填时读取 `archive.creation_statement.id`，并兼容 `creation_statement_id`；创作者声明选择器在 `isEditMode` 下禁用。因此本工具不提供自动补报/修改旧稿件的捷径。
- `GET https://member.bilibili.com/x/vupre/web/archive/view?bvid=…` 是按稿件编号回读编辑资料的只读接口。

实际查询到 `BV1KqWv6MEtH` 和 `BV12qWv6MEWQ` 的 `archive.creation_statement` 均为 `{ "id": -1, "content": "内容无需标注" }`；这能说明它们当前保存的声明，不证明当时表单是否勾选或请求里有何参数。历史日志无声明快照，不补写、不反向推断。

## 修复

- 保留已有 `promotion.enabled` 表单和保存格式；为 `true` 时，公共 payload 构造器追加 `creation_statement: { id: 3 }`。手动、排程、批量与兼容桌面入口使用同一构造器。
- `porder` 兼容保留，选填补充项继续留空不传，不伪造品牌/行业/商单。它与新声明分开，不用它确认播放页标注。未勾选不发这两个字段，不擅自选择其他内容类别。
- 投稿成功后，追加一次只读 `archiveDetail` 查询，按 BV（仅有 aid 时按 aid）核对稿件身份。只读取有效的 `creation_statement.id` 或兼容 `creation_statement_id`，不凭 `porder` 或旧 `neutral_mark` 文本报已确认。
- 返回独立 `declarationVerification`：`confirmed` 表示平台资料返回 ID 3；`mismatch` 表示返回了其他 ID；`unverified` 表示字段缺失、查询失败或回读能力缺失。确认仅限平台资料，不声称观众端显示、转码/审核完成或人工验收。
- 回读失败/不符仍保留 `ok=true, outcome=submitted` 的收稿事实和 BV，不去掉声明重发、不自动编辑；把问题作为独立提醒显示。持久防重复保护继续阻断相同成片重发。
- 投稿事务在上传前保存 `declaration.requested` 快照，结束时保存回读状态/实际 ID/时间；不存 cookie、完整请求或正文。旧记录不迁移、不补签。
- 预览回传 `promotionProtocolVersion: 2`。新网页面对只支持旧 `porder` 的后端会要求空闲后安全重启，不能把 `promotionSupported: true` 当新标注能力。
- 网页收稿提示区分声明状态；后续通用稿件列表查询不覆盖声明警告。桌面结果与排程最近提交信息同样显示回读结果。

## 验证边界

新增测试覆盖：准确 payload、规范化与选填、真实请求序列的模拟、身份核对、两种回填格式、错误/空/不符回读、保留收稿与防重复、预写声明快照、旧后端识别、网页三种结果及后续 BV 核对不覆盖警告。

所有 POST/上传测试使用假凭据、假素材及模拟平台；本次真实访问仅限只读查询。修复后尚未真实投稿，因此**没有“已在真实新稿件落库/观众端显示”的验证结论**。后续用户明确投稿时才会实际执行新提交格式与回读。已发布视频、已有项目保存资料、历史日志和用户服务状态均未修改。

验证结果：相关发布/工作台回归共 248 项通过；15 个修改/新增 JavaScript 模块语法检查通过。已实际查看 `diagnostics/publish-marketing/` 中桌面确认/不符及手机未确认截图；这些截图使用模拟平台数据，不是 B 站真实落库证据。

最后使用新增 `archiveDetail` 客户端（请求适配器禁止非 GET）再次只读查询上述两个真实 BV，均正确解析为 ID -1 / `mismatch`，没有将收稿或旧字段误报为营销标注已确认。检查到 8144 已有工作台进程，本轮未启动、重启或关闭它；进程需在空闲时重启才能加载修改后的后端。
