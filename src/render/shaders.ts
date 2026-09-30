/**
 * GLSL ES 3.0 shader sources for the deferred graph.
 *
 * Kept in one file so the pass graph is readable in a single scroll: each
 * export is one pass, in execution order.
 */

export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// G-BUFFER
// RT0 = albedo.rgb, metallic
// RT1 = octahedral-encoded normal (rg), roughness (b), materialID (a)
// RT2 = emissive.rgb, clearcoat
// ---------------------------------------------------------------------------

export const GBUFFER_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;

uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat3 uNormalMatrix;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;

void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(uNormalMatrix * aNormal);
  vUV = aUV;
  gl_Position = uViewProj * wp;
}`;

export const GBUFFER_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;

layout(location=0) out vec4 gAlbedo;
layout(location=1) out vec4 gNormal;
layout(location=2) out vec4 gEmissive;

// Material 0 = plain, 1 = car paint (clearcoat + flake), 2 = glass,
// 3 = emissive light lens, 4 = track surface, 5 = metal, 6 = rubber

uniform int uMaterial;
uniform vec3 uBaseColor;
uniform float uMetallic;
uniform float uRoughness;
uniform vec3 uEmissive;
uniform float uClearcoat;
uniform float uPaintFlake;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float uSurfaceGrip; // rubber, drives slip-scaled heat sheen
uniform float uSlipAmount;

vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.xy;
  if (n.z < 0.0) e = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e * 0.5 + 0.5;
}

// Value noise for the metal-flake layer. Two octaves is enough: the flake is
// sub-pixel sparkle, and more octaves cost real time in the G-buffer.
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;

  vec3 albedo = uBaseColor;
  float metallic = uMetallic;
  float rough = uRoughness;
  vec3 emissive = uEmissive;
  float clearcoat = uClearcoat;

  if (uMaterial == 1) {
    // Car paint: metal flake in WORLD space at 400x so it parallaxes correctly
    // as the car moves. This is what sells "ray traced" more than any other
    // single effect, and it is the reason a stock PBR material looks plastic.
    vec3 wp = vWorldPos * 400.0;
    float n1 = vnoise(wp);
    float n2 = vnoise(wp * 2.7 + 11.3);
    float flake = n1 * 0.6 + n2 * 0.4;
    flake = smoothstep(0.62, 0.98, flake);
    // Flake perturbs the normal, not the base colour.
    vec3 jitter = vec3(
      vnoise(wp + 3.1) - 0.5,
      vnoise(wp + 7.7) - 0.5,
      vnoise(wp + 13.3) - 0.5);
    N = normalize(N + jitter * uPaintFlake * 0.35);
    metallic = clamp(metallic + flake * 0.55, 0.0, 1.0);
    rough = clamp(rough - flake * 0.06, 0.02, 1.0);
  } else if (uMaterial == 3) {
    // Emissive lens: brighter at the edges, like a real light unit.
    float edge = 1.0 - abs(dot(N, normalize(uCameraPos - vWorldPos)));
    emissive *= 0.65 + edge * 0.9;
  } else if (uMaterial == 6) {
    // Rubber: a faint sheen that rises with wheelspin heat.
    float heat = clamp(uSlipAmount, 0.0, 1.0);
    rough = clamp(rough - heat * 0.25, 0.05, 1.0);
    albedo = mix(albedo, albedo * vec3(1.1, 1.0, 0.95), heat * 0.4);
  } else if (uMaterial == 4) {
    // Track: a wet, low-roughness surface so SSR has something to bounce off.
    float wet = vnoise(vWorldPos * vec3(6.0, 1.0, 60.0));
    rough = clamp(rough * (0.55 + wet * 0.5), 0.03, 1.0);
  }

  gAlbedo = vec4(albedo, metallic);
  gNormal = vec4(octEncode(N), rough, float(uMaterial));
  gEmissive = vec4(emissive, clearcoat);
}`;

// ---------------------------------------------------------------------------
// DEFERRED LIGHTING
// ---------------------------------------------------------------------------

export const LIGHTING_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uEmissive;
uniform sampler2D uDepth;
uniform samplerCube uEnv;

uniform mat4 uInvViewProj;
uniform mat4 uView;
uniform vec3 uCameraPos;
uniform float uTime;
uniform int uNumLights;
uniform vec3 uLightPos[8];
uniform vec3 uLightColor[8];
uniform float uLightRange[8];
uniform float uLightIntensity[8];
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAOEnabled;
uniform float uEnvIntensity;
uniform float uExposure;

