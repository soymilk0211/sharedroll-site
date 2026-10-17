/**
 * App 濾鏡管線(SkSL,`shared-roll/src/film-filter/shader.ts`)的 WebGL2 移植。
 *
 * **座標約定與 App 相同:原點在左上、像素中心在 +0.5。** 這裡所有離屏貼圖的第 0 列都當成
 * 「最上面那一列」:上傳時不翻(`UNPACK_FLIP_Y` 關)、讀回時不翻,`gl_FragCoord.xy` 就與 SkSL
 * 的 `xy` 一模一樣。顆粒的格點與 `xy` 綁在一起,方向反了網頁拍的顆粒就與 App 對不起來。
 * 只有畫到螢幕上(預覽)那一趟要上下翻(`PRESENT_FS`)。
 *
 * 精度一律 highp,與 App「全部用 float」同一個理由。
 */

export const VERTEX_SHADER = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
`;

const GRADE_CHUNK = `
uniform sampler2D image;
uniform vec2 imageSize;
uniform sampler2D lut;

uniform float exposureGain;
uniform float temperature;
uniform float contrast;
uniform float saturation;
uniform float shadowFade;
uniform vec4 shadowsShift;
uniform vec4 midtonesShift;
uniform vec4 highlightsShift;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return vec3(c.r <= 0.04045 ? lo.r : hi.r,
              c.g <= 0.04045 ? lo.g : hi.g,
              c.b <= 0.04045 ? lo.b : hi.b);
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return vec3(c.r <= 0.0031308 ? lo.r : hi.r,
              c.g <= 0.0031308 ? lo.g : hi.g,
              c.b <= 0.0031308 ? lo.b : hi.b);
}

float lutAt(float v, int channel) {
  vec4 t = texture(lut, vec2((v * 255.0 + 0.5) / 256.0, 0.5));
  return channel == 0 ? t.r : (channel == 1 ? t.g : t.b);
}

vec3 grade(vec2 xy) {
  vec3 c = clamp(texture(image, xy / imageSize).rgb, 0.0, 1.0);
  // 1 曝光補償(線性光域)
  c = clamp(linearToSrgb(srgbToLinear(c) * exposureGain), 0.0, 1.0);
  // 2 色溫
  c.r *= 1.0 + temperature;
  c.b *= 1.0 - temperature;
  // 3 對比,支點 0.5
  c = (c - 0.5) * contrast + 0.5;
  // 4 飽和
  float l = dot(c, LUMA);
  c = l + (c - l) * saturation;
  // 5 暗部褪色
  c = shadowFade + c * (1.0 - shadowFade);
  // 6 分區色彩平衡
  float lz = clamp(dot(c, LUMA), 0.0, 1.0);
  float ws = clamp(1.0 - 2.0 * lz, 0.0, 1.0);
  float wh = clamp(2.0 * lz - 1.0, 0.0, 1.0);
  c += shadowsShift.rgb * ws + midtonesShift.rgb * (1.0 - ws - wh) + highlightsShift.rgb * wh;
  // 7 曲線
  c = clamp(c, 0.0, 1.0);
  return vec3(lutAt(c.r, 0), lutAt(c.g, 1), lutAt(c.b, 2));
}
`;

export const GRADE_FS = `${HEADER}${GRADE_CHUNK}
void main() {
  fragColor = vec4(grade(gl_FragCoord.xy), 1.0);
}
`;

export const HIGHLIGHT_MASK_FS = `${HEADER}
uniform sampler2D image;
uniform vec2 imageSize;
uniform float threshold;
uniform float knee;
void main() {
  vec3 c = texture(image, gl_FragCoord.xy / imageSize).rgb;
  float l = clamp(dot(c, LUMA), 0.0, 1.0);
  float gate = knee > 0.0 ? smoothstep(threshold - knee, threshold + knee, l) : step(threshold, l);
  fragColor = vec4(vec3(l * gate), 1.0);
}
`;

export const LOCAL_CONTRAST_FS = `${HEADER}
uniform sampler2D mask;
uniform sampler2D surroundings;
uniform vec2 imageSize;
void main() {
  vec2 uv = gl_FragCoord.xy / imageSize;
  float v = max(0.0, texture(mask, uv).r - texture(surroundings, uv).r);
  fragColor = vec4(vec3(v), 1.0);
}
`;

export const RING_FS = `${HEADER}
uniform sampler2D spread;
uniform sampler2D core;
uniform vec2 imageSize;
uniform float coreAmount;
uniform float gain;
void main() {
  vec2 uv = gl_FragCoord.xy / imageSize;
  float v = max(0.0, texture(spread, uv).r - coreAmount * texture(core, uv).r);
  fragColor = vec4(vec3(clamp(v * gain, 0.0, 1.0)), 1.0);
}
`;

/**
 * 高斯模糊的一個方向。σ = 半徑 / 3,核截在 3σ,邊界延伸邊緣像素(CLAMP_TO_EDGE)。
 * Skia 的 `ImageFilter.MakeBlur` 在 CPU 上對大 σ 用三次盒狀模糊近似,這裡用真的高斯——
 * 差異在 golden 比對的容許範圍內(見 `scripts/golden.mjs`)。
 */
export const BLUR_FS = `${HEADER}
uniform sampler2D image;
uniform vec2 imageSize;
uniform vec2 direction;
uniform float sigma;
void main() {
  vec2 xy = gl_FragCoord.xy;
  int radius = int(ceil(3.0 * sigma));
  float twoSigma2 = 2.0 * sigma * sigma;
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float w = exp(-float(i * i) / twoSigma2);
    sum += w * texture(image, (xy + direction * float(i)) / imageSize).rgb;
    weight += w;
  }
  fragColor = vec4(sum / weight, 1.0);
}
`;

/** 等比縮放或裁切:取來源的一個矩形,線性取樣到目標大小。 */
export const SCALE_FS = `${HEADER}
uniform sampler2D image;
uniform vec2 imageSize;
uniform vec4 sourceRect;
uniform vec2 targetSize;
void main() {
  vec2 p = sourceRect.xy + gl_FragCoord.xy * sourceRect.zw / targetSize;
  fragColor = vec4(texture(image, p / imageSize).rgb, 1.0);
}
`;

/** 畫到螢幕上:上下翻,因為預設畫布的第 0 列在最下面。 */
export const PRESENT_FS = `${HEADER}
uniform sampler2D image;
uniform vec2 targetSize;
void main() {
  vec2 xy = vec2(gl_FragCoord.x, targetSize.y - gl_FragCoord.y);
  fragColor = vec4(texture(image, xy / targetSize).rgb, 1.0);
}
`;

export const FINISH_FS = `${HEADER}${GRADE_CHUNK}
uniform sampler2D clarityBlur;
uniform sampler2D ring;
uniform sampler2D noise;
uniform vec2 helperSize;

