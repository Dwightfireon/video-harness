# 从会动的页面，到可观察的镜头

## 判断标准

先让观众认出对象，再看条件改变后它怎样变化；连续演进保留同一对象的位置、编号或颜色参照，不把换卡片当作变化。
旁白解释变化与依据，不反复读标题。曲线近旁直接标注名称、单位与必要条件，减少往返图例；示意曲线明说非实测，不补造数据。

优先已有 SVG、transform / opacity 与 `VH_FILM.sceneCue` 表达内容关系；不为润色增加重型 FX / 3D、默认素材搜索或降低画质。真实界面、照片、机制图与数据图各按内容构图，不套同一题材皮肤。
留白与静止可用于聚焦和阅读，不设动作、曲线或例子配额；本节是写作与构图指导，不新增制作、审核或付费模型调用阶段。

## 最小技术用法

新项目 `vh new` 自动带 `window.VH_FILM`；旧项目显式运行 `vh enhance --film`，会先备份模板。
不更新 skill 本体，不覆盖旧场景。随后 `vh build` 正常生成。

```js
const F = window.VH_FILM;
// 必须在当前场景中选句；跨场相同句子会被视为歧义，而非偷偷匹配第一句。
const localSubs = SUBS.filter(s => s.s >= sceneStart && s.s < sceneEnd);
const at = F.cue(localSubs, '这时观察开口边角') - sceneStart;
const keys = [
  {t: 0, x: 960, y: 540, scale: 1},
  {t: at, x: 960, y: 540, scale: 1},
  {t: at + 2, x: 1200, y: 400, scale: 2.5},
];
// render(rt) 内，world 为 SVG g；HUD 与字幕不要放进 world。
const camera = F.cameraAt(keys, rt);
F.applyCamera(world, camera, window.W, window.H);
const point = F.projectPoint({x:1200,y:400}, camera, window.W, window.H);
F.trace(crackPath, F.phase(rt, at + 2, at + 5));
```

`cue` 默认返回开始时间，可用 `cue(subs, text, 'e', offset)` 取结束时间。
空匹配、重复匹配、非法镜头均报错。镜头插值到位后保持；`cut:true` 表示在该关键帧直切。
以上只是镜头语法，不是物理仿真，也不替作者安排题材。

### 普通入场动画也用字幕锚点

```js
const F = window.VH_FILM;
const revealAt = F.sceneCue(root, '现在看这条记录'); // 已是场内秒，不再减起点
const resultAt = F.sceneCue(root, 3, { edge: 'e', offset: -.2 });
// render(t) 内：
enter(recordEl, t, revealAt, { dy: 12, blur: 3, dur: .5 });
resultEl.style.opacity = t >= resultAt ? 1 : 0;
```

数字选择器从本场第 1 句起数，改句序后须检查含义；优先唯一文本，避免动作指错对象。
每次构建/配音重测都从当前字幕重新取时间；跨场同一句不造成误配，本场歧义、缺句、偏移越界则明确报错。
`compileMotion` 的动作也可写 `cue: { line: 3 }`，与 `text` 二选一。锚点是句级，不是词级强制对齐。

## 字幕锚定动作编排（2026-10-23）

新项目自带 `compileMotion` 与 `fitCamera`。已有 FILM 的旧工程须显式执行
`vh enhance --film --force --dir <项目>`，备份升级标准注入块后再 build；未知自定义块拒绝覆盖。

先写清“谁发生了什么变化”，再指定时间。不要为了动起来给整页持续漂移。
例如：同一个文件保留编号和位置参照，被修改后才进入传输，抵达后才显示完成；传输途中不得提前记作已收到。

```js
// 标准生成器经 vh build 后，从 root 读取当前边界；重测后不手抄旧起点。
const F = window.VH_FILM;
const plan = F.compileMotion({
  subs: SUBS, ...F.sceneTiming(root),
  targets: {
    file: { x: 0, y: 0, opacity: 0 },
    path: { progress: 0 }
  },
  beats: [
    { id: 'reveal', target: 'file', cue: { text: '这里有三份文件' },
      dur: .7, hold: 1, to: { opacity: 1 } },
    { id: 'send', target: 'file', cue: { text: '只发送发生改动的那一份' },
      dur: 1.4, hold: 1, to: { x: 360 } },
    { id: 'route', target: 'path', cue: { text: '只发送发生改动的那一份' },
      dur: 1.4, to: { progress: 1 } }
  ]
});
// render(rt) 内，每帧写完整状态，不把变换累加到上一帧。
const { file, path } = plan.sample(rt).targets;
fileEl.style.opacity = file.opacity;
fileEl.style.transform = `translate(${file.x}px, ${file.y}px)`;
F.trace(routeEl, path.progress);
```