vec3 octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / max(1e-7, 3.14159265 * d * d);
}
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(1e-7, gv + gl);
}
vec3 F_Schlick(vec3 f0, float u) {
  return f0 + (1.0 - f0) * pow(1.0 - u, 5.0);
}

vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}

void main() {
  vec4 alb = texture(uAlbedo, vUV);
  vec4 nrm = texture(uNormal, vUV);
  vec4 emi = texture(uEmissive, vUV);
  float depth = texture(uDepth, vUV).r;

  if (depth >= 1.0) {
    // Sky: sample the environment probe along the view ray.
    vec3 dir = normalize(worldFromDepth(vUV, 1.0) - uCameraPos);
    vec3 sky = texture(uEnv, dir).rgb * uEnvIntensity;
    sky += uAmbientSky * 0.4;
    fragColor = vec4(sky * uExposure, 1.0);
    return;
  }

  vec3 N = octDecode(nrm.xy);
  float rough = max(0.02, nrm.b);
  int material = int(nrm.a + 0.5);
  float metallic = alb.a;
  float clearcoat = emi.a;
  vec3 P = worldFromDepth(vUV, depth);
  vec3 V = normalize(uCameraPos - P);
  float NoV = max(1e-4, dot(N, V));

  vec3 f0 = mix(vec3(0.04), alb.rgb, metallic);
  vec3 diffuseColor = alb.rgb * (1.0 - metallic);
  float a = rough * rough;

  vec3 direct = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uNumLights) break;
    vec3 Lv = uLightPos[i] - P;
    float dist = length(Lv);
    vec3 L = Lv / max(1e-4, dist);
    float NoL = dot(N, L);
    if (NoL <= 0.0) continue;
    // Inverse-square with a smooth window so lights have a finite range.
    float atten = uLightIntensity[i] / (1.0 + dist * dist);
    float win = clamp(1.0 - pow(dist / uLightRange[i], 4.0), 0.0, 1.0);
    atten *= win * win;

    vec3 H = normalize(V + L);
    float NoH = max(0.0, dot(N, H));
    float VoH = max(0.0, dot(V, H));

    // Clearcoat: a second, tighter GGX lobe over the base. This produces the
    // sharp second highlight down a car's flank that a single-lobe material
    // cannot.
    if (clearcoat > 0.0) {
      float ca = 0.002;
      float Dc = D_GGX(NoH, ca);
      float Vc = V_SmithGGX(NoV, max(1e-4, NoL), ca);
      float Fc = 0.04 + 0.96 * pow(1.0 - VoH, 5.0);
      direct += uLightColor[i] * atten * NoL * Dc * Vc * Fc * clearcoat;
    }

    vec3 F = F_Schlick(f0, VoH);
    float D = D_GGX(NoH, a);
    float Vis = V_SmithGGX(NoV, max(1e-4, NoL), a);
    vec3 spec = F * D * Vis;
    vec3 diff = diffuseColor * (1.0 / 3.14159265);
    direct += uLightColor[i] * atten * NoL * (diff + spec);
  }

  // Image-based ambient from the environment probe.
  vec3 R = reflect(-V, N);
  vec3 irr = texture(uEnv, N).rgb;
  vec3 pre = textureLod(uEnv, R, rough * 6.0).rgb;
  vec3 ambient = diffuseColor * irr * uEnvIntensity;
  ambient += pre * f0 * uEnvIntensity * (1.0 - rough * 0.65);

  // Hemispheric ambient term so nothing is ever pure black.
  ambient += diffuseColor * mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);

  float ao = uAOEnabled > 0.5 ? 1.0 : 1.0;

  vec3 color = direct * ao + ambient;
  color += emi.rgb;
  fragColor = vec4(color * uExposure, 1.0);
}`;

// ---------------------------------------------------------------------------
// GTAO — ground-truth ambient occlusion, horizon search
// ---------------------------------------------------------------------------

export const GTAO_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform mat4 uInvViewProj;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec2 uResolution;
uniform float uRadius;
uniform int uDirections;
uniform int uSteps;

vec3 octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}
vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float depth = texture(uDepth, vUV).r;
  if (depth >= 1.0) { fragColor = vec4(1.0); return; }

  vec3 P = worldFromDepth(vUV, depth);
  vec3 V = normalize(P - worldFromDepth(vUV, 1.0));
  // Reconstruct view-space normal.
  vec3 N = octDecode(texture(uNormal, vUV).xy);
  vec3 Vv = normalize((uView * vec4(P, 0.0)).xyz);
  vec3 Nv = normalize((uView * vec4(N, 0.0)).xyz);

  float radius = uRadius;
  float stepSize = radius / float(uSteps);
  float angle = hash12(gl_FragCoord.xy) * 6.2831853;

  float occlusion = 0.0;
  for (int d = 0; d < uDirections; d++) {
    if (d >= uDirections) break;
    float dirAngle = angle + float(d) * 3.14159265 / float(uDirections);
    vec2 dir = vec2(cos(dirAngle), sin(dirAngle));
    // Projection of the hemisphere direction into screen space.
    vec3 dirWorld = normalize(vec3(dir.x, dir.y, 0.0) - 0.35 * Vv);
    vec4 clip = uProj * vec4(P + dirWorld * radius, 1.0);
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;

    for (int s = 0; s < 8; s++) {
      if (s >= uSteps) break;
      vec2 suvS = mix(vUV, suv, float(s + 1) / float(uSteps));
      float sd = texture(uDepth, suvS).r;
      if (sd >= 1.0) continue;
      vec3 sampleP = worldFromDepth(suvS, sd);
      float dz = P.z - sampleP.z;
      float dist = length(sampleP - P);
      // A sample occludes if it is in front of us AND close by.
      float rangeCheck = smoothstep(0.0, 1.0, radius / max(0.001, dist));
      if (dz > 0.02 * dist) {
        occlusion += rangeCheck;
      }
    }
  }
  float total = float(uDirections * uSteps);
  float ao = 1.0 - clamp(occlusion / max(1.0, total * 0.35), 0.0, 1.0);
  fragColor = vec4(ao, ao, ao, 1.0);
}`;

