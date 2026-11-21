# 按场混合画面：SDF 场景接口 v1

新项目默认允许混合。使用 `vh new <目录> --visual dom` 可关闭；旧工程不迁移。不用 WebGL 的场照常写，不会初始化 GPU。工作台预览和正式导出驱动同一个 `window.renderAt(t)`。

在 `scenes.src.js` 的某个场景 builder 内：

```js
root => {
  const at = VH_FILM.sceneCue(root, '此处换成全场唯一的触发句片段');
  const draw = VH_SDF.mount(root, { fragment: `
    float field(vec3 p) { return sdSphere(p, .65); }
    void main() {
      vec2 p = (gl_FragCoord.xy-.5*uResolution)/uResolution.y;
      vec3 origin = vec3(0,0,3), ray = normalize(vec3(p,-1.25));
      float travel = 0.0;
      vec3 color = vec3(.055,.073,.11);
      for (int i=0; i<64; ++i) {
        vec3 hit = origin+travel*ray;
        float d = field(hit);
        if (d < .001) {
          color = vec3(.18,.70,.57) * (.55 + .45*max(normalize(hit).y,0.));
          break;
        }
        travel += d;
        if (travel > 6.) break;
      }
      outColor = vec4(color,1.);
    }
  ` });
  return { render(t) { draw(t, [Math.max(0, Math.min(1, t-at)), 0, 0, 0]); } };
}
```

- `mount` 在场景背景处放画布，普通 DOM 叠字在上方；不要再叠一个不透明的 `bg(root)` 盖住它。字幕继续由引擎绘制。
- 片元源码只写函数与 `main()`；头部已经声明 WebGL2 版本、`uResolution`、场内秒 `uTime`、四个自定义动作值 `uBeat`、`outColor`，并提供 `sdSphere`、`sdBox`、`smin`。
- 传入实际场内秒，允许转场出现负秒；动作需要时自己钳制。不要使用墙钟、帧累积、网络和动态导入。可用一次装载的 shader，加多个句子锚点驱动阶段。
- 共用一个 GPU 上下文；转场时两个可见场各有独立的合成帧。无 WebGL2、编译失败或上下文丢失会拒绝画帧，不交付静默黑帧。项目模板保存运行层快照，按现有规则识别改动。
- 参考 [OpenMotion 试点场景](../projects/OpenMotion客观介绍/scenes.src.js) 的正文演示。SDF 适合需要看懂空间或形态变化的镜头，不强制每场使用。
