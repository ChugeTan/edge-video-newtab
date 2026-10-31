/* =========================================================================
 * 液态玻璃搜索框 · WebGL 实时渲染（精细版）
 * 直接把背景视频作为纹理，用片元着色器实时计算：
 *   - 圆角玻璃边缘的倒角透镜折射（分层剖面 + 轻微放大）
 *   - 边缘色散（R/B 通道按折射方向错位，强度可调）
 *   - 磨砂（多重采样模糊，边缘更清晰、中心更雾）
 *   - 按法线方向的高光、内倒角阴影、亮度/饱和度/暗化/tint
 * 只渲染搜索框这一小块画布（约 660x56 CSS px），开销很小。
 * ========================================================================= */
(() => {
  'use strict';

  const VERT = `
    attribute vec2 aPos;
    void main() {
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;

    uniform sampler2D uVideo;
    uniform vec2 uCanvasPx;      // 画布内部像素尺寸
    uniform float uDpr;
    uniform vec2 uBoxOrigin;     // 搜索框左上角（CSS px，视口坐标）
    uniform vec2 uViewport;      // 视口 CSS 尺寸
    uniform vec2 uVideoSize;     // 视频固有尺寸
    uniform float uVideoScale;   // 视频 CSS transform: scale
    uniform int uFit;            // 0=cover 1=contain 2=fill
    uniform float uBlur;         // 磨砂半径（CSS px）
    uniform float uTint;         // 玻璃底色不透明度 0..0.2
    uniform float uRefract;      // 边缘折射位移（CSS px）
    uniform float uBrightness;   // 背景亮度
    uniform float uDim;          // 暗化遮罩 0..0.8
    uniform float uSat;          // 饱和度
    uniform float uEdgeWidth;    // 镜片厚度（折射环带宽度，CSS px）
    uniform float uDispersion;   // 色散强度 0..0.12
    uniform float uRadius;       // 圆角半径（0 = 自动取高度一半，即胶囊形）

    vec2 screenToVideoUV(vec2 screenPos) {
      vec2 disp;
      if (uFit == 2) {
        disp = uViewport;
      } else if (uFit == 1) {
        float s = min(uViewport.x / uVideoSize.x, uViewport.y / uVideoSize.y);
        disp = uVideoSize * s;
      } else {
        float s = max(uViewport.x / uVideoSize.x, uViewport.y / uVideoSize.y);
        disp = uVideoSize * s;
      }
      disp *= uVideoScale;
      vec2 off = (uViewport - disp) * 0.5;
      return (screenPos - off) / disp;
    }

    vec3 sampleVideo(vec2 screenPos) {
      vec2 uv = screenToVideoUV(screenPos);
      uv = clamp(uv, vec2(0.0), vec2(1.0));
      return texture2D(uVideo, uv).rgb;
    }

    float sdPill(vec2 p, vec2 halfSize, float r) {
      vec2 q = abs(p) - halfSize + r;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }

    vec3 blurSample(vec2 screenPos, float radius) {
      if (radius < 0.6) return sampleVideo(screenPos);
      vec3 acc = sampleVideo(screenPos);
      float weight = 1.0;
      for (int i = 0; i < 9; i++) {
        float fi = float(i) + 0.5;
        float ang = fi * 2.39996323;
        float r = sqrt(fi / 9.0) * radius;
        vec2 off = vec2(cos(ang), sin(ang)) * r;
        acc += sampleVideo(screenPos + off);
        weight += 1.0;
      }
      return acc / weight;
    }

    void main() {
      vec2 canvasCss = uCanvasPx / uDpr;
      vec2 local = vec2(gl_FragCoord.x / uDpr, canvasCss.y - gl_FragCoord.y / uDpr);
      vec2 halfSize = canvasCss * 0.5;
      vec2 p = local - halfSize;
      float corner = min(halfSize.x, halfSize.y);
      if (uRadius > 0.5) {
        corner = min(uRadius, min(halfSize.x, halfSize.y));
      }

      float sd = sdPill(p, halfSize, corner);
      float inside = -sd;

      // 圆角矩形外法线（中心差分）
      vec2 e = vec2(0.75, 0.0);
      float gx = sdPill(p + e.xy, halfSize, corner) - sdPill(p - e.xy, halfSize, corner);
      float gy = sdPill(p + e.yx, halfSize, corner) - sdPill(p - e.yx, halfSize, corner);
      vec2 n = normalize(vec2(gx, gy) + vec2(0.0001));

      // ===== 边缘倒角透镜：外层陡、内层柔和，并带轻微放大 =====
      float ew = max(4.0, min(uEdgeWidth, halfSize.y * 0.9));
      float t = clamp(inside / ew, 0.0, 1.0);       // 0 = 玻璃边缘，1 = 环带内沿
      float bevel = pow(1.0 - t, 1.65);              // 折射强度剖面
      vec2 dirIn = -n;                               // 指向玻璃内部

      vec2 samplePos = local + dirIn * (uRefract * bevel);
      // 轻微透镜放大：越靠边缘，背景被向外拉伸一点
      vec2 rel = samplePos - halfSize;
      samplePos = halfSize + rel * (1.0 - 0.05 * bevel);

      // ===== 磨砂：边缘更清晰、中心更雾 =====
      float blurAmt = uBlur * mix(0.10, 1.0, smoothstep(0.0, ew * 2.4, inside));
      blurAmt = max(blurAmt, 0.6);
      vec2 fragScreen = uBoxOrigin + samplePos;
      vec3 col = blurSample(fragScreen, blurAmt);

      // ===== 色散：R/B 通道在边缘按折射方向错位 =====
      float dispersion = uDispersion * bevel;
      if (dispersion > 0.002) {
        vec2 chroma = dirIn * (uRefract * dispersion);
        vec3 cR = sampleVideo(fragScreen - chroma);
        vec3 cB = sampleVideo(fragScreen + chroma);
        col.r = mix(col.r, cR.r, 0.75 * bevel);
        col.b = mix(col.b, cB.b, 0.75 * bevel);
      }

      // ===== 颜色处理（与页面视频层保持一致） =====
      col *= uBrightness;
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, uSat);
      col = mix(col, vec3(0.008, 0.016, 0.04), uDim);
      col = mix(col, vec3(0.055, 0.071, 0.11), uTint);

      // ===== 玻璃高光与倒角阴影（按法线方向给主光） =====
      float rim = smoothstep(1.8, 0.0, inside);
      float bevelShade = smoothstep(0.0, 5.0, inside) * smoothstep(13.0, 5.0, inside);
      vec3 lightDir = normalize(vec3(-0.35, 0.85, 0.55));
      vec3 n3 = normalize(vec3(n * (0.9 + 0.5 * clamp(1.0 - t, 0.0, 1.0)), 0.65));
      float spec = pow(clamp(dot(n3, lightDir), 0.0, 1.0), 6.0);
      col += vec3(0.75, 0.82, 0.98) * rim * (0.10 + 0.28 * spec);
      col *= 1.0 - 0.16 * bevelShade;

      // 上亮下暗的整体明暗
      float v = local.y / max(canvasCss.y, 1.0);
      col *= 1.0 - 0.06 * smoothstep(0.55, 1.0, v);
      col += vec3(0.02, 0.024, 0.03) * (1.0 - smoothstep(0.0, 0.4, v));

      // 外轮廓 1px 抗锯齿（画布本身还会被 CSS 圆角裁切）
      float alpha = smoothstep(-0.75, 0.75, inside);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), alpha);
    }
  `;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('shader compile failed: ' + log);
    }
    return shader;
  }

  const shared = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    lastTime: -1,
    lastVideo: null,
  };

  function getSharedFrame(video) {
    const maxW = 960;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, maxW / vw);
    const sw = Math.max(2, Math.round(vw * scale));
    const sh = Math.max(2, Math.round(vh / vw * sw));
    if (!shared.canvas) {
      shared.canvas = document.createElement('canvas');
      shared.ctx = shared.canvas.getContext('2d', { alpha: false });
    }
    const changed = video.currentTime !== shared.lastTime
      || video !== shared.lastVideo
      || shared.canvas.width !== sw
      || shared.canvas.height !== sh;
    if (changed) {
      if (shared.canvas.width !== sw || shared.canvas.height !== sh) {
        shared.canvas.width = sw;
        shared.canvas.height = sh;
      }
      shared.ctx.drawImage(video, 0, 0, sw, sh);
      shared.lastTime = video.currentTime;
      shared.lastVideo = video;
    }
    shared.width = sw;
    shared.height = sh;
    return shared;
  }

  function create(canvas, video, options = {}) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) || canvas.getContext('experimental-webgl');
    } catch (err) {
      gl = null;
    }
    if (!gl) return null;

    let program;
    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('program link failed: ' + gl.getProgramInfoLog(program));
      }
    } catch (err) {
      try { gl.getExtension('WEBGL_lose_context').loseContext(); } catch (e) { /* ignore */ }
      return null;
    }

    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const u = (name) => gl.getUniformLocation(program, name);
    const uniforms = {
      uVideo: u('uVideo'),
      uCanvasPx: u('uCanvasPx'),
      uDpr: u('uDpr'),
      uBoxOrigin: u('uBoxOrigin'),
      uViewport: u('uViewport'),
      uVideoSize: u('uVideoSize'),
      uVideoScale: u('uVideoScale'),
      uFit: u('uFit'),
      uBlur: u('uBlur'),
      uTint: u('uTint'),
      uRefract: u('uRefract'),
      uBrightness: u('uBrightness'),
      uDim: u('uDim'),
      uSat: u('uSat'),
      uEdgeWidth: u('uEdgeWidth'),
      uDispersion: u('uDispersion'),
      uRadius: u('uRadius'),
    };

    const state = {
      blur: 40,
      tint: 0.036,
      refract: 10,
      brightness: 1,
      dim: 0.25,
      fit: 'cover',
      videoScale: 1,
      sat: 1.8,
      edgeWidth: 15,
      dispersion: 0.04,
      radius: typeof options.radius === 'number' ? options.radius : 0,
      videoSize: null,
    };

    let active = false;
    let running = false;
    let wanted = false;
    let rafId = 0;
    let pausedSkip = false;
    let lastFrame = 0;
    let textureReady = false;
    let box = { left: 0, top: 0, width: 0, height: 0 };
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    function updateActive(next) {
      if (next === active) return;
      active = next;
      if (typeof options.onActiveChange === 'function') {
        try { options.onActiveChange(active); } catch (e) { /* ignore */ }
      }
    }

    function measure() {
      const host = canvas.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(rect.width * dpr));
      const h = Math.max(2, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function fitToInt() {
      return state.fit === 'contain' ? 1 : state.fit === 'fill' ? 2 : 0;
    }

    function draw(now) {
      if (!running) return;
      rafId = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - lastFrame < 30) return; // 约 30fps
      lastFrame = now;

      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        updateActive(false);
        return;
      }

      // 视频暂停时不需要每帧上传/重绘（画布保留最后一帧）
      if (video.paused) {
        if (pausedSkip) return;
        pausedSkip = true;
      } else {
        pausedSkip = false;
      }

      measure();
      if (box.width < 4 || box.height < 6) {
        updateActive(false);
        return;
      }

      try {
        // 共享降采样帧（多块玻璃同帧只做一次 drawImage）
        const frame = getSharedFrame(video);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame.canvas);
        state.videoSize = { w: frame.width, h: frame.height };
        textureReady = true;
      } catch (err) {
        // 跨域视频会污染纹理，退回 CSS 玻璃
        textureReady = false;
        updateActive(false);
        return;
      }

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.uniform1i(uniforms.uVideo, 0);
      gl.uniform2f(uniforms.uCanvasPx, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uDpr, dpr);
      gl.uniform2f(uniforms.uBoxOrigin, box.left, box.top);
      gl.uniform2f(uniforms.uViewport, window.innerWidth, window.innerHeight);
      gl.uniform2f(uniforms.uVideoSize, state.videoSize ? state.videoSize.w : video.videoWidth, state.videoSize ? state.videoSize.h : video.videoHeight);
      gl.uniform1f(uniforms.uVideoScale, state.videoScale || 1);
      gl.uniform1i(uniforms.uFit, fitToInt());
      gl.uniform1f(uniforms.uBlur, state.blur);
      gl.uniform1f(uniforms.uTint, state.tint);
      gl.uniform1f(uniforms.uRefract, state.refract);
      gl.uniform1f(uniforms.uBrightness, state.brightness);
      gl.uniform1f(uniforms.uDim, state.dim);
      gl.uniform1f(uniforms.uSat, state.sat);
      gl.uniform1f(uniforms.uEdgeWidth, state.edgeWidth);
      gl.uniform1f(uniforms.uDispersion, state.dispersion);
      gl.uniform1f(uniforms.uRadius, state.radius);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      updateActive(textureReady);
    }

    function schedule() {
      if (wanted && !running) {
        running = true;
        lastFrame = 0;
        rafId = requestAnimationFrame(draw);
      }
    }

    function start() {
      wanted = true;
      measure();
      schedule();
    }

    function stop() {
      wanted = false;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      updateActive(false);
    }

    function onVisibilityChange() {
      if (document.hidden) {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
      } else {
        schedule();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return {
      get active() { return active; },
      get supported() { return true; },
      setState(next) {
        if (!next) return;
        if (typeof next.blur === 'number') state.blur = Math.max(0, next.blur);
        if (typeof next.tint === 'number') state.tint = Math.max(0, Math.min(0.2, next.tint));
        if (typeof next.refract === 'number') state.refract = Math.max(0, next.refract);
        if (typeof next.brightness === 'number') state.brightness = Math.max(0.2, Math.min(1.2, next.brightness));
        if (typeof next.dim === 'number') state.dim = Math.max(0, Math.min(0.8, next.dim));
        if (typeof next.sat === 'number') state.sat = Math.max(1, Math.min(2.2, next.sat));
        if (typeof next.videoScale === 'number') state.videoScale = Math.max(1, next.videoScale);
        if (typeof next.fit === 'string') state.fit = next.fit;
        if (typeof next.edgeWidth === 'number') state.edgeWidth = Math.max(4, Math.min(30, next.edgeWidth));
        if (typeof next.dispersion === 'number') state.dispersion = Math.max(0, Math.min(0.15, next.dispersion));
        if (typeof next.radius === 'number') state.radius = Math.max(0, next.radius);
      },
      start,
      stop,
      resize: measure,
      destroy() {
        stop();
        try { gl.deleteTexture(texture); } catch (e) { /* ignore */ }
        try { gl.deleteBuffer(buffer); } catch (e) { /* ignore */ }
        try { gl.getExtension('WEBGL_lose_context').loseContext(); } catch (e) { /* ignore */ }
      },
    };
  }

  window.LiquidGlass = { create };
})();