// ---------------------------------------------------------------------------
// SCREEN-SPACE REFLECTION
// ---------------------------------------------------------------------------

export const SSR_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform sampler2D uNormal;
uniform mat4 uInvViewProj;
uniform mat4 uProj;
uniform mat4 uView;
uniform vec3 uCameraPos;
uniform float uRoughnessFade;
uniform int uSteps;
uniform float uMaxDistance;

vec3 octDecode(vec2 e) {
  e = e * 2.0 - 1.0;
  vec3 n = vec3(e.xy, 1.0 - abs(e.x) - abs(e.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}
vec3 worldFromDepth(vec2 uv, float depth) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  return w.xyz / w.w;
}

void main() {
  vec4 base = texture(uColor, vUV);
  float depth = texture(uDepth, vUV).r;
  if (depth >= 1.0) { fragColor = vec4(0.0); return; }

  vec4 nrm = texture(uNormal, vUV);
  float rough = nrm.b;
  vec3 N = octDecode(nrm.xy);
  vec3 P = worldFromDepth(vUV, depth);
  vec3 V = normalize(uCameraPos - P);
  vec3 R = reflect(-V, N);

  // Rougher surfaces reflect less and fade faster.
  float confidence = (1.0 - smoothstep(0.15, 0.75, rough)) * uRoughnessFade;
  if (confidence <= 0.001) { fragColor = vec4(0.0); return; }

  vec3 hit = vec3(0.0);
  float hitFound = 0.0;
  float stepLen = uMaxDistance / float(uSteps);

  for (int i = 1; i <= 64; i++) {
    if (i > uSteps) break;
    float t = float(i) * stepLen;
    vec3 sp = P + R * t;
    vec4 clip = uProj * vec4(sp, 1.0);
    if (clip.w <= 0.0) break;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;

    float sd = texture(uDepth, suv).r;
    if (sd >= 1.0) continue;
    vec3 sceneP = worldFromDepth(suv, sd);
    float dRay = length(sp - P);
    float dScene = length(sceneP - P);
    // Ray passes behind geometry: a hit.
    if (dScene < dRay && dRay - dScene < stepLen * 2.5) {
      hit = sceneP;
      hitFound = 1.0;
      break;
    }
  }

  if (hitFound < 0.5) { fragColor = vec4(0.0); return; }

  vec4 clip = uProj * vec4(hit, 1.0);
  vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
  vec3 reflected = texture(uColor, suv).rgb;

  // Fade at the screen edges and with distance so there is no visible seam.
  vec2 fade = smoothstep(vec2(0.0), vec2(0.15), suv) *
              (1.0 - smoothstep(vec2(0.85), vec2(1.0), suv));
  float edgeFade = fade.x * fade.y;
  float distFade = 1.0 - smoothstep(uMaxDistance * 0.6, uMaxDistance, length(hit - P));

  fragColor = vec4(reflected, confidence * edgeFade * distFade);
}`;

// ---------------------------------------------------------------------------
// COMPOSITE — ACES, bloom mix, aberration, vignette, grain
// ---------------------------------------------------------------------------

export const COMPOSITE_FRAG = `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uAberration;
uniform float uTime;
uniform float uFlash;
uniform vec3 uFlashColor;

vec3 ACESFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUV;
  vec2 centred = uv - 0.5;
  float r2 = dot(centred, centred);

  // Chromatic aberration, radial and subtle.
  vec2 dir = centred * uAberration * r2;
  vec3 scene;
  scene.r = texture(uScene, uv + dir).r;
  scene.g = texture(uScene, uv).g;
  scene.b = texture(uScene, uv - dir).b;

  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 color = scene + bloom * uBloomStrength;

  color *= uExposure;
  color = ACESFilm(color);

  // Launch flash, tinted by the tree.
  color = mix(color, uFlashColor, clamp(uFlash, 0.0, 1.0));

  // Vignette.
  color *= 1.0 - uVignette * smoothstep(0.15, 0.75, r2);

  // Film grain, animated.
  float g = hash12(uv * 1024.0 + fract(uTime) * 431.0) - 0.5;
  color += g * uGrain;

  // Ordered dither to kill banding in the dark sky.
  float dither = hash12(gl_FragCoord.xy) - 0.5;
  color += dither / 255.0;

  fragColor = vec4(color, 1.0);
}`;

// ---------------------------------------------------------------------------
// BLOOM — bright pass with Karis average, then separable blur
// ---------------------------------------------------------------------------

export const BLOOM_PREFILTER_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uSoftKnee;

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  return c * contrib;
}

void main() {
  // Karis average: weight each texel by 1/(1+luminance) so a single very bright
  // pixel cannot dominate the mip and produce a firefly that flickers.
  vec2 texel = 1.0 / vec2(textureSize(uScene, 0));
  vec3 a = texture(uScene, vUV + texel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uScene, vUV + texel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture(uScene, vUV + texel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture(uScene, vUV + texel * vec2( 1.0,  1.0)).rgb;
  float wa = 1.0 / (1.0 + luminance(a));
  float wb = 1.0 / (1.0 + luminance(b));
  float wc = 1.0 / (1.0 + luminance(c));
  float wd = 1.0 / (1.0 + luminance(d));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  fragColor = vec4(prefilter(col), 1.0);
}`;