uniform vec2 helperScale;
uniform float clarityAmount;
uniform float halationAmount;
uniform vec2 center;
uniform float maxDistance;
uniform float centerBoost;
uniform float edgeVignette;
uniform float grainAmplitude;
uniform float grainCell;
uniform vec2 grainOffset;

const float GRAIN_TILE = 512.0;
const float GRAIN_MIDTONE_BIAS = 0.6;

float lattice(vec2 cell) {
  vec2 wrapped = mod(cell, GRAIN_TILE);
  return texelFetch(noise, ivec2(wrapped), 0).r;
}

float grainNoise(vec2 xy) {
  vec2 g = (xy - 0.5) / grainCell + grainOffset;
  vec2 i0 = floor(g);
  vec2 t = g - i0;
  vec2 f = t * t * (3.0 - 2.0 * t);
  float top = mix(lattice(i0), lattice(i0 + vec2(1.0, 0.0)), f.x);
  float bottom = mix(lattice(i0 + vec2(0.0, 1.0)), lattice(i0 + vec2(1.0, 1.0)), f.x);
  return mix(top, bottom, f.y) * 2.0 - 1.0;
}

void main() {
  vec2 xy = gl_FragCoord.xy;
  vec3 c = grade(xy);
  vec2 helperUv = xy * helperScale / helperSize;

  // 8 清晰度
  c += clarityAmount * (c - texture(clarityBlur, helperUv).rgb);

  // 9 紅暈(只動 R,Screen)
  float red = texture(ring, helperUv).r;
  c.r = mix(c.r, 1.0 - (1.0 - clamp(c.r, 0.0, 1.0)) * (1.0 - red), halationAmount);

  // 10 閃光燈遮罩
  float falloff = smoothstep(0.0, 1.0, length(xy - center) / maxDistance);
  c *= 1.0 + centerBoost * (1.0 - falloff) - edgeVignette * falloff;

  // 11 顆粒
  float v = clamp(dot(c, LUMA), 0.0, 1.0);
  float bias = 2.0 * v - 1.0;
  float midtone = 1.0 - bias * bias * GRAIN_MIDTONE_BIAS;
  c += grainNoise(xy) * grainAmplitude * midtone;

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
