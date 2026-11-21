# 发布简介参考资料：修复与本轮边界

## 事故

`projects/把急诊判断交给 ChatGPT…` 的 `发布文案.md` 简介里没有参考链接。项目已由用户删除，证据来自当时的文件内容与日志。

判断依据：入队时 `materials/选题.md` 已带三个来源（Nature 页面、PMC 页面、Research Square DOI），但程序一个都没写进简介，也没有任何提示。

## 四个原因

1. **少读一个来源**：`lib/reference-sources.mjs` 只读 `claims.json`、`脚本.md`、`research/*.md|txt`。`materials/选题.md` 从未被读取。
2. **不认 DOI**：同一处只认 `http(s)`、裸域名、`arXiv:`。`doi:10.1038/…`、`10.21203/…`、`doi.org/…` 全部漏掉。
3. **两条路径各写一次**：`publish-refs.mjs` 写「参考资料（片中数字的出处）」，`reference-sources.mjs` 写「参考资料」，先后调用两次。来源分散时会写出两段参考；`claims` 那条还没有 2000 字上限，能直接把简介顶爆。
4. **空结果静默**：`autoAppendReferences` 用空 `catch` 包住，取不到来源时一句话都没有。用户只能看到"简介里没链接"。

## 改了什么

### 分层（依赖单向，无环）

| 模块 | 职责 | 允许依赖 |
|---|---|---|
| `lib/url-identity.mjs` | DOI/arXiv/裸域名归一、去重身份、机器接口判定 | 无 |
| `lib/reference-format.mjs` | 排版、2000 字上限、已出现链接、缺失来源 | `url-identity` |
| `lib/reference-write.mjs` | 唯一写盘入口，定位 `## 简介` 后追加 | `url-identity`、`reference-format` |
| `lib/publish-refs.mjs` | 只读 `claims.json`，不写盘、不认识别的来源 | `url-identity`、`reference-format` |
| `lib/reference-sources.mjs` | 四个来源收集、合并去重、编排写入 | 以上全部 |

`test/reference-boundaries.test.mjs` 守着三条：纯规则不碰磁盘、只有 `reference-write` 写发布文案、依赖不许反向。

### 行为

- `materials/选题.md`、`materials/原文.md` 的「检索来源」段作为第四个来源；只读这一段，不读正文里的其他链接。
- DOI 三种写法统一成 `https://doi.org/…`；同一篇的 DOI 与出版方页面按 DOI 尾段合并成一条，保留 DOI（稳定可解析），借用页面标题。
- 标题统一「参考资料」，一次只写一遍；已有参考段落时往里加，不另起同名标题。
- 守 2000 字上限：超限整条丢弃并报数，不截断链接，不动已有链接。
- `go`、`pack`、`refs` 结束都打印结果；零来源时说清四个来源都没有 URL/DOI。
- `go` 里把补链接挪到发布状态检查之前，打印的结论与实际文件一致。
- `publish-check`、`refs`、发布页 `references()` 都改用同一套收集器。

### 版本回执

程序补链接会改文案字节，原本显示「有手动修改」。现在补完按 `by: 'system'` 重新关联：状态回到 `current`，回执标记来源为程序，**不冒充人工核对**；`publishStatus` 的提示文案也据此区分。

## 没做

- 不联网核证链接可达性，不判断一条来源是否真的支撑某句话。
- 不解析 HTML `canonical` 或 JATS XML 里的 DOI——补上 `materials` 与 DOI 后本次事故已能覆盖，解析全文属于额外复杂度。
- 不补造期刊卷页之类没有 DOI/URL 的引用。
- 不改已有正文，不删用户手写的「本片依据」。

## 验证

- 回归：15 个相关测试文件 **197 项通过，0 失败**（含新增 5 个边界守卫与 12 个参考资料用例）。
- 手工验证：临时项目里同时放入 `脚本.md` 数字与来源、`materials/选题.md`（DOI + 出版方页面）、`research/资料.md`，`vh refs` 预览、`--append`、重复执行、`publish-check` 均符合预期；简介其他小节未变。
- 未用真实片子复验：该项目已被用户删除。

## 未解决

用 opencode 执行器写发布文案时，不会自动登记版本回执（`confirmPublishRevision` 只在本地执行器 `lib/agent.mjs` 的写入钩子里调用）。所以用 opencode 补文案后仍会显示「未关联」，需要手动点一次。这与本次链接问题无关，属于执行器结算层面，范围更大，未在本轮改动。