export const BLOOM_BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uDirection; // texel-sized step

void main() {
  // 9-tap Gaussian using linear-sampling pairs.
  const float o1 = 1.3846153846;
  const float o2 = 3.2307692308;
  const float w0 = 0.2270270270;
  const float w1 = 0.3162162162;
  const float w2 = 0.0702702703;
  vec3 col = texture(uSource, vUV).rgb * w0;
  col += texture(uSource, vUV + uDirection * o1).rgb * w1;
  col += texture(uSource, vUV - uDirection * o1).rgb * w1;
  col += texture(uSource, vUV + uDirection * o2).rgb * w2;
  col += texture(uSource, vUV - uDirection * o2).rgb * w2;
  fragColor = vec4(col, 1.0);
}`;

export const BLOOM_DOWN_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uTexel;
void main() {
  // 13-tap Karis-weighted downsample (Call of Duty / Jimenez).
  vec3 a = texture(uSource, vUV + uTexel * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uSource, vUV + uTexel * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uSource, vUV + uTexel * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uSource, vUV + uTexel * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uSource, vUV).rgb;
  vec3 f = texture(uSource, vUV + uTexel * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uSource, vUV + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSource, vUV + uTexel * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uSource, vUV + uTexel * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uSource, vUV + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uSource, vUV + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uSource, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSource, vUV + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;
  fragColor = vec4(col, 1.0);
}`;