- `cue` 在本场字幕中唯一匹配，默认句首；可用 `{text, edge:'e', offset:.1}` 选择句尾与有限偏移。它是**句级锚点，不是词级强制对齐**。
- `sceneTiming(root)` 读取标准生成出口在 builder 执行前登记的边界。自定义生成器不匹配时会明确报缺失；可显式传入当前时间轴的 `start/end`，不能把缺失值猜成0。
- `at` 是场内秒，不能与 `cue` 同时指定。句子缺失、歧义、非法状态、同属性动作/保持重叠、时间越界均报错；不得吞错退回 0 秒。
- 状态支持 `x/y`（像素）、`scale`（正数倍率）、`rotate`（角度）、`opacity/progress`（0–1）。其它 CSS 不自动推断，数据真值也不从装饰进度猜。
- `hold` 保护**本动作涉及的属性**不被后一个动作抢占，不代表全场所有对象禁止变化。未指定动作的时段保持当前状态。
- `plan.beats` 给出编译后的 `at/end/dur/hold/from/to`，可用于动作清单；`sample(rt)` 是纯时间采样，直达、倒播与乱序取值一致。
- 编译、冲突判定与采样使用同一 1ns 时间网格，避免 `0.1 + 0.2` 造成末帧切换永远触发不了；这只是数值精度，不代表旁白已经有纳秒或词级对齐。
- 缓动为单调五次平滑曲线，起止速度、加速度归零；结尾写精确终值。默认不使用弹簧超调，不让阅读面长尾漂移。
- 显示计数/成功标志要以实际到达事件为准，不能仅因动画开始就显示完成。此模块负责动画时序约束，**不验证作者声称的业务事实**。

### 镜头准确落在安全区

```js
const closeup = F.fitCamera(
  { x: 900, y: 240, width: 480, height: 320 }, // 世界中主体的真实范围
  { width: W, height: H, padding: 48,
    insets: { top: 100, bottom: subtitleBand }, maxScale: 2.5, minScale: .5 }
);
// closeup 可放进 cameraAt 的关键帧；标注继续用 projectPoint 投影。
```

主体四角会落在指定安全区内；装不下时明确报错，不偷偷裁掉主体。此保证针对该取景落点，
不等于运动全过程无碰撞、正文一定够大或改幅后不必重排。字幕/标题保持在镜头外，不能随细节镜头放大。

可运行的同内容 before/after 对照见 `demo/motion-polish-20261023/index.html`；
用 `node scripts/build-motion-study.mjs` 内联当前运行时重建。它是机制示意、无旁白，不是已经审过的用户成片。

`vh motion` 对尚未展开的 `compileMotion` 场景显示“未解析”，不把它算成零动作或整场静止；
源代码里存在编排调用也不能替代实际构建、查看动作清单与连续审阅。

## 本轮样片

- 作者输入：`projects/comet/visual-study/`
- 重建：`node projects/comet/visual-study/build.mjs --render`
- 输出：`projects/comet/out/art-direction/pilot.mp4`
- 两版方向：`style-dark.jpg` / `style-paper.jpg`
- `runtime-review.json`：跳播确定性、采样状态、SVG 文字边界。不是审美评分，也不是逐帧碰撞检测。

脚本一般机制示意，不使用原主片存疑的历史推论。模型是原创 SVG 的伪空间剖面，
不是三维有限元或真实机型建模；横屏 1080p 已测，竖屏未适配。

## 审阅

1. 同内容两方向：主要对象、文字量、字幕与镜头必须相同。
2. 看过程：起点、变化前后、落点，以及关键转场。
3. 标注避开细节，跟随物体；图表有独立阅读面。
4. 证据来源和使用权分开查，研究参考图不自动进成片。
5. 对实际编码后的 MP4 解码取帧复核；有音轨不等于听过，没有试听就写未试听。
6. 样片通过不代表整片完成，更不代表脚本史实通过。
