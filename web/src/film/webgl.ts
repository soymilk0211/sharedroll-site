/**
 * 濾鏡的 WebGL2 渲染器:App `render.ts` 的排程,一趟一趟在離屏貼圖上跑。
 *
 * 1. 空間階段(清晰度、紅暈)在 1080 寬的工作尺寸上算;照片比 1080 寬時,先一路對半縮下來
 *    (每一階都是線性取樣的四點平均),不在著色器裡點取樣。
 * 2. 最後一趟 `FINISH_FS` 在全尺寸上把十一個階段收完。
 *
 * 中間圖一律 RGBA8:App 的離屏畫布也是 8 位元,每一趟的捨入兩邊才對得起來。
 *
 * 這支只在瀏覽器跑(要 WebGL2),所以沒有單元測試;它的驗收是 golden 比對
 * (`web/scripts/golden.mjs`,真的開 headless Chrome)。
 */

import { LUT_SIZE, bakeLutPixels } from './curves';
import { GRAIN_TILE_SIZE, bakeGrainPixels, grainOffsetForSeed } from './grain';
import type { FilmFilterKey, FilmFilterRecipe } from './recipes';
import { recipeFor } from './recipes';
import {
  BLUR_FS,
  FINISH_FS,
  GRADE_FS,
  HIGHLIGHT_MASK_FS,
  LOCAL_CONTRAST_FS,
  PRESENT_FS,
  RING_FS,
  SCALE_FS,
  VERTEX_SHADER,
} from './shaders';
import {
  BLUR_SIGMA_PER_RADIUS,
  CLARITY_RADIUS,
  HALATION_CORE_BLUR_RATIO,
  finishUniforms,
  gradeUniforms,
  halationOf,
  highlightMaskUniforms,
  ringUniforms,
  scaledRadius,
  workingSizeFor,
  type RenderSize,
  type Uniforms,
} from './uniforms';

/** 一張離屏貼圖。 */
export interface FilmTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
  samplers: string[];
}