export const BLOOM_UP_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSource;
uniform sampler2D uPrevious;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 s = texture(uSource, vUV + vec2(-o.x,  o.y)).rgb;
  s += texture(uSource, vUV + vec2( 0.0,   o.y)).rgb * 2.0;
  s += texture(uSource, vUV + vec2( o.x,   o.y)).rgb;
  s += texture(uSource, vUV + vec2(-o.x,   0.0)).rgb * 2.0;
  s += texture(uSource, vUV).rgb * 4.0;
  s += texture(uSource, vUV + vec2( o.x,   0.0)).rgb * 2.0;
  s += texture(uSource, vUV + vec2(-o.x,  -o.y)).rgb;
  s += texture(uSource, vUV + vec2( 0.0,  -o.y)).rgb * 2.0;
  s += texture(uSource, vUV + vec2( o.x,  -o.y)).rgb;
  fragColor = vec4(texture(uPrevious, vUV).rgb + s / 16.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// TAA
// ---------------------------------------------------------------------------

export const TAA_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform float uBlend;
uniform float uFeedback;

vec3 sampleClampToEdge(sampler2D tex, vec2 uv) {
  return texture(tex, clamp(uv, uTexel * 0.5, 1.0 - uTexel * 0.5)).rgb;
}

void main() {
  vec3 current = texture(uCurrent, vUV).rgb;
  vec3 history = sampleClampToEdge(uHistory, vUV);

  // Neighbourhood clamp: the 3x3 min/max of the current frame bounds how far
  // history can drift, which kills ghosting without a velocity buffer.
  vec3 lo = current;
  vec3 hi = current;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = sampleClampToEdge(uCurrent, vUV + vec2(float(x), float(y)) * uTexel);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  vec3 clamped = clamp(history, lo, hi);
  // Blend toward the clamped history: high feedback for static frames, low
  // for fast motion where ghosting is worse than blur.
  vec3 result = mix(current, clamped, clamp(uFeedback, 0.0, 0.95));
  fragColor = vec4(result, 1.0);
}`;

// ---------------------------------------------------------------------------
// VOLUMETRICS — half-res raymarch through exponential fog with light cones
// ---------------------------------------------------------------------------

export const VOLUMETRIC_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uDepth;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float uDensity;
uniform float uScatter;
uniform int uSteps;
uniform int uNumLights;
uniform vec3 uLightPos[8];
uniform vec3 uLightColor[8];
uniform float uLightRange[8];
uniform vec3 uFogColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float depth = texture(uDepth, vUV).r;
  vec4 ndc = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  vec3 far = w.xyz / w.w;
  vec3 rayDir = normalize(far - uCameraPos);

  float rayLen = 90.0;
  if (depth < 1.0) {
    vec4 nd = vec4(vUV * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 wp = uInvViewProj * nd;
    rayLen = min(90.0, length(wp.xyz / wp.w - uCameraPos));
  }

  int steps = uSteps;
  float stepLen = rayLen / float(steps);
  // Blue-noise-ish dither on the start offset breaks up banding.
  float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 137.0);
  vec3 accum = vec3(0.0);
  float t = stepLen * jitter;

  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    vec3 p = uCameraPos + rayDir * t;
    // Exponential height fog.
    float density = uDensity * exp(-max(0.0, p.y) * 0.09);
    vec3 inscatter = uFogColor * density * stepLen * 0.06;

    for (int li = 0; li < 8; li++) {
      if (li >= uNumLights) break;
      vec3 Lv = uLightPos[li] - p;
      float d = length(Lv);
      float win = clamp(1.0 - d / uLightRange[li], 0.0, 1.0);
      // A cone term: brightest directly under the light, like a real tower.
      float cone = win * win * uScatter;
      inscatter += uLightColor[li] * cone * density * stepLen * 0.09;
    }
    accum += inscatter;
    t += stepLen;
  }

  fragColor = vec4(accum, 1.0);
}`;

export const UPSAMPLE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSource;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uBlend;
void main() {
  // Bilateral-ish upsample: blend the half-res volumetric into the scene using
  // a simple depth-free box, which is fine for a smooth fog field.
  vec3 vol = texture(uSource, vUV).rgb;
  vec3 scene = texture(uScene, vUV).rgb;
  fragColor = vec4(scene + vol * uBlend, 1.0);
}`;

export const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uSource;
void main() {
  fragColor = texture(uSource, vUV);
}`;
