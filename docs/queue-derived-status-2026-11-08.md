# 队列重构：只记「想做哪些」，不记「做到哪一步」

2026-11-08。

## 原来错在哪

旧 `schedule.json` 保存执行状态：`pending / running / done / failed`。
但真正在跑的是项目里的任务，于是**同一件事有两个真相**：

```
schedule.json        → running
out/.vh-task.json    → completed
```

为了对齐，加了一整套同步代码：`claimItem` / `finishItem` / `linkItem` /
`reconcileWithProjects` / `reclaimStale` / `releaseStale`。每一条都是新出错点。

真实事故：一项卡在 `running`，队列被堵了 **143 分钟**。因为回收只看 3 小时租期，
而这期间「有任务在跑」的判断一直挡着派发。

## 现在只有一件事是队列的

**这个选题有没有被开过工。**

```jsonc
{ "id": "...", "topic": "...", "addedAt": 0, "project": "projects/xxx" }
//                 ↑ 为空 = 没开工      ↑ 有值 = 已开工
```

状态是**算出来的**，不存盘：

```js
deriveStatus(item, inspect)
// 没 project           → todo
// inspect 说 completed → done
// 说 starting/running  → running
// 说 failed            → failed
// 取消但成片齐了        → done
// 其余（含项目不见了）   → stopped
```

`inspect(project)` 由调用方注入：队列层不认识项目结构，只问一句「这个项目现在怎么样」。

## 删掉的代码

| 删掉 | 为什么 |
|---|---|
| `claimItem` / `finishItem` | 认领与结算只是维护状态副本 |
| `linkItem` | 改名为 `attachProject`，只记指针，不写状态 |
| `reconcileWithProjects` | 没有副本就不需要同步 |
| `reclaimStale` / `releaseStale` | 租期与僵尸回收都是副本带来的问题 |
| 队列项 `status` / `startedAt` / `finishedAt` / `error` / `runs` 快照 | 派生得出，不存 |

新增的派发判据只有两条：

```js
firstUnstarted(queue)          // 只取 project 为空的
dispatchedToday(queue)         // 只数 dispatchedAt
```

**已开工的不再自动重派。** 失败要不要重来是人决定的——自动重试会让同一支反复烧模型额度。

## 接口

```js
// 读写
readSchedule(root)                       // 兼容 v1，忽略旧 status 字段
writeSchedule(root, queue)
addTopic(root, topic)
attachProject(root, id, project)         // 开工时指向项目
removeItem(root, id)

// 派生
deriveStatus(item, inspect)
listWithStatus(root, inspect)            // 给界面，不写盘
firstUnstarted(queue)
dispatchedToday(queue, now)
```

## 界面

队列项现在显示**算出来的状态**：

```
[已完成] 本地大模型为什么突然好用了                      移除
[未开工] 为什么你的电脑装得下 70B 模型…      去做      移除
```

- `未开工`：没有项目。有「去做」按钮（填进上面新建框）
- `在进行`：项目任务在跑
- `已完成`：项目任务完成，或成片已产出
- `失败` / `停住了`：项目任务失败，或取消且成片不齐

从队列点「去做」建好项目后会 `attachProject`，之后状态跟着项目走，
**不需要回来手动勾完成**。

## 验证

`test/schedule.test.mjs` 17 项：加选题去重、旧文件兼容、开工只记指针、
派生状态各种情形、只派未开工项、每日计数、移除、`listWithStatus` 不写盘、
两个定时开关独立、时段/上限/间隔、保存不动队列内容。

全量 `node scripts/test.mjs`：**1611 项全通过**。

## 仍未做

定时发布只到判断层（`shouldPublish`），没有接执行。
`publish` 开关打开也不会真的发——接入需要单独一轮验证账号风控。