/** 從來源取哪一塊(裁切),以像素為單位。 */
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class FilmRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly programs: Record<
    'grade' | 'mask' | 'local' | 'ring' | 'blur' | 'scale' | 'present' | 'finish',
    Program
  >;
  private readonly noise: FilmTexture;
  private readonly luts = new Map<FilmFilterKey, FilmTexture>();
  private readonly live = new Set<FilmTexture>();
  readonly maxTextureSize: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('開不出 framebuffer');
    this.framebuffer = framebuffer;

    // 一個蓋滿畫面的大三角形。
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.programs = {
      grade: this.compile(GRADE_FS, '調色'),
      mask: this.compile(HIGHLIGHT_MASK_FS, '亮部遮罩'),
      local: this.compile(LOCAL_CONTRAST_FS, '局部對比'),
      ring: this.compile(RING_FS, '紅暈'),
      blur: this.compile(BLUR_FS, '模糊'),
      scale: this.compile(SCALE_FS, '縮放'),
      present: this.compile(PRESENT_FS, '顯示'),
      finish: this.compile(FINISH_FS, '收尾'),
    };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.noise = this.fromPixels(
      bakeGrainPixels(),
      GRAIN_TILE_SIZE,
      GRAIN_TILE_SIZE,
      gl.NEAREST,
      false,
    );
  }

  private compile(fragmentSource: string, name: string): Program {
    const gl = this.gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error(`${name}:開不出著色器`);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`${name} 的著色器編譯不過:${gl.getShaderInfoLog(s) ?? ''}`);
      }
      return s;
    };
    const program = gl.createProgram();
    if (!program) throw new Error(`${name}:開不出程式`);
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`${name} 連結不過:${gl.getProgramInfoLog(program) ?? ''}`);
    }
    const uniforms = new Map<string, WebGLUniformLocation>();
    const samplers: string[] = [];
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i += 1) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (location) uniforms.set(info.name, location);
      if (info.type === gl.SAMPLER_2D) samplers.push(info.name);
    }
    return { program, uniforms, samplers };
  }

  private allocate(width: number, height: number, filter: number): FilmTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error(`開不出 ${width}x${height} 的貼圖`);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const result = { texture, width, height };
    this.live.add(result);
    return result;
  }

  private fromPixels(
    pixels: Uint8Array,
    width: number,
    height: number,
    filter: number,
    track = true,
  ): FilmTexture {
    const gl = this.gl;
    const result = this.allocate(width, height, filter);
    if (!track) this.live.delete(result);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return result;
  }

  /**
   * 把一張圖(相機的一格、或解碼好的 PNG)放上 GPU。
   *
   * `colorConversion` 為 false 時不讓瀏覽器做色彩空間轉換——golden 比對要拿檔案裡的原始數字。
   * 相機畫面則交給瀏覽器轉成 sRGB(與 App 離屏畫布明講 sRGB 同一個立場)。
   */
  upload(
    source: TexImageSource,
    width: number,
    height: number,
    colorConversion = true,
  ): FilmTexture {
    const gl = this.gl;
    const result = this.allocate(width, height, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      colorConversion ? gl.BROWSER_DEFAULT_WEBGL : gl.NONE,
    );
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return result;
  }

  /**
   * 取景框用:把新的一格寫進同一張貼圖(尺寸沒變就 `texSubImage2D`),不必每格都配一張全解析度
   * 的新貼圖再刪掉。尺寸變了(轉了方向)才換一張。
   */
  uploadInto(
    previous: FilmTexture | null,
    source: TexImageSource,
    width: number,
    height: number,
  ): FilmTexture {
    if (!previous || previous.width !== width || previous.height !== height) {
      if (previous) this.release(previous);
      return this.upload(source, width, height);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, previous.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return previous;
  }

  /** GPU context 被系統收回了(切到背景、記憶體不夠)。收回之後這個 renderer 不能再用。 */
  isLost(): boolean {
    return this.gl.isContextLost();
  }

  /** 用完的貼圖還回去。快取(查表、雜訊)不歸這裡。 */
  release(texture: FilmTexture): void {
    if (this.live.delete(texture)) {
      this.gl.deleteTexture(texture.texture);
    }
  }

  private lutFor(recipe: FilmFilterRecipe): FilmTexture {
    const cached = this.luts.get(recipe.key);
    if (cached) return cached;
    const lut = this.fromPixels(bakeLutPixels(recipe.curves), LUT_SIZE, 1, this.gl.LINEAR, false);
    this.luts.set(recipe.key, lut);
    return lut;
  }

  /** 跑一支程式到一張新的貼圖(或 `target` 為 null 時畫到螢幕)。 */
  private run(
    program: Program,
    size: RenderSize,
    textures: Record<string, FilmTexture>,
    values: Uniforms,
    target: 'texture' | 'screen' = 'texture',
  ): FilmTexture | null {
    const gl = this.gl;
    let output: FilmTexture | null = null;
    if (target === 'texture') {
      output = this.allocate(size.width, size.height, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        size.width,
        size.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        output.texture,
        0,
      );
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, size.width, size.height);
    gl.useProgram(program.program);
    program.samplers.forEach((name, unit) => {
      const texture = textures[name];
      if (!texture) throw new Error(`著色器少了貼圖:${name}`);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture.texture);
      gl.uniform1i(program.uniforms.get(name) ?? null, unit);
    });
    for (const [name, value] of Object.entries(values)) {
      const location = program.uniforms.get(name);
      // 編譯器會把用不到的 uniform 拿掉(例如沒有紅暈的那一支),那不是錯。
      if (!location) continue;
      if (value.length === 1) gl.uniform1f(location, value[0]);
      else if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
      else if (value.length === 4) gl.uniform4f(location, value[0], value[1], value[2], value[3]);
      else throw new Error(`uniform ${name} 的長度不對:${value.length}`);
    }
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return output;
  }

  private size(texture: FilmTexture): number[] {
    return [texture.width, texture.height];
  }

  /** 取來源的一塊,線性取樣到指定大小。裁切與等比縮放都走這裡。 */
  crop(source: FilmTexture, rect: SourceRect, size: RenderSize): FilmTexture {
    return this.run(
      this.programs.scale,
      size,
      { image: source },
      {
        imageSize: this.size(source),
        sourceRect: [rect.x, rect.y, rect.width, rect.height],
        targetSize: [size.width, size.height],
      },
    ) as FilmTexture;
  }

  private scale(source: FilmTexture, width: number): FilmTexture {
    const height = Math.max(1, Math.round((source.height * width) / source.width));
    return this.crop(
      source,
      { x: 0, y: 0, width: source.width, height: source.height },
      { width, height },
    );
  }

  /** 一路對半縮到這個寬度(App `downscaleTo`)。回傳新的一張,輸入不動。 */
  downscale(source: FilmTexture, width: number): FilmTexture {
    let current = source;
    const steps: FilmTexture[] = [];
    while (current.width > width * 2) {
      current = this.scale(current, Math.max(width, Math.round(current.width / 2)));
      steps.push(current);
    }
    const finished = current.width === width ? current : this.scale(current, width);
    for (const step of steps) {
      if (step !== finished) this.release(step);
    }
    return finished === source ? this.scale(source, width) : finished;
  }

  private blur(source: FilmTexture, radius: number): FilmTexture {
    const sigma = radius * BLUR_SIGMA_PER_RADIUS;
    const size = { width: source.width, height: source.height };
    const horizontal = this.run(
      this.programs.blur,
      size,
      { image: source },
      {
        imageSize: this.size(source),
        direction: [1, 0],
        sigma: [sigma],
      },
    ) as FilmTexture;
    const vertical = this.run(
      this.programs.blur,
      size,
      { image: horizontal },
      {
        imageSize: this.size(source),
        direction: [0, 1],
        sigma: [sigma],
      },
    ) as FilmTexture;
    this.release(horizontal);
    return vertical;
  }

  private halationRing(
    recipe: FilmFilterRecipe,
    source: FilmTexture,
    scratch: FilmTexture[],
  ): FilmTexture {
    const halation = halationOf(recipe);
    const working = { width: source.width, height: source.height };
    const imageSize = this.size(source);
    const keep = (texture: FilmTexture) => {
      scratch.push(texture);
      return texture;
    };
    const mask = keep(
      this.run(
        this.programs.mask,
        working,
        { image: source },
        {
          imageSize,
          ...highlightMaskUniforms(recipe),
        },
      ) as FilmTexture,
    );
    const surroundings = keep(
      this.blur(mask, scaledRadius(halation.localityRadiusPx, working.width)),
    );
    const local = keep(
      this.run(this.programs.local, working, { mask, surroundings }, { imageSize }) as FilmTexture,
    );
    const radius = scaledRadius(halation.blurRadiusPx, working.width);
    const spread = keep(this.blur(local, radius));
    const core = keep(this.blur(local, Math.max(1, Math.round(radius * HALATION_CORE_BLUR_RATIO))));
    return this.run(
      this.programs.ring,
      working,
      { spread, core },
      {
        imageSize,
        ...ringUniforms(recipe),
      },
    ) as FilmTexture;
  }

  /**
   * 套一款濾鏡,回傳新的一張(全尺寸)。輸入不動。
   *
   * 網頁拿不到 ISO 與閃光燈:顆粒用配方的基礎密度(`iso: null`,App 讀不到 ISO 時同一條路),
   * 閃光燈遮罩不套。`iso` 只給 golden 比對用(golden 圖是 ISO 400 燒的)。
   */
  render(
    source: FilmTexture,
    filter: FilmFilterKey,
    seed: number,
    iso: number | null = null,
  ): FilmTexture {
    const recipe = recipeFor(filter);
    const size = { width: source.width, height: source.height };
    const working = workingSizeFor(size);
    const scratch: FilmTexture[] = [];
    try {
      const lut = this.lutFor(recipe);
      const spatial = recipe.clarityPercent !== 0 || recipe.halation !== null;
      let small = source;
      if (spatial && working.width < size.width) {
        small = this.downscale(source, working.width);
        scratch.push(small);
      }
      let clarityBlur = source;
      if (recipe.clarityPercent !== 0) {
        const gradedSmall = this.run(
          this.programs.grade,
          working,
          { image: small, lut },
          {
            imageSize: this.size(small),
            ...gradeUniforms(recipe),
          },
        ) as FilmTexture;
        scratch.push(gradedSmall);
        clarityBlur = this.blur(gradedSmall, scaledRadius(CLARITY_RADIUS, working.width));
        scratch.push(clarityBlur);
      }
      let ring = this.noise;
      if (recipe.halation) {
        ring = this.halationRing(recipe, small, scratch);
        scratch.push(ring);
      }
      return this.run(
        this.programs.finish,
        size,
        { image: source, lut, clarityBlur, ring, noise: this.noise },
        {
          imageSize: [size.width, size.height],
          helperSize: [working.width, working.height],
          ...finishUniforms(recipe, size, working, {
            iso,
            flash: false,
            grainOffset: grainOffsetForSeed(seed),
          }),
        },
      ) as FilmTexture;
    } finally {
      for (const texture of scratch) this.release(texture);
    }
  }

  /** 讀回 RGBA 位元組,第 0 列是最上面那一列。 */
  read(texture: FilmTexture): Uint8ClampedArray<ArrayBuffer> {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture.texture,
      0,
    );
    const pixels = new Uint8ClampedArray(texture.width * texture.height * 4);
    gl.readPixels(0, 0, texture.width, texture.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  /** 畫到畫布上(預覽)。畫布的大小要先設成與貼圖相同。 */
  present(texture: FilmTexture): void {
    this.run(
      this.programs.present,
      { width: texture.width, height: texture.height },
      { image: texture },
      { targetSize: [texture.width, texture.height] },
      'screen',
    );
  }
}

/** 開一個給濾鏡用的 WebGL2 環境。不支援 WebGL2 回 null。 */
export function createFilmRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): FilmRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) return null;
  return new FilmRenderer(gl);
}
