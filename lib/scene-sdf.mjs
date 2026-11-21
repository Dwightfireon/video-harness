import fs from 'node:fs';
import path from 'node:path';

export const SDF_MODE = 'hybrid-sdf';
export const DOM_MODE = 'dom';
export const declaredVisualMode = config => config?.visualMode === SDF_MODE ? SDF_MODE : DOM_MODE;

export function projectVisualMode(project) {
  try { return declaredVisualMode(JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8'))); }
  catch { return DOM_MODE; }
}

export function initializeVisualMode(project, mode) {
  if (![SDF_MODE, DOM_MODE].includes(mode)) throw new Error('画面模式只能是 hybrid-sdf 或 dom');
  const config = path.join(project, 'PROJECT.json');
  const metadata = JSON.parse(fs.readFileSync(config, 'utf8'));
  if (mode === SDF_MODE) {
    const template = path.join(project, 'engine.tpl.html');
    if (!fs.readFileSync(template, 'utf8').includes('/* vh:sdf-v1 */')) fs.appendFileSync(template, SDF_SOURCE);
  }
  fs.writeFileSync(config, JSON.stringify({ ...metadata, visualMode: mode }, null, 2) + '\n');
}

export const sdfAuthoringNote = '本项目允许按场混合画面。正文只有需要用空间、物体或形态变化解释意思时，才选 WebGL2 / SDF；字幕、标注、图表和真实界面继续用 DOM/SVG。不强制 3D 场数。轻量 API 和例子见仓库 docs/sdf-scene-api.md；用现有时间轴，不自己跑时钟。';

function installSdf() {
  const vertex = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const preamble = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uBeat;
out vec4 outColor;
float sdSphere(vec3 p, float r) { return length(p)-r; }
float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p)-b;
  return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5+0.5*(b-a)/k,0.0,1.0);
  return mix(b,a,h)-k*h*(1.0-h);
}
`;
  const contexts = new Map(), active = new Set();
  let surface, gl, vertexShader;
  const errorFor = (root, detail) => {
    const start = root.getAttribute('data-vh-scene-start');
    return new Error('WebGL2 / SDF' + (start === null ? '' : `（场景起点 ${start}s）`) + '：' + detail);
  };
  function compile(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('无法创建着色器');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('着色器编译失败：' + (log || '无诊断信息'));
  }
  function program(fragment) {
    const shader = compile(gl.FRAGMENT_SHADER, preamble + fragment);
    const linked = gl.createProgram();
    if (!linked) { gl.deleteShader(shader); throw new Error('无法创建着色器程序'); }
    try {
      gl.attachShader(linked, vertexShader);
      gl.attachShader(linked, shader);
      gl.linkProgram(linked);
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) throw new Error('着色器链接失败：' + gl.getProgramInfoLog(linked));
      return { linked, resolution: gl.getUniformLocation(linked, 'uResolution'),
        time: gl.getUniformLocation(linked, 'uTime'), beat: gl.getUniformLocation(linked, 'uBeat') };
    } catch (error) {
      gl.deleteProgram(linked);
      throw error;
    } finally { gl.deleteShader(shader); }
  }
  function mount(root, { fragment } = {}) {
    if (!root || typeof fragment !== 'string' || !fragment.trim() || contexts.has(root)) {
      throw new Error('每场只能挂载一个 WebGL2 / SDF 画面，且必须提供片元着色器。');
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    root.prepend(canvas);
    contexts.set(root, canvas);
    let paint, shaderProgram;
    return function render(time, beat = [0, 0, 0, 0]) {
      try {
        if (!Number.isFinite(time) || beat.length !== 4 || !Array.from(beat).every(Number.isFinite)) {
          throw new Error('帧时间及四个 uBeat 分量必须为有限数');
        }
        if (!surface) {
          surface = document.createElement('canvas');
          surface.width = window.W; surface.height = window.H;
          gl = surface.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
        }
        if (!gl) throw new Error('当前浏览器无法创建 WebGL2 上下文');
        if (gl.isContextLost()) throw new Error('WebGL2 上下文已丢失，请重载预览或重新启动渲染');
        vertexShader ||= compile(gl.VERTEX_SHADER, vertex);
        shaderProgram ||= program(fragment);
        paint ||= canvas.getContext('2d', { alpha: false });
        if (!paint) throw new Error('无法创建场景合成画布');
        if (gl.drawingBufferWidth !== surface.width || gl.drawingBufferHeight !== surface.height) {
          throw new Error('WebGL2 无法按项目尺寸分配帧缓冲');
        }
        active.add(canvas);
        if (canvas.width !== surface.width || canvas.height !== surface.height) {
          canvas.width = surface.width; canvas.height = surface.height;
        }
        const { linked, resolution, time: clock, beat: motion } = shaderProgram;
        gl.viewport(0, 0, surface.width, surface.height);
        gl.useProgram(linked);
        gl.uniform2f(resolution, surface.width, surface.height);
        gl.uniform1f(clock, time);
        gl.uniform4f(motion, ...beat);
        // A shader's discard must never reveal pixels from another time/scene.
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw new Error('WebGL2 绘制失败或上下文已丢失');
        paint.drawImage(surface, 0, 0);
      } catch (error) { throw errorFor(root, error.message); }
    };
  }
  // The old engine may draw two fading scenes at once. Their local canvases
  // retain independent pixels while the single GPU context is reused.
  const wrap = draw => function (time) {
    active.clear();
    try { return draw.call(this, time); }
    finally {
      for (const canvas of contexts.values()) {
        if (!active.has(canvas) && (canvas.width !== 1 || canvas.height !== 1)) canvas.width = canvas.height = 1;
      }
    }
  };
  window.VH_SDF = Object.freeze({ mount, wrap });
}

export const SDF_SOURCE = '\n/* vh:sdf-v1 */\n(' + installSdf.toString() + ')();\n';
