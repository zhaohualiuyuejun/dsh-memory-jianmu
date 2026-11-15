// 建木 · 记忆星图 V2 —— 无硬线版：全息光柱 + 光点枝 + 重点星环 + 功能窗
// 数据：./data/stats-<persona>.json / starmap-<persona>.meta.json / starmap-<persona>.bin
// bin 每点 7 个 float32：x y z conf t branch sub
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

// 恒星色温：全部低饱和、偏亮；红/紫已被替换成暖白与冷白
const REGION_COLOR = {
  记忆: 0x9fd4ff, 创作: 0xffd9a8, 生成: 0xc9d6ff, 平台: 0xa9efe6,
  社交: 0xffc4b0, 人设: 0xffe9b8, 工程: 0xc6efc9, 语音: 0xffd0b8, 其他: 0xb9c6d8,
}
const FLOATS = 7
// V10：主题旋臂漩涡。要回退 V8 星带塔：LAYOUT_SUFFIX 改成 ''，SHOW_INFINITY 改 true
const LAYOUT_SUFFIX = '-blade'
const SHOW_INFINITY = false
// 旋臂整体放大：只缩放 XZ（长度与厚度一起变），Y 不变；取景会按新跨度自适应
const ARM_SCALE = 1.20
// 内嵌进 DSH 时走 host 只读路由；独立静态服务时仍读 ./data
const EMBED = location.pathname.includes('/api/jianmu-starmap/ui')
const STARMAP_API = '/api/jianmu-starmap'
const PERSONA_PARAM = new URLSearchParams(location.search).get('persona')
// 调试参数：?still=1 停掉相机自转；?t0=秒数 直接把场景时间快进（用来验证星场公转/呼吸）
const DEBUG_Q = new URLSearchParams(location.search)
const STILL = DEBUG_Q.has('still')
const TIME0 = Number(DEBUG_Q.get('t0') || 0)
const VIEW0 = DEBUG_Q.get('view')   // ?view=top 直接以俯视打开（截图/调试用）
const AZ0 = Number(DEBUG_Q.get('az') || 0)   // ?az=度 固定相机方位角（截图/调试用）
// ?fs=1 强制 is-fs（无头截图验证全屏布局用）
if (DEBUG_Q.has('fs')) document.body.classList.add('is-fs')

// ── 两套主题：玫瑰金（默认）/ 黑金。颜色只在重建时读取，切换靠重载一次数据 ──
const THEMES = {
  rose: {
    monoHue: 0.018, monoSat: 0.46,
    trunkHue: 0.012, trunkSpan: 0.022, trunkSat: 0.55, trunkL: 0.62, trunkLSpan: 0.20,
    coreHue: 0.018, coreSat: 0.45,
    groundHue: 0.018, groundSat: 0.60,
    moteHue: 0.018, moteSpan: 0.020, moteSat: 0.45,
    bokehHue: 0.025, bokehSat: 0.30,
    nearHue: 0.022, nearSat: 0.32,
    glow: 0xf0c0a8, flareWarm: 0xffe6d2, flareCool: 0xf5dccd,
    wisps: [0xd8a48c, 0xe8bfa6, 0xc98d7a, 0xf0d2bc, 0xb98a76],
    mid: [0x9a6a5c, 0xc08a76, 0x7d564b, 0xd8a48c, 0xb9a48c],
    neb: 0xe8c6b8,
  },
  gold: {
    monoHue: 0.115, monoSat: 0.68,
    trunkHue: 0.100, trunkSpan: 0.030, trunkSat: 0.70, trunkL: 0.62, trunkLSpan: 0.20,
    coreHue: 0.110, coreSat: 0.60,
    groundHue: 0.110, groundSat: 0.70,
    moteHue: 0.100, moteSpan: 0.030, moteSat: 0.60,
    bokehHue: 0.110, bokehSat: 0.38,
    nearHue: 0.100, nearSat: 0.40,
    glow: 0xffd27a, flareWarm: 0xfff0c8, flareCool: 0xffe0a0,
    wisps: [0xd8b878, 0xe8cf96, 0xb8955e, 0xf0dcac, 0xc9a878],
    mid: [0x8a7444, 0xb8955e, 0x6e5c38, 0xd8b878, 0xa89060],
    neb: 0xd8c08a,
  },
}
const THEME_PARAM = DEBUG_Q.get('theme')
let savedTheme = null
try { savedTheme = localStorage.getItem('jianmu.starmap.theme') } catch { /* ignore */ }
let THEME_ID = THEMES[THEME_PARAM] ? THEME_PARAM : (THEMES[savedTheme] ? savedTheme : 'rose')
let THEME = THEMES[THEME_ID]
let NEB_BASE = THEME.neb
document.body.classList.toggle('theme-gold', THEME_ID === 'gold')
const DISPLAY = { alice: 'Alice', bob: 'Bob' }
const $ = (s) => document.querySelector(s)

// 内嵌面板宽度较窄，底部操作提示会和时间轴打架：内嵌时隐藏提示
if (EMBED) {
  const hint = $('#hint')
  if (hint) hint.style.display = 'none'
}

function dataUrl(kind, p) {
  const t = Date.now()
  if (!EMBED) {
    if (kind === 'stats') return `./data/stats-${p}.json?t=${t}`
    if (kind === 'meta') return `./data/starmap-${p}.meta.json?t=${t}`
    return `./data/starmap-${p}${LAYOUT_SUFFIX}.bin?t=${t}`
  }
  const q = new URLSearchParams({ personaId: p, _t: String(t) })
  return `${STARMAP_API}/${kind}?${q}`
}

// ── 基础 ────────────────────────────────────────────────
const canvas = $('#c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 0.98

const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2(0x0b0507, 0.0030)
const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 3000)
camera.position.set(0, 78, 250)

const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 44, 0)
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.minDistance = 14
controls.maxDistance = 340
controls.autoRotate = !STILL
controls.autoRotateSpeed = 0.55

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.40, 0.62, 0.20)
composer.addPass(bloom)
composer.addPass(new OutputPass())

// ── 通用点材质 ──────────────────────────────────────────
function dotMat({ size = 2, opacity = 1, square = false, flow = false, h = 100, spin = 0, pulse = 0, minSize = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: size }, uPR: { value: renderer.getPixelRatio() }, uOpacity: { value: opacity }, uTime: { value: 0 }, uH: { value: h }, uFlip: { value: S.flipped ? 1 : 0 }, uSpin: { value: spin }, uPulse: { value: pulse }, uMin: { value: minSize } },
    vertexShader: flow ? `
      attribute vec3 aPolar; attribute float aSeed; attribute vec3 aColor;
      uniform float uSize, uPR, uTime, uH, uOpacity, uFlip, uMin;
      varying vec3 vColor; varying float vA;
      void main(){
        float H = uH;
        float y = mod(aPolar.z + uTime * (1.1 + aSeed * 1.8), H);
        y = mix(y, H - y, uFlip);   // 倒置：粒子从树底向树顶反向流
        float ang = aPolar.y + uTime * (0.03 + aSeed * 0.05);
        vec3 p = vec3(cos(ang) * aPolar.x, y, sin(ang) * aPolar.x);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float edge = smoothstep(0.0, 6.0, y) * (1.0 - smoothstep(H - 10.0, H, y));
        gl_PointSize = max(uMin, min(7.0, uSize * uPR * (150.0 / max(1.0, -mv.z))));
        vColor = aColor; vA = edge * (0.70 + 0.30 * aSeed) * uOpacity;
        gl_Position = projectionMatrix * mv;
      }` : `
      attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
      uniform float uSize, uPR, uOpacity, uTime, uSpin, uPulse, uMin;
      varying vec3 vColor; varying float vA;
      void main(){
        // 整层绕主柱缓慢公转（星场/星河/地面点阵都吃这个）
        float ang = uTime * uSpin;
        float ca = cos(ang), sa = sin(ang);
        vec3 p = vec3(ca * position.x + sa * position.z, position.y, -sa * position.x + ca * position.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = max(uMin, aSize * uSize * uPR * (150.0 / max(1.0, -mv.z)));
        // 明灭呼吸：每颗星有自己的相位，汇成一片缓慢起伏的星海
        float ph = position.x * 0.08 + position.z * 0.06 + aSize * 17.0;
        float breath = 1.0 - uPulse * 0.45 + uPulse * 0.45 * sin(uTime * (0.55 + aSize * 0.9) + ph);
        vColor = aColor; vA = aAlpha * uOpacity * breath;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: square ? `
      varying vec3 vColor; varying float vA;
      void main(){
        vec2 p = abs(gl_PointCoord - 0.5);
        float d = max(p.x, p.y);
        float a = smoothstep(0.5, 0.30, d);
        if (a * vA <= 0.005) discard;
        gl_FragColor = vec4(vColor, a * vA);
      }` : `
      varying vec3 vColor; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.06, d);
        if (a * vA <= 0.005) discard;
        gl_FragColor = vec4(vColor, a * vA);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
}

// ── 深空氛围：程序化贴图（零素材、零外网）──────────────────
// 柔光点：径向渐变，用作光柱光晕 / 背景辉光
function makeGlowTexture() {
  const s = 128
  const c = document.createElement('canvas'); c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,0.95)')
  grd.addColorStop(0.28, 'rgba(255,255,255,0.42)')
  grd.addColorStop(0.62, 'rgba(255,255,255,0.10)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd; g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
// 星芒：亮星核心 + 四道细光刺（近景亮星用，营造“舷窗”感）
function makeFlareTexture() {
  const s = 128, c = s / 2
  const cv = document.createElement('canvas'); cv.width = cv.height = s
  const g = cv.getContext('2d')
  const core = g.createRadialGradient(c, c, 0, c, c, c)
  core.addColorStop(0, 'rgba(255,255,255,1)')
  core.addColorStop(0.06, 'rgba(255,255,255,0.85)')
  core.addColorStop(0.20, 'rgba(255,220,200,0.30)')
  core.addColorStop(0.55, 'rgba(255,200,180,0.06)')
  core.addColorStop(1, 'rgba(255,190,170,0)')
  g.fillStyle = core; g.fillRect(0, 0, s, s)
  g.globalCompositeOperation = 'lighter'
  const ray = (x1, y1, x2, y2, w) => {
    const lg = g.createLinearGradient(x1, y1, x2, y2)
    lg.addColorStop(0, 'rgba(255,210,190,0)')
    lg.addColorStop(0.5, 'rgba(255,235,220,0.55)')
    lg.addColorStop(1, 'rgba(255,210,190,0)')
    g.strokeStyle = lg; g.lineWidth = w
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke()
  }
  ray(c, 4, c, s - 4, 1.4)          // 竖
  ray(4, c, s - 4, c, 1.4)          // 横
  ray(c * 0.45, c * 0.45, c * 1.55, c * 1.55, 0.7)  // 斜
  ray(c * 1.55, c * 0.45, c * 0.45, c * 1.55, 0.7)
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace
  return t
}
// 云絮：多个柔和斑团叠成不规则云团（给星云薄雾当贴图）
function makeCloudTexture() {
  const s = 256
  const c = document.createElement('canvas'); c.width = c.height = s
  const g = c.getContext('2d')
  g.clearRect(0, 0, s, s)
  let seed = 20261114
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 26; i++) {
    const x = s * (0.18 + rnd() * 0.64), y = s * (0.18 + rnd() * 0.64)
    const r = s * (0.10 + rnd() * 0.22)
    const a = 0.06 + rnd() * 0.13
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, `rgba(255,255,255,${a})`)
    grd.addColorStop(0.55, `rgba(255,255,255,${a * 0.42})`)
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grd; g.fillRect(0, 0, s, s)
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
// 天幕：上暖下冷的极暗渐变，当星云球兜底（也是 vignette 之外的“有底”感）
function makeSkyTexture() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 512
  const g = c.getContext('2d')
  const grd = g.createLinearGradient(0, 0, 0, 512)
  grd.addColorStop(0.00, '#070d1a')
  grd.addColorStop(0.42, '#040810')
  grd.addColorStop(0.78, '#02040a')
  grd.addColorStop(1.00, '#010205')
  g.fillStyle = grd; g.fillRect(0, 0, 8, 512)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
const TEX = { glow: makeGlowTexture(), cloud: makeCloudTexture(), flare: makeFlareTexture() }
scene.background = makeSkyTexture()

// ── 星云背景 ────────────────────────────────────────────
// ?nebrot= 只是调试用：用来挑银河带在默认视角下的方位
// 默认 2.4 / 0.9 是实测选出来的：银河带斜穿背景，且等距贴图的极点接缝避开俯视视线（否则俯视会出现放射状假光芒）
const NEB_ROT = Number(new URLSearchParams(location.search).get('nebrot') || 2.4)
const NEB_ROTX = Number(new URLSearchParams(location.search).get('nebrotx') || 0.9)
let nebulaMesh = null, nebulaMesh2 = null
new THREE.TextureLoader().load('./data/nebula.jpg?v=19', (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace
  const g = new THREE.SphereGeometry(1500, 48, 24)
  // 两层星云壳：同一张贴图、不同朝向。一层转到「带正好在头顶/脚底」时，
  // 另一层的带会斜穿画面，任何方位都不会只剩纯黑。
  const mk = (rot, bright, order, additive) => {
    const m = new THREE.MeshBasicMaterial({
      map: tex, color: new THREE.Color(THEME.neb).multiplyScalar(bright),
      side: THREE.BackSide, depthWrite: false, fog: false,
      transparent: additive, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    m.userData.baseScale = bright
    const mesh = new THREE.Mesh(g, m)
    mesh.rotation.set(rot[0], rot[1], rot[2])
    mesh.renderOrder = order
    scene.add(mesh)
    S.nebMats.push(m)
    return mesh
  }
  // 第一层当底图（不透明）；第二层用加色叠上去，且朝向与第一层大致垂直：
  // 第一层的带转到头顶时，第二层的带正好横穿画面。
  nebulaMesh = mk([NEB_ROTX, NEB_ROT, 0], 1.0, -2, false)
  nebulaMesh2 = mk([NEB_ROTX + Math.PI / 2, NEB_ROT - 0.6, 0.15], 0.55, -1, true)
})

// ── 状态 ────────────────────────────────────────────────
const S = {
  persona: 'alice', stats: null, meta: [], positions: null, n: 0,
  points: null, geo: null, mat: null,
  ring: null, ringGeo: null, ringMat: null, ringIdx: [], ringGroup: null, ringN: 0,
  env: [], branches: [], scan: null,
  isolate: -1, tMin: 0, tMax: 1e15, query: '', fps: 0, frames: 0, last: performance.now(), palette: 'mono',
  cardMeta: null, cardIdx: -1, trunkMats: [], view: 'iso',
  focus: null, focusHi: -1, prevView: null, camAnim: null,
  // 深空氛围层（纯视觉，不参与拾取）
  atmos: 'normal', wisps: [], dustMat: null, moteMat: null, haloMats: [], starMat: null, nebMats: [],
  bandMats: [], bokehMat: null, nearMat: null, flareMats: [], flareSprites: [], flipped: true, yBase: null,
}

// 氛围档：淡 / 标准 / 浓。数值都乘在“基准值”上，改这里即可整体调强弱
const ATMOS = {
  light:  { neb: 0.44, star: 0.86, wisp: 0.50, dust: 0.55, mote: 0.55, halo: 0.60, bloom: 0.78 },
  normal: { neb: 0.74, star: 1.20, wisp: 1.00, dust: 1.00, mote: 1.00, halo: 1.00, bloom: 1.00 },
  dense:  { neb: 0.98, star: 1.38, wisp: 1.45, dust: 1.45, mote: 1.30, halo: 1.25, bloom: 1.00 },
}
// NEB_BASE 由主题提供（见上方 THEMES）
const BLOOM_BASE = { mono: 0.40, color: 0.48 }

const REGION_TINT = { 记忆: 0.00, 创作: 0.06, 生成: 0.12, 平台: 0.18, 社交: 0.24, 人设: 0.30, 工程: 0.36, 语音: 0.42, 其他: 0.48 }

function branchColor(idx, total, region) {
  if (S.palette === 'mono') {
    const t = REGION_TINT[region] ?? 0.48
    const l = Math.min(0.87, 0.66 + t * 0.18 + ((idx % 3) - 1) * 0.012)
    return new THREE.Color().setHSL(THEME.monoHue, THEME.monoSat, l)
  }
  const base = new THREE.Color(REGION_COLOR[region] || REGION_COLOR['其他'])
  const hsl = {}
  base.getHSL(hsl)
  const h = (hsl.h + ((idx % 7) - 3) * 0.006 + total * 0.0007) % 1
  const s = Math.min(0.40, hsl.s * (0.82 + ((idx % 3) * 0.07)))
  const l = Math.min(0.88, Math.max(0.64, hsl.l * (0.94 + ((idx % 5) * 0.028))))
  return new THREE.Color().setHSL((h + 1) % 1, s, l)
}

function disposePersona() {
  for (const o of [S.points, ...S.env]) {
    if (!o) continue
    scene.remove(o)
    // Sprite 用的是 three 内部共享几何体：dispose 会连累同场景其它精灵
    if (o.geometry && !o.isSprite) o.geometry.dispose()
    if (o.material) o.material.dispose()
  }
  S.wisps = []; S.haloMats = []; S.dustMat = null; S.moteMat = null; S.starMat = null; S.bandMats = []; S.bokehMat = null
  S.nearMat = null; S.flareMats = []; S.flareSprites = []; S.yBase = null; S.groundObj = null
  if (S.ringGroup) {
    scene.remove(S.ringGroup)
    S.ringGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    S.ringGroup = null
  }
  S.points = S.ring = null; S.ringGeo = S.ringMat = null
  S.env = []; S.scan = null; S.bandGuides = null; S.trunkMats = []
}

// ── 载入 ────────────────────────────────────────────────
async function loadPersona(p) {
  disposePersona()
  S.focus = null; S.focusHi = -1; S.prevView = null; S.camAnim = null
  { const fr = $('#focusreset'); if (fr) fr.style.display = 'none' }
  { const ee = $('#err'); if (ee) { ee.style.display = 'none'; ee.innerHTML = '' } }
  $('#subtitle').textContent = `读取 ${p} …`
  const [stats, meta, buf] = await Promise.all([
    fetch(dataUrl('stats', p)).then((r) => {
      if (!r.ok) throw new Error(`stats ${r.status}`); return r.json()
    }),
    fetch(dataUrl('meta', p)).then((r) => {
      if (!r.ok) throw new Error(`meta ${r.status}`); return r.json()
    }),
    fetch(dataUrl('bin', p)).then((r) => {
      if (!r.ok) throw new Error(`bin ${r.status}`); return r.arrayBuffer()
    }),
  ])
  const f = new Float32Array(buf)
  const n = f.length / FLOATS
  if (meta.length !== n) throw new Error(`点数不一致：meta=${meta.length} bin=${n}`)

  S.persona = p; S.stats = stats; S.meta = meta; S.n = n; S.branches = stats.branches
  const H = stats.tree.height

  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3)
  const aT = new Float32Array(n), aConf = new Float32Array(n), aBranch = new Float32Array(n), aHi = new Float32Array(n)
  const aAng = new Float32Array(n), aRad = new Float32Array(n), aY = new Float32Array(n), aSpin = new Float32Array(n)
  const yBase = new Float32Array(n)
  S.yBase = yBase
  const byId = new Map(stats.branches.map((b) => [b.id, b]))
  for (let i = 0; i < n; i++) {
    const o = i * FLOATS
    pos[i * 3] = f[o] * ARM_SCALE; pos[i * 3 + 1] = f[o + 1]; pos[i * 3 + 2] = f[o + 2] * ARM_SCALE
    aConf[i] = f[o + 3]; aT[i] = f[o + 4]; aBranch[i] = f[o + 5]
    // 极坐标（沿环流动）+ 逐星速度扰动
    aAng[i] = Math.atan2(f[o + 2], f[o])
    aRad[i] = Math.hypot(f[o], f[o + 2]) * ARM_SCALE
    yBase[i] = f[o + 1]
    aY[i] = f[o + 1]
    // 旋臂版：整盘同速刚体慢旋（有速度差会在几分钟后把臂抹散）；V8 星带版：相邻带反向
    const spinJit = (((i * 1103515245) % 1000) / 1000 - 0.5)
    if (LAYOUT_SUFFIX) aSpin[i] = 1
    else aSpin[i] = ((Math.round(f[o + 5]) % 2 === 0) ? 1 : -1) * (0.96 + (spinJit + 0.5) * 0.08)
    const b = byId.get(f[o + 5])
    const c = branchColor(f[o + 5], stats.k, b ? b.region : '其他')
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
  }
  S.positions = pos
  S.band = { ang: aAng, rad: aRad, y: aY, spin: aSpin }
  S.radBase = aRad.slice()   // 俯视归一化用的原始半径

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
  geo.setAttribute('aConf', new THREE.BufferAttribute(aConf, 1))
  geo.setAttribute('aBranch', new THREE.BufferAttribute(aBranch, 1))
  geo.setAttribute('aHi', new THREE.BufferAttribute(aHi, 1))
  geo.setAttribute('aAng', new THREE.BufferAttribute(aAng, 1))
  geo.setAttribute('aRad', new THREE.BufferAttribute(aRad, 1))
  geo.setAttribute('aY', new THREE.BufferAttribute(aY, 1))
  geo.setAttribute('aSpin', new THREE.BufferAttribute(aSpin, 1))

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTMin: { value: -1e18 }, uTMax: { value: 1e18 }, uIsolate: { value: -1 },
      uSize: { value: 1.9 }, uPR: { value: renderer.getPixelRatio() }, uTime: { value: 0 },
      uFlowBand: { value: 0.040 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aT; attribute float aConf; attribute float aBranch; attribute float aHi;
      attribute float aAng; attribute float aRad; attribute float aY; attribute float aSpin;
      uniform float uTMin, uTMax, uIsolate, uSize, uPR, uTime, uFlowBand;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        // 沿所在星带的圆环流动（相邻带反向）
        float ang = aAng + uTime * uFlowBand * aSpin;
        vec3 p = vec3(aRad * cos(ang), aY, aRad * sin(ang));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float vis = (aT >= uTMin && aT <= uTMax) ? 1.0 : 0.0;
        if (uIsolate >= 0.0 && abs(aBranch - uIsolate) > 0.5) vis = 0.0;
        float tw = 0.86 + 0.14 * sin(uTime * 1.5 + aBranch * 2.3 + p.x * 0.35);
        float s = uSize * (0.80 + 0.60 * aConf) * (1.0 + 1.9 * aHi) * tw;
        gl_PointSize = min(6.5, s * uPR * (150.0 / max(1.0, -mv.z)));
        vColor = aColor * (0.95 + 0.65 * aConf) * (1.0 + 2.2 * aHi);
        vAlpha = (0.42 + 0.52 * aConf) * vis * (0.85 + 0.15 * tw);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.08, d);
        if (a * vAlpha <= 0.004) discard;
        float core = smoothstep(0.22, 0.0, d);
        gl_FragColor = vec4(vColor + core * 0.30, a * vAlpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  S.geo = geo; S.mat = mat
  S.points = new THREE.Points(geo, mat)
  S.points.frustumCulled = false
  scene.add(S.points)

  buildRing(meta, stats)
  buildEnvironment(stats)
  applyFlip()
  applyViewTone(S.view)
  buildLegend(stats)
  buildPanels(stats, meta)
  recolor()
  // 枝 id 跨人格不通用：切人格一律清掉隔离
  S.isolate = -1
  if (S.bandGuides) S.bandGuides.material.uniforms.uIsolate.value = -1
  resetTime()
  $('#subtitle').textContent = `${DISPLAY[p] || p} · ${n.toLocaleString()} 条 claim · ${stats.k} 主题 · 建于 ${stats.builtAt.replace('T', ' ')}`
  // 通知宿主记住当前人格：否则切走再回来会被宿主 localStorage 的旧值覆盖
  if (EMBED) {
    try { parent.postMessage({ type: 'jianmu-starmap:persona', personaId: p }, '*') } catch { /* ignore */ }
  }
  controls.target.set(0, H * 0.50, 0)
  controls.update()
}

// ── 重点 ∞（水平、定住不动；星子沿 8 字循环流动）────────────
function buildRing(meta, stats) {
  if (!SHOW_INFINITY) { S.ringN = 0; S.ringIdx = []; return }
  const H = stats.tree.height
  const A = 86
  const cand = meta.map((m, i) => ({ i, conf: m.conf, t: m.t }))
    .filter((x) => x.conf >= 0.8)
    .sort((a, b) => (b.conf - a.conf) || (b.t - a.t))
  const take = cand.slice(0, 480)
  S.ringIdx = take.map((x) => x.i)
  S.ringN = take.length
  const n = S.ringN
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3)
  const aT = new Float32Array(n), aConf = new Float32Array(n), aBranch = new Float32Array(n), aHi = new Float32Array(n)
  const aT0 = new Float32Array(n), aSpeed = new Float32Array(n)
  const byId = new Map(stats.branches.map((b) => [b.id, b]))
  const fx = (t, a) => {
    const d = 1 + Math.sin(t) * Math.sin(t)
    return [a * Math.cos(t) / d, H * 0.5 + 0.35 * Math.sin(2 * t), a * Math.sin(t) * Math.cos(t) / d]
  }
  for (let k = 0; k < n; k++) {
    const m = meta[S.ringIdx[k]]
    const t0 = k / n
    const p = fx(t0 * Math.PI * 2, A)
    pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2]
    const b = byId.get(m.branch)
    const c = branchColor(m.branch, stats.k, b ? b.region : '其他')
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b
    aT[k] = m.t; aConf[k] = m.conf; aBranch[k] = m.branch
    aT0[k] = t0
    // 每颗星子速度略有差异 → 流动时会自然聚散，像水流而不是整体自转
    aSpeed[k] = 0.92 + ((k * 2654435761) % 1000) / 1000 * 0.16
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
  g.setAttribute('aConf', new THREE.BufferAttribute(aConf, 1))
  g.setAttribute('aBranch', new THREE.BufferAttribute(aBranch, 1))
  g.setAttribute('aHi', new THREE.BufferAttribute(aHi, 1))
  g.setAttribute('aT0', new THREE.BufferAttribute(aT0, 1))
  g.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1))
  const mtl = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 2.8 }, uPR: { value: renderer.getPixelRatio() },
      uTMin: { value: -1e18 }, uTMax: { value: 1e18 }, uIsolate: { value: -1 },
      uTime: { value: 0 }, uA: { value: A }, uH: { value: H }, uFlow: { value: 0.040 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aT; attribute float aConf; attribute float aBranch; attribute float aHi;
      attribute float aT0; attribute float aSpeed;
      uniform float uSize, uPR, uTMin, uTMax, uIsolate, uTime, uA, uH, uFlow;
      varying vec3 vColor; varying float vA;
      void main(){
        // 沿双纽线循环流动（整体形状不动，只有星子在跑）
        float tt = mod(aT0 * 6.28318530718 + uTime * uFlow * aSpeed, 6.28318530718);
        float d = 1.0 + sin(tt) * sin(tt);
        vec3 p = vec3(uA * cos(tt) / d, uH * 0.5 + 0.35 * sin(2.0 * tt), uA * sin(tt) * cos(tt) / d);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float vis = (aT >= uTMin && aT <= uTMax) ? 1.0 : 0.0;
        if (uIsolate >= 0.0 && abs(aBranch - uIsolate) > 0.5) vis = 0.0;
        float pulse = 0.85 + 0.15 * sin(uTime * 2.2 + aT0 * 40.0);
        gl_PointSize = uSize * (0.9 + 1.2 * aHi) * pulse * uPR * (150.0 / max(1.0, -mv.z));
        vColor = (aColor * 1.25 + vec3(0.10)) * (1.0 + 1.6 * aHi);
        vA = (0.72 + 0.28 * aConf) * vis * pulse;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vA;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        q = mat2(0.7071, -0.7071, 0.7071, 0.7071) * q;
        float d = max(abs(q.x), abs(q.y));
        float a = smoothstep(0.44, 0.20, d);
        if (a * vA <= 0.005) discard;
        gl_FragColor = vec4(vColor, a * vA);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  S.ringGeo = g; S.ringMat = mtl
  S.ring = new THREE.Points(g, mtl)
  S.ring.frustumCulled = false
  S.ringGroup = new THREE.Group()
  S.ringGroup.add(S.ring)
  scene.add(S.ringGroup)
}

// ── 环境：光柱 / 光点枝 / 地面 / 光环 / 扫描 ────────────────
function addEnv(obj) { S.env.push(obj); scene.add(obj) }

function buildEnvironment(stats) {
  const H = stats.tree.height
  const rnd = (seed) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647 }

  // 1) 全息树干：3200 粒子，向上流动（旋臂从这根主干上长出来）
  {
    const N = 4200, r = rnd(12345)
    const polar = new Float32Array(N * 3), seed = new Float32Array(N), col = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const rad = 0.45 + Math.sqrt(r()) * 4.5
      polar[i * 3] = rad; polar[i * 3 + 1] = r() * Math.PI * 2; polar[i * 3 + 2] = r() * H
      seed[i] = r()
      const c = new THREE.Color().setHSL(THEME.trunkHue + r() * THEME.trunkSpan, THEME.trunkSat, THEME.trunkL + r() * THEME.trunkLSpan)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    g.setAttribute('aPolar', new THREE.BufferAttribute(polar, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    // 加强氛围后光柱容易过曝：核心亮度从 1.7 收到 1.15，再靠外层光晕补“发光感”
    const tm = dotMat({ size: 2.6, flow: true, h: H, opacity: 1.15 })
    S.trunkMats.push(tm)
    addEnv(new THREE.Points(g, tm))
  }

  // 1b) 树干芯：贴轴的亮点，让正面能看清一根主干
  {
    const N = 1100, r = rnd(777)
    const polar = new Float32Array(N * 3), seed = new Float32Array(N), col = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      polar[i * 3] = r() * 1.4
      polar[i * 3 + 1] = r() * Math.PI * 2
      polar[i * 3 + 2] = r() * H
      seed[i] = r()
      const c = new THREE.Color().setHSL(THEME.coreHue, THEME.coreSat, 0.62 + r() * 0.18)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    g.setAttribute('aPolar', new THREE.BufferAttribute(polar, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    const tm = dotMat({ size: 2.8, flow: true, h: H, opacity: 1.05 })
    S.trunkMats.push(tm)
    addEnv(new THREE.Points(g, tm))
  }

  // 2) V8 导引环：旋臂版不再画环（全息点自己成形，避免硬线）
  if (!LAYOUT_SUFFIX) {
    const pts = [], cols = [], sizes = [], alphas = [], brs = []
    for (const b of stats.branches) {
      const c = branchColor(b.id, stats.k, b.region)
      const dots = 96
      for (let k2 = 0; k2 < dots; k2++) {
        const a = (k2 / dots) * Math.PI * 2
        pts.push(Math.cos(a) * b.r, b.y, Math.sin(a) * b.r)
        cols.push(c.r * 0.62, c.g * 0.62, c.b * 0.62)
        sizes.push(0.85)
        alphas.push(0.13 + 0.06 * (b.thick || 0.5))
        brs.push(b.id)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3))
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
    g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
    g.setAttribute('aBranch', new THREE.Float32BufferAttribute(brs, 1))
    // 导引环也要吃隔离过滤：隔离时只留这一圈的轮廓
    const gm = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1.0 }, uPR: { value: renderer.getPixelRatio() }, uIsolate: { value: -1 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aBranch;
        uniform float uSize, uPR, uIsolate;
        varying vec3 vColor; varying float vA;
        void main(){
          float vis = (uIsolate >= 0.0 && abs(aBranch - uIsolate) > 0.5) ? 0.0 : 1.0;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uSize * uPR * (150.0 / max(1.0, -mv.z));
          vColor = aColor; vA = aAlpha * vis;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.10, d);
          if (a * vA <= 0.004) discard;
          gl_FragColor = vec4(vColor, a * vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    const guides = new THREE.Points(g, gm)
    S.bandGuides = guides
    S.guideGeo = g
    addEnv(guides)
  }

  // 3) 地面同心点阵 + 4) 空中光环
  {
    const pts = [], cols = [], sizes = [], alphas = []
    const push = (x, y, z, c, s, a) => { pts.push(x, y, z); cols.push(c.r, c.g, c.b); sizes.push(s); alphas.push(a) }
    for (let ring = 0; ring < 19; ring++) {
      const R = 8 + ring * 3.6, dots = 90
      for (let k = 0; k < dots; k++) {
        const a = (k / dots) * Math.PI * 2 + ring * 0.05
        push(Math.cos(a) * R, 0, Math.sin(a) * R, new THREE.Color().setHSL(THEME.groundHue, THEME.groundSat, 0.34), 0.9, 0.16 * (1 - ring / 22))
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3))
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
    g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
    const rings = new THREE.Points(g, dotMat({ size: 1.2, spin: 0.022, pulse: 0.35 }))
    S.groundObj = rings
    addEnv(rings)
  }

  // 5) 扫描弧（暂不启用：观感像一条野线）
  if (false)
  {
    const N = 160
    const pts = [], cols = [], sizes = [], alphas = []
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1), R = 6 + t * 82, a = t * 0.55
      pts.push(Math.cos(a) * R, 0.12, Math.sin(a) * R)
      const c = new THREE.Color().setHSL(THEME.groundHue, 0.7, 0.6)
      cols.push(c.r, c.g, c.b); sizes.push(1.4); alphas.push(0.30 * (1 - t * 0.85))
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3))
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
    g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
    const p = new THREE.Points(g, dotMat({ size: 1.6 }))
    S.scan = p
    addEnv(p)
  }

  // 6) 远景星场：银河带附近更密 + 全天稀疏 + 少量亮星（背景层，不抢主图）
  {
    const N = 10000, pts = [], cols = [], sizes = [], alphas = []
    const n1 = new THREE.Vector3(0.28, 0.82, 0.50).normalize()
    const rand = Math.random
    for (let i = 0; i < N; i++) {
      let x, y, z
      if (i % 5 < 3) {
        // 银道面附近：拒绝采样，让 60% 星点聚到带里
        for (let k = 0; k < 24; k++) {
          const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1)
          x = Math.sin(ph) * Math.cos(th); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(th)
          const dd = (x * n1.x + y * n1.y + z * n1.z) / 0.16
          if (rand() < Math.exp(-dd * dd)) break
        }
      } else {
        const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1)
        x = Math.sin(ph) * Math.cos(th); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(th)
      }
      const r = 260 + rand() * 760
      pts.push(x * r, y * r * 0.85 + 30, z * r)
      const roll = rand()
      if (roll < 0.14) cols.push(1.0, 0.90, 0.78)
      else if (roll < 0.28) cols.push(1.0, 0.90, 0.80)
      else { const b = 0.72 + rand() * 0.28; cols.push(b, b * 0.93, b * 0.86) }
      const mag = Math.pow(rand(), 2.4)
      sizes.push(0.85 + mag * 1.9)
      alphas.push(0.50 + mag * 0.55)
    }
    // 少量亮星：远、小，给背景一点层次
    for (let i = 0; i < 260; i++) {
      const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1)
      const r = 420 + rand() * 620
      pts.push(Math.sin(ph) * Math.cos(th) * r, Math.cos(ph) * r * 0.85 + 30, Math.sin(ph) * Math.sin(th) * r)
      const warm = rand() < 0.25
      cols.push(1.0, warm ? 0.88 : 0.91, warm ? 0.72 : 0.82)
      sizes.push(2.2 + rand() * 1.9)
      alphas.push(0.56 + rand() * 0.34)
    }
    // 银道面星尘：极小、极淡，给银河带一点颗粒感
    for (let i = 0; i < 2600; i++) {
      let x, y, z
      for (let k = 0; k < 24; k++) {
        const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1)
        x = Math.sin(ph) * Math.cos(th); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(th)
        const dd = (x * n1.x + y * n1.y + z * n1.z) / 0.10
        if (rand() < Math.exp(-dd * dd)) break
      }
      const r = 300 + rand() * 700
      pts.push(x * r, y * r * 0.85 + 30, z * r)
      const b = 0.50 + rand() * 0.40
      cols.push(b, b * 0.90, b * 0.82)
      sizes.push(0.50 + rand() * 0.55)
      alphas.push(0.11 + rand() * 0.16)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(cols, 3))
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1))
    g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1))
    const sm = dotMat({ size: 1.95, spin: 0.026, pulse: 0.9, minSize: 2.0 })
    S.starMat = sm
    addEnv(new THREE.Points(g, sm))
  }

  // 7) 深空氛围层（尘埃 / 萤火 / 薄雾 / 光晕）
  if (!DEBUG_Q.has('bare')) buildAtmosphere(H)
}

// ── 深空氛围层：尘埃 / 萤火 / 星云薄雾 / 光柱光晕 ─────────────
function buildAtmosphere(H) {
  const rnd = (() => { let s = 86420; return () => (s = (s * 16807) % 2147483647) / 2147483647 })()

  // A) 漂浮尘埃：柱状空间里的细碎粒子，轻微漂浮 + 呼吸；近景视差全靠它
  {
    const N = 2400
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), seed = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const rr = 5 + Math.pow(rnd(), 0.62) * 148
      const a = rnd() * Math.PI * 2
      pos[i * 3] = Math.cos(a) * rr
      pos[i * 3 + 1] = -6 + rnd() * (H + 26)
      pos[i * 3 + 2] = Math.sin(a) * rr
      const warm = rnd() < 0.10
      const c = new THREE.Color().setHSL(warm ? 0.09 : 0.56, warm ? 0.35 : 0.30, 0.62 + rnd() * 0.22)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
      seed[i] = rnd()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    const m = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1.3 }, uPR: { value: renderer.getPixelRatio() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSeed;
        uniform float uSize, uPR, uTime, uOpacity;
        varying vec3 vColor; varying float vA;
        void main(){
          vec3 p = position;
          p.x += sin(uTime * 0.17 + aSeed * 31.0) * 1.8;
          p.y += sin(uTime * 0.10 + aSeed * 17.0) * 1.2;
          p.z += cos(uTime * 0.14 + aSeed * 23.0) * 1.8;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float tw = 0.55 + 0.45 * sin(uTime * (0.5 + aSeed * 1.3) + aSeed * 40.0);
          gl_PointSize = min(3.8, uSize * (0.45 + aSeed) * uPR * (150.0 / max(1.0, -mv.z)));
          vColor = aColor;
          vA = (0.085 + 0.24 * aSeed) * tw * uOpacity;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d);
          if (a * vA <= 0.003) discard;
          gl_FragColor = vec4(vColor, a * vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    S.dustMat = m
    addEnv(new THREE.Points(g, m))
  }

  // B) 恒星萤火：贴着主柱缓慢绕行的一圈大颗粒，让“树”有生命
  {
    const N = 200
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3)
    const rad = new Float32Array(N), ang = new Float32Array(N), yy = new Float32Array(N), seed = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      rad[i] = 2.2 + Math.pow(rnd(), 0.8) * 14
      ang[i] = rnd() * Math.PI * 2
      yy[i] = rnd() * H
      seed[i] = rnd()
      pos[i * 3] = Math.cos(ang[i]) * rad[i]; pos[i * 3 + 1] = yy[i]; pos[i * 3 + 2] = Math.sin(ang[i]) * rad[i]
      const c = new THREE.Color().setHSL(THEME.moteHue + rnd() * THEME.moteSpan, THEME.moteSat, 0.72 + rnd() * 0.16)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1))
    g.setAttribute('aAng', new THREE.BufferAttribute(ang, 1))
    g.setAttribute('aY', new THREE.BufferAttribute(yy, 1))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    const m = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 2.4 }, uPR: { value: renderer.getPixelRatio() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aRad, aAng, aY, aSeed;
        uniform float uSize, uPR, uTime, uOpacity;
        varying vec3 vColor; varying float vA;
        void main(){
          float ang = aAng + uTime * (0.020 + 0.030 * aSeed);
          vec3 p = vec3(cos(ang) * aRad, aY + sin(uTime * 0.23 + aSeed * 19.0) * 1.3, sin(ang) * aRad);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float pulse = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * (0.8 + aSeed) + aSeed * 30.0), 2.0);
          gl_PointSize = min(3.4, uSize * (0.55 + aSeed * 0.9) * uPR * (150.0 / max(1.0, -mv.z)));
          vColor = aColor;
          vA = (0.14 + 0.34 * aSeed) * (0.35 + 0.65 * pulse) * uOpacity;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.06, d);
          if (a * vA <= 0.003) discard;
          gl_FragColor = vec4(vColor, a * vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    S.moteMat = m
    addEnv(new THREE.Points(g, m))
  }

  // C) 星云薄雾：大张 billboard 云絮，远近错落 + 缓慢漂移 → 深空纵深
  // 尺寸跟着距离走（w≈r·0.3）：近的自动变小，避免贴镜头糊成一团白云
  {
    const N = 30
    const palette = THEME.wisps
    for (let i = 0; i < N; i++) {
      const upper = i >= 22   // 最后 8 片铺在上方，俯视时也有雾
      const r = upper ? 60 + rnd() * 130 : 110 + rnd() * 250
      const a = rnd() * Math.PI * 2
      const y = upper ? H * (0.45 + rnd() * 0.75) : -10 + rnd() * H
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.cloud, color: palette[i % palette.length],
        transparent: true, opacity: 0.045 + rnd() * 0.035,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }))
      spr.position.set(Math.cos(a) * r, y, Math.sin(a) * r)
      const w = Math.max(40, r * (0.30 + rnd() * 0.22))
      spr.scale.set(w, w * (0.5 + rnd() * 0.55), 1)
      spr.userData.base = spr.material.opacity
      spr.userData.bx = spr.position.x
      spr.userData.bz = spr.position.z
      spr.userData.phase = rnd() * Math.PI * 2
      spr.userData.drift = 2 + rnd() * 9
      spr.userData.spin = (rnd() - 0.5) * 0.06
      spr.renderOrder = -1
      addEnv(spr)
      S.wisps.push(spr)
    }
  }

  // D) 光柱光晕：两片竖向柔光贴着主柱，把“硬白柱”化成“发光柱”
  {
    const mk = (w, h, op) => {
      const mat = new THREE.SpriteMaterial({
        map: TEX.glow, color: THEME.glow, transparent: true, opacity: op,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
      mat.userData.base = op
      const spr = new THREE.Sprite(mat)
      spr.position.set(0, H * 0.5, 0)
      spr.scale.set(w, h, 1)
      spr.renderOrder = 1
      addEnv(spr)
      S.haloMats.push(mat)
    }
    mk(36, H * 1.10, 0.100)
    mk(12, H * 1.02, 0.160)
  }

  // E) 中景星云：十几片巨云铺在远中景，专治“四周一片死黑”
  {
    const N = 30
    const palette = THEME.mid
    for (let i = 0; i < N; i++) {
      const r = 620 + rnd() * 520
      const a = rnd() * Math.PI * 2
      const y = -70 + rnd() * 260
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.cloud, color: palette[i % palette.length],
        transparent: true, opacity: 0.008 + rnd() * 0.018,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }))
      spr.position.set(Math.cos(a) * r, y, Math.sin(a) * r)
      const w = r * (0.36 + rnd() * 0.22)
      spr.scale.set(w, w * (0.55 + rnd() * 0.55), 1)
      spr.userData.base = spr.material.opacity
      spr.userData.bx = spr.position.x
      spr.userData.bz = spr.position.z
      spr.userData.phase = rnd() * Math.PI * 2
      spr.userData.drift = 6 + rnd() * 18
      spr.userData.spin = (rnd() - 0.5) * 0.010
      spr.renderOrder = -2
      addEnv(spr)
      S.wisps.push(spr)
    }
  }

  // F) 银河星带：斜穿场景的细碎星河（不依赖贴图，自带视差）
  //    做两条互相交叉的带：相机绕到第一条的「极点」方向时，第二条正好横穿屏幕，
  //    这样转一圈至少有一条银河在画面里（之前只有一条，转到正对极点就什么都没了）。
  {
    const nA = new THREE.Vector3(0.34, 0.58, 0.74).normalize()
    const nB = new THREE.Vector3().crossVectors(nA, new THREE.Vector3(0, 1, 0)).normalize()
    const addBand = (N, nrm, dim, spread, psize) => {
      const pts = new Float32Array(N * 3), cols = new Float32Array(N * 3)
      const sizes = new Float32Array(N), alphas = new Float32Array(N)
      const u1 = new THREE.Vector3().crossVectors(nrm, new THREE.Vector3(0, 1, 0)).normalize()
      const u2 = new THREE.Vector3().crossVectors(nrm, u1).normalize()
      for (let i = 0; i < N; i++) {
        const r = 180 + Math.pow(rnd(), 0.7) * 620
        const a = rnd() * Math.PI * 2
        const g1 = (rnd() + rnd() + rnd() - 1.5) * spread   // 近似高斯：中间厚、两边薄
        const cx = Math.cos(a) * r, cy = Math.sin(a) * r
        pts[i * 3] = u1.x * cx + u2.x * cy + nrm.x * g1
        pts[i * 3 + 1] = u1.y * cx + u2.y * cy + nrm.y * g1 + 26
        pts[i * 3 + 2] = u1.z * cx + u2.z * cy + nrm.z * g1
        const warm = rnd() < 0.16
        const b = 0.55 + rnd() * 0.45
        if (warm) { cols[i * 3] = b; cols[i * 3 + 1] = b * 0.85; cols[i * 3 + 2] = b * 0.68 }
        else { cols[i * 3] = b; cols[i * 3 + 1] = b * 0.90; cols[i * 3 + 2] = b * 0.80 }
        sizes[i] = 0.42 + rnd() * 0.85
        alphas[i] = (0.08 + Math.pow(rnd(), 1.7) * 0.42) * dim
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
      g.setAttribute('aColor', new THREE.BufferAttribute(cols, 3))
      g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
      g.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1))
      const bm = dotMat({ size: psize, spin: 0.013, pulse: 0.55, minSize: 1.25 })
      S.bandMats.push(bm)
      addEnv(new THREE.Points(g, bm))
    }
    addBand(7000, nA, 1.0, 42, 2.6)
    addBand(4600, nB, 0.82, 58, 2.3)
  }

  // G) 前景光斑：近处失焦的尘粒。大而淡，缓缓漂移 → 电影级的“有空气”
  {
    const N = 340
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3)
    const size = new Float32Array(N), alpha = new Float32Array(N), seed = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const rr = 24 + Math.pow(rnd(), 0.55) * 76
      const a = rnd() * Math.PI * 2
      pos[i * 3] = Math.cos(a) * rr
      pos[i * 3 + 1] = -12 + rnd() * (H + 26)
      pos[i * 3 + 2] = Math.sin(a) * rr
      size[i] = 1.3 + rnd() * 2.3
      alpha[i] = 0.045 + rnd() * 0.095
      seed[i] = rnd()
      const c = new THREE.Color().setHSL(THEME.bokehHue, THEME.bokehSat, 0.74 + rnd() * 0.14)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    const m = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1.0 }, uPR: { value: renderer.getPixelRatio() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aSeed;
        uniform float uSize, uPR, uTime, uOpacity;
        varying vec3 vColor; varying float vA;
        void main(){
          vec3 p = position;
          p.x += sin(uTime * 0.075 + aSeed * 27.0) * 3.2;
          p.y += sin(uTime * 0.052 + aSeed * 13.0) * 2.2;
          p.z += cos(uTime * 0.068 + aSeed * 21.0) * 3.2;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float breathe = 0.65 + 0.35 * sin(uTime * (0.30 + aSeed * 0.5) + aSeed * 33.0);
          gl_PointSize = min(17.0, aSize * uSize * uPR * (260.0 / max(1.0, -mv.z)));
          vColor = aColor;
          vA = aAlpha * breathe * uOpacity;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.02, d);
          if (a * vA <= 0.002) discard;
          gl_FragColor = vec4(vColor, a * vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    S.bokehMat = m
    addEnv(new THREE.Points(g, m))
  }

  // H) 近景星：贴着镜头轨道飞过的亮星。半径 105–230 ≈ 相机轨道内侧，
  //    轨道一转它们就从近处掠过，视差最猛 —— 这就是“舷窗外”的来源
  {
    const N = 240
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3)
    const size = new Float32Array(N), alpha = new Float32Array(N), seed = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const rr = 105 + Math.pow(rnd(), 0.7) * 125
      const a = rnd() * Math.PI * 2
      pos[i * 3] = Math.cos(a) * rr
      pos[i * 3 + 1] = -50 + rnd() * (H + 100)
      pos[i * 3 + 2] = Math.sin(a) * rr
      size[i] = 1.1 + Math.pow(rnd(), 1.6) * 2.8
      alpha[i] = 0.45 + rnd() * 0.50
      seed[i] = rnd()
      const warm = rnd() < 0.14
      const c = new THREE.Color().setHSL(THEME.nearHue + rnd() * 0.015, THEME.nearSat, 0.80 + rnd() * 0.14)
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    const m = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 1.0 }, uPR: { value: renderer.getPixelRatio() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha; attribute float aSeed;
        uniform float uSize, uPR, uTime, uOpacity;
        varying vec3 vColor; varying float vA;
        void main(){
          // 近景星跟着星系一起公转，速度略快于远星 → 掠过感
          float ang = uTime * 0.065;
          float ca = cos(ang), sa = sin(ang);
          vec3 p = vec3(ca * position.x + sa * position.z, position.y, -sa * position.x + ca * position.z);
          p.x += sin(uTime * 0.06 + aSeed * 21.0) * 1.6;
          p.y += sin(uTime * 0.045 + aSeed * 13.0) * 1.2;
          p.z += cos(uTime * 0.055 + aSeed * 17.0) * 1.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float tw = 0.55 + 0.45 * sin(uTime * (0.7 + aSeed * 1.0) + aSeed * 44.0);
          gl_PointSize = min(14.0, aSize * uSize * uPR * (170.0 / max(1.0, -mv.z)));
          vColor = aColor;
          vA = aAlpha * tw * uOpacity;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float halo = smoothstep(0.5, 0.06, d);
          float core = smoothstep(0.13, 0.0, d);
          float a = halo * 0.42 + core * 0.75;
          if (a * vA <= 0.003) discard;
          gl_FragColor = vec4(vColor + core * 0.35, a * vA);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    S.nearMat = m
    addEnv(new THREE.Points(g, m))
  }

  // I) 近景亮星星芒：少量带四刺的亮星，是“舷窗”里最抓眼的层次
  {
    const N = 14
    for (let i = 0; i < N; i++) {
      const rr = 90 + rnd() * 150
      const a = rnd() * Math.PI * 2
      const warm = rnd() < 0.15
      const mat = new THREE.SpriteMaterial({
        map: TEX.flare, color: warm ? THEME.flareWarm : THEME.flareCool,
        transparent: true, opacity: 0.26 + rnd() * 0.24,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
      mat.userData.base = mat.opacity
      const spr = new THREE.Sprite(mat)
      const yy = -45 + rnd() * (H + 90)
      spr.position.set(Math.cos(a) * rr, yy, Math.sin(a) * rr)
      const sc = 5 + rnd() * 8
      spr.scale.set(sc, sc, 1)
      spr.renderOrder = 2
      spr.userData = {
        r: rr, a, y: yy, base: mat.opacity,
        phase: rnd() * Math.PI * 2,
        spin: 0.055 + rnd() * 0.030,
        speed: 0.55 + rnd() * 0.55,
      }
      addEnv(spr)
      S.flareMats.push(mat)
      S.flareSprites.push(spr)
    }
  }

  // J) 远景星云：把大云团均匀铺满整个天球（含头顶/脚下）。
  //    作用：相机转到任何方位都有一层底，不会出现“整片纯黑”的角度。
  //    离得远（780–1200）所以几乎不参与视差，只当背景。
  {
    const N = 34
    const palette = THEME.mid
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1
      const th = rnd() * Math.PI * 2
      const sp = Math.sqrt(Math.max(0, 1 - u * u))
      const rr = 780 + rnd() * 420
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: TEX.cloud, color: palette[i % palette.length],
        transparent: true, opacity: 0.012 + rnd() * 0.022,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }))
      spr.position.set(sp * Math.cos(th) * rr, u * rr * 0.72 + 44, sp * Math.sin(th) * rr)
      const w = 240 + rnd() * 340
      spr.scale.set(w, w * (0.45 + rnd() * 0.55), 1)
      spr.userData = {
        base: spr.material.opacity,
        bx: spr.position.x, bz: spr.position.z,
        phase: rnd() * Math.PI * 2,
        drift: 3 + rnd() * 8,
        spin: (rnd() - 0.5) * 0.020,
      }
      spr.renderOrder = -3
      addEnv(spr)
      S.wisps.push(spr)
    }
  }

  applyAtmos()
}

// ── 氛围档应用（淡 / 标准 / 浓）────────────────────────────
function applyAtmos() {
  const a = ATMOS[S.atmos] || ATMOS.normal
  S.atmosScale = a
  for (const m of S.nebMats) m.color.setHex(NEB_BASE).multiplyScalar(a.neb * (m.userData.baseScale || 1))
  if (S.starMat) S.starMat.uniforms.uOpacity.value = a.star
  for (const m of S.bandMats) m.uniforms.uOpacity.value = a.star
  if (S.nearMat) S.nearMat.uniforms.uOpacity.value = a.star * (S.dustView || 1)
  for (const m of S.flareMats) m.opacity = m.userData.base * a.wisp * (S.dustView || 1)
  if (S.dustMat) S.dustMat.uniforms.uOpacity.value = a.dust * (S.dustView || 1)
  if (S.moteMat) S.moteMat.uniforms.uOpacity.value = a.mote
  if (S.bokehMat) S.bokehMat.uniforms.uOpacity.value = a.dust * (S.dustView || 1)
  for (const s of S.wisps) s.material.opacity = s.userData.base * a.wisp
  for (const m of S.haloMats) m.opacity = m.userData.base * a.halo * (S.viewFactor || 1)
  bloom.strength = BLOOM_BASE[S.palette === 'mono' ? 'mono' : 'color'] * a.bloom
  const seg = $('#atmos')
  if (seg) for (const b of seg.children) b.classList.toggle('on', b.dataset.a === S.atmos)
}

// ── 配色切换 ────────────────────────────────────────────
function recolor() {
  const stats = S.stats
  if (!stats) return
  const byId = new Map(stats.branches.map((b) => [b.id, b]))
  const paint = (geo) => {
    if (!geo) return
    const br = geo.getAttribute('aBranch').array
    const col = geo.getAttribute('aColor')
    for (let i = 0; i < br.length; i++) {
      const c = branchColor(br[i], stats.k, byId.get(br[i]) ? byId.get(br[i]).region : '其他')
      col.array[i * 3] = c.r; col.array[i * 3 + 1] = c.g; col.array[i * 3 + 2] = c.b
    }
    col.needsUpdate = true
  }
  paint(S.geo)
  paint(S.ringGeo)
  paint(S.guideGeo)
  if (S.mat) S.mat.uniforms.uSize.value = S.palette === 'mono' ? 2.30 : 2.15
  applyAtmos()   // 统一入口：调色不改氛围档，氛围档自己乘在基准 bloom 上
  buildLegend(stats)
  if (S.isolate >= 0) {
    for (const r of $('#lgbody').children) r.classList.toggle('on', Number(r.dataset.b) === S.isolate)
  }
  for (const b of $('#pal').children) b.classList.toggle('on', b.dataset.p === S.palette)
}
$('#pal').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-p]')
  if (!btn) return
  S.palette = btn.dataset.p
  recolor()
})
$('#atmos').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-a]')
  if (!btn) return
  S.atmos = btn.dataset.a
  applyAtmos()
})
let themeBusy = false
async function setTheme(id) {
  if (themeBusy || !THEMES[id] || id === THEME_ID) return
  themeBusy = true
  THEME_ID = id
  THEME = THEMES[id]
  NEB_BASE = THEME.neb
  document.body.classList.toggle('theme-gold', id === 'gold')
  try { localStorage.setItem('jianmu.starmap.theme', id) } catch { /* ignore */ }
  const seg = $('#theme')
  if (seg) for (const b of seg.children) b.classList.toggle('on', b.dataset.t === id)
  const tag = $('#themeTag')
  if (tag) tag.textContent = id === 'gold' ? 'BLACK GOLD' : 'ROSE GOLD'
  try { await loadPersona(S.persona) } catch (err) { fail(err) }
  themeBusy = false
}
$('#theme').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-t]')
  if (btn) setTheme(btn.dataset.t)
})

// ── 左栏功能窗 ──────────────────────────────────────────
function buildPanels(stats, meta) {
  const d = (t) => { const x = new Date(t); return `${x.getMonth() + 1}/${x.getDate()}` }
  $('#p-pts').textContent = S.n.toLocaleString()
  $('#p-br').textContent = `${stats.k} / ${new Set(stats.branches.map((b) => b.region)).size}`
  const ringEl = $('#p-ring')
  if (ringEl) ringEl.textContent = S.ringN
  $('#p-range').textContent = `${d(stats.tRange[0])} – ${d(stats.tRange[1])}`
  $('#p-built').textContent = stats.builtAt.slice(5, 16).replace('T', ' ')

  const top = [...stats.branches].sort((a, b) => b.n - a.n).slice(0, 6)
  const maxN = top[0]?.n || 1
  $('#p-topn').textContent = `前 ${top.length}`
  const tw = $('#p-topics'); tw.innerHTML = ''
  for (const b of top) {
    const c = branchColor(b.id, stats.k, b.region)
    const row = document.createElement('div')
    row.className = 'trow'
    row.innerHTML = `<span class="dot" style="color:#${c.getHexString()}"></span><span class="nm2"><div class="t">${b.name}</div><div class="bar" style="color:#${c.getHexString()}"><i style="width:${Math.max(4, (100 * b.n) / maxN)}%"></i></div></span><span class="n">${b.n}</span>`
    row.onclick = () => toggleIsolate(b.id)
    tw.appendChild(row)
  }

  const ev = meta.map((m, i) => ({ m, i })).sort((a, b) => b.m.t - a.m.t).slice(0, 6)
  const ew = $('#p-events'); ew.innerHTML = ''
  for (const { m, i } of ev) {
    const row = document.createElement('div')
    row.className = 'trow'
    row.innerHTML = `<span class="nm2"><div class="t">${(m.title || '').slice(0, 24)}</div><div class="d">${d(m.t)} · ${m.kind}</div></span>`
    row.onclick = () => showCard(i)
    ew.appendChild(row)
  }
}

function toggleIsolate(id) {
  S.isolate = (S.isolate === id) ? -1 : id
  if (S.mat) S.mat.uniforms.uIsolate.value = S.isolate
  if (S.ringMat) S.ringMat.uniforms.uIsolate.value = S.isolate
  if (S.bandGuides) S.bandGuides.material.uniforms.uIsolate.value = S.isolate
  for (const r of $('#lgbody').children) r.classList.toggle('on', Number(r.dataset.b) === S.isolate)
  const b = S.branches.find((x) => x.id === S.isolate)
  $('#msg').textContent = S.isolate < 0 ? `全部 · ${S.stats.k} 旋臂` : `只看：${b.name}（${b.n}）`
}

// ── 图例 ────────────────────────────────────────────────
function buildLegend(stats) {
  const body = $('#lgbody')
  body.innerHTML = ''
  for (const b of stats.branches) {
    const c = branchColor(b.id, stats.k, b.region)
    const row = document.createElement('div')
    row.className = 'row'
    row.dataset.b = String(b.id)
    row.innerHTML = `<span class="dot" style="color:#${c.getHexString()}"></span><span class="nm">${b.name}</span><span class="ct">${b.n}</span>`
    row.title = `${b.region} · ${b.subBranches} 弧段 · ${b.n} 条`
    row.onclick = () => toggleIsolate(b.id)
    body.appendChild(row)
  }
  $('#lgcount').textContent = `${stats.branches.length} 臂`
}

// ── 时间轴 ──────────────────────────────────────────────
function fmtDay(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}` }
function resetTime() {
  $('#t0').value = 0; $('#t1').value = 100
  applyTime()
}
function applyTime() {
  const [lo, hi] = S.stats.tRange
  const a = Number($('#t0').value) / 100, b = Number($('#t1').value) / 100
  const t0 = lo + (hi - lo) * Math.min(a, b), t1 = lo + (hi - lo) * Math.max(a, b)
  S.tMin = t0; S.tMax = t1
  if (S.mat) { S.mat.uniforms.uTMin.value = t0; S.mat.uniforms.uTMax.value = t1 }
  if (S.ringMat) { S.ringMat.uniforms.uTMin.value = t0; S.ringMat.uniforms.uTMax.value = t1 }
  $('#t0v').textContent = fmtDay(Math.min(a, b) === a ? t0 : t1)
  $('#t1v').textContent = fmtDay(Math.max(a, b) === a ? t0 : t1)
  const p0 = Math.min(a, b) * 100, p1 = Math.max(a, b) * 100
  const fill = $('#tfill')
  if (fill) { fill.style.left = p0 + '%'; fill.style.width = Math.max(0, p1 - p0) + '%' }
  const dur = $('#tdur')
  if (dur) dur.textContent = `· ${Math.max(0, Math.round((t1 - t0) / 86400000))} 天`
}
$('#t0').oninput = applyTime
$('#t1').oninput = applyTime
$('#treset').onclick = resetTime

// ── 拾取 ────────────────────────────────────────────────
const v3 = new THREE.Vector3()
let hoverKey = ''
function pick(clientX, clientY) {
  if (!S.points) return null
  const rect = canvas.getBoundingClientRect()
  const px = clientX - rect.left, py = clientY - rect.top, w = rect.width, h = rect.height
  let best = null, bd = 20 * 20
  const br = S.geo.getAttribute('aBranch').array, at = S.geo.getAttribute('aT').array
  const B = S.band, u = S.mat.uniforms
  const nowT = u.uTime.value, flowB = u.uFlowBand.value
  for (let i = 0; i < S.n; i++) {
    if (at[i] < S.tMin || at[i] > S.tMax) continue
    if (S.isolate >= 0 && br[i] !== S.isolate) continue
    const ang = B.ang[i] + nowT * flowB * B.spin[i]
    v3.set(B.rad[i] * Math.cos(ang), B.y[i], B.rad[i] * Math.sin(ang)).project(camera)
    if (v3.z < -1 || v3.z > 1) continue
    const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h
    const dx = x - px, dy = y - py, d = dx * dx + dy * dy
    if (d < bd) { bd = d; best = { kind: 'leaf', idx: i } }
  }
  if (S.ring) {
    const rt = S.ringGeo.getAttribute('aT').array
    const rb = S.ringGeo.getAttribute('aBranch').array
    const t0s = S.ringGeo.getAttribute('aT0').array
    const spd = S.ringGeo.getAttribute('aSpeed').array
    const u = S.ringMat.uniforms
    const A = u.uA.value, H = u.uH.value, flow = u.uFlow.value, now = u.uTime.value
    for (let k = 0; k < S.ringN; k++) {
      if (rt[k] < S.tMin || rt[k] > S.tMax) continue
      if (S.isolate >= 0 && rb[k] !== S.isolate) continue
      const tt = ((t0s[k] * Math.PI * 2 + now * flow * spd[k]) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
      const den = 1 + Math.sin(tt) * Math.sin(tt)
      v3.set(A * Math.cos(tt) / den, H * 0.5 + 0.35 * Math.sin(2 * tt), A * Math.sin(tt) * Math.cos(tt) / den).project(camera)
      if (v3.z < -1 || v3.z > 1) continue
      const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h
      const dd = (x - px) * (x - px) + (y - py) * (y - py)
      if (dd < bd) { bd = dd; best = { kind: 'ring', k, idx: S.ringIdx[k] } }
    }
  }
  return best
}

// ── 聚焦：点星点 → 镜头推近；点空白/复位 → 回全景 ─────────────
function worldAt(i, t) {
  const u = S.mat.uniforms
  const ang = S.band.ang[i] + t * u.uFlowBand.value * S.band.spin[i]
  return new THREE.Vector3(S.band.rad[i] * Math.cos(ang), S.band.y[i], S.band.rad[i] * Math.sin(ang))
}

function tweenCamera(pos, target, dur = 620) {
  S.camAnim = {
    p0: camera.position.clone(), p1: pos.clone(),
    t0: controls.target.clone(), t1: target.clone(),
    start: performance.now(), dur,
  }
}

function focusPoint(i) {
  if (!S.points || !S.mat) return
  const t = S.mat.uniforms.uTime.value
  const p = worldAt(i, t)
  if (!S.focus) {
    S.prevView = {
      pos: camera.position.clone(), target: controls.target.clone(),
      up: camera.up.clone(), view: S.view,
    }
  }
  controls.autoRotate = false
  const dir = camera.position.clone().sub(controls.target)
  if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0.001)
  dir.normalize()
  const dist = 34
  tweenCamera(p.clone().add(dir.multiplyScalar(dist)), p, 620)
  S.focus = { idx: i, last: p.clone() }
  // 被聚焦的点加一点亮度
  const hi = S.geo.getAttribute('aHi')
  if (S.focusHi >= 0 && S.focusHi < S.n) hi.array[S.focusHi] = 0
  hi.array[i] = 1
  hi.needsUpdate = true
  S.focusHi = i
  const btn = $('#focusreset')
  if (btn) btn.style.display = 'block'
}

function resetFocus(animate = true) {
  if (!S.focus) return
  closeCard()
  const pv = S.prevView
  if (S.focusHi >= 0 && S.geo) {
    const hi = S.geo.getAttribute('aHi')
    hi.array[S.focusHi] = 0
    hi.needsUpdate = true
  }
  S.focus = null; S.focusHi = -1; S.prevView = null
  if (pv) {
    S.view = pv.view
    camera.up.copy(pv.up)
    if (animate) tweenCamera(pv.pos, pv.target, 700)
    else { camera.position.copy(pv.pos); controls.target.copy(pv.target) }
  }
  const btn = $('#focusreset')
  if (btn) btn.style.display = 'none'
}

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) { hideTip(); return }
  const hit = pick(e.clientX, e.clientY)
  const key = hit ? hit.kind + hit.idx : ''
  if (key === hoverKey) { if (hit) moveTip(e.clientX, e.clientY); return }
  hoverKey = key
  if (!hit) { hideTip(); return }
  const m = S.meta[hit.idx], b = S.branches.find((x) => x.id === m.branch)
  const tip = $('#tooltip')
  tip.querySelector('.t').textContent = m.title || '(无标题)'
  tip.querySelector('.m').textContent = `${hit.kind === 'ring' ? '★ 重点记忆 · ' : ''}${b ? b.name : ''} · ${m.topic || '无主题'} · ${m.kind} · 置信 ${m.conf} · ${fmtDay(m.t)}`
  tip.style.opacity = '1'
  moveTip(e.clientX, e.clientY)
})
function moveTip(x, y) {
  const tip = $('#tooltip')
  const w = tip.offsetWidth, h = tip.offsetHeight
  tip.style.left = Math.min(x + 16, innerWidth - w - 8) + 'px'
  tip.style.top = Math.min(y + 14, innerHeight - h - 8) + 'px'
}
function hideTip() { $('#tooltip').style.opacity = '0' }

canvas.addEventListener('click', (e) => {
  const hit = pick(e.clientX, e.clientY)
  if (!hit) { closeCard(); resetFocus(); return }
  showCard(hit.idx)
  focusPoint(hit.idx)
})

function closeCard() {
  $('#card').classList.remove('on')
  document.body.classList.remove('card-open')
}
$('#cclose').onclick = closeCard
$('#ccopy').onclick = async () => {
  const m = S.cardMeta
  if (!m) return
  try {
    await navigator.clipboard.writeText(`${m.title}\n\n${m.body}\n\n> ${m.quote}\n（${m.chunkId}）`)
    $('#ccopy').textContent = '已复制'; setTimeout(() => ($('#ccopy').textContent = '复制'), 1200)
  } catch {}
}
// 在年轮打开：年轮页目前没有「按 claimId 选中」的入口 → 复制 claimId + 通知宿主提示，
// 不硬造 URL（客户端路由不归星图管）。
$('#copen').onclick = async () => {
  const m = S.cardMeta
  if (!m) return
  const claimId = String(m.id || '')
  if (!claimId) {
    $('#msg').textContent = '这条 claim 没有 id，无法在年轮定位'
    return
  }
  let copied = false
  try { await navigator.clipboard.writeText(claimId); copied = true } catch { /* 无剪贴板权限就走展示 */ }
  if (EMBED) {
    try { parent.postMessage({ type: 'jianmu-starmap:open-claim', claimId, copied }, '*') } catch { /* ignore */ }
  }
  $('#msg').textContent = copied
    ? `claimId 已复制 · 到「年轮」搜索框粘贴`
    : `claimId：${claimId.slice(0, 22)}`
  const btn = $('#copen')
  const old = btn.textContent
  btn.textContent = copied ? '已复制' : '看状态栏'
  setTimeout(() => { btn.textContent = old }, 1600)
}

function showCard(i) {
  const m = S.meta[i]; S.cardMeta = m; S.cardIdx = i
  const b = S.branches.find((x) => x.id === m.branch)
  $('#ctitle').textContent = m.title || '(无标题)'
  $('#ctags').innerHTML = [
    b ? `<span class="tag" style="color:#${branchColor(m.branch, S.stats.k, b.region).getHexString()}">${b.name}</span>` : '',
    b ? `<span class="tag">${b.region}</span>` : '',
    `<span class="tag">${m.topic || '无主题'}</span>`,
    `<span class="tag">${m.kind}</span>`,
    `<span class="tag">${m.epistemic}</span>`,
    `<span class="tag">置信 ${m.conf}</span>`,
    `<span class="tag">${fmtDay(m.t)}</span>`,
    `<span class="tag">${m.persona}</span>`,
  ].join('')
  $('#cbody').textContent = m.body || ''
  $('#cquote').textContent = m.quote ? `「${m.quote}」` : ''
  $('#cfoot').textContent = m.chunkId ? m.chunkId.slice(0, 16) : ''
  $('#card').classList.add('on')
  document.body.classList.add('card-open')
}

// ── 搜索（含结果列表）──────────────────────────────────
let qTimer = null
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer)
  const v = e.target.value.trim()
  qTimer = setTimeout(() => applySearch(v), 180)
})
function applySearch(q) {
  if (!S.geo) return
  const hi = S.geo.getAttribute('aHi'), rhi = S.ringGeo ? S.ringGeo.getAttribute('aHi') : null
  const res = $('#qres')
  if (!q) {
    hi.array.fill(0); hi.needsUpdate = true
    if (rhi) { rhi.array.fill(0); rhi.needsUpdate = true }
    $('#msg').textContent = `${S.stats.k} 旋臂 · 全部`
    $('#p-qn').textContent = ''
    res.innerHTML = '<div class="empty">在右上输入关键词</div>'
    return
  }
  const ql = q.toLowerCase()
  let hit = 0
  const list = []
  for (let i = 0; i < S.n; i++) {
    const m = S.meta[i]
    const on = (m.title && m.title.toLowerCase().includes(ql)) ||
               (m.body && m.body.toLowerCase().includes(ql)) ||
               (m.topic && m.topic.toLowerCase().includes(ql))
    hi.array[i] = on ? 1 : 0
    if (on) { hit++; if (list.length < 40) list.push(i) }
  }
  hi.needsUpdate = true
  if (rhi) {
    for (let k = 0; k < S.ringN; k++) {
      const m = S.meta[S.ringIdx[k]]
      rhi.array[k] = (m.title && m.title.toLowerCase().includes(ql)) || (m.body && m.body.toLowerCase().includes(ql)) ? 1 : 0
    }
    rhi.needsUpdate = true
  }
  $('#msg').textContent = `搜索「${q}」：${hit} 命中`
  $('#p-qn').textContent = `${hit}`
  res.innerHTML = ''
  if (!list.length) { res.innerHTML = '<div class="empty">没有命中</div>'; return }
  for (const i of list.slice(0, 12)) {
    const m = S.meta[i]
    const row = document.createElement('div')
    row.className = 'trow'
    row.innerHTML = `<span class="nm2"><div class="t">${(m.title || '').slice(0, 26)}</div><div class="d">${fmtDay(m.t)} · ${m.topic || m.kind}</div></span>`
    row.onclick = () => showCard(i)
    res.appendChild(row)
  }
}

// ── 视角切换 ────────────────────────────────────────────
function applyViewTone(v) {
  S.viewFactor = v === 'top' ? 0.28 : 1
  const sizes = [2.5, 2.7]
  S.trunkMats.forEach((m, i) => {
    m.uniforms.uOpacity.value = v === 'top' ? 0.18 : 0.95
    m.uniforms.uSize.value = v === 'top' ? 1.5 : sizes[i]
  })
  // 光柱光晕是“竖着的一根光”；俯视时从顶上看会变成一个亮球挡住中心，必须收暗
  for (const m of S.haloMats) m.opacity = m.userData.base * S.viewFactor
  // 俯视时地面同心环被透视投到旋臂外圈，会把“标准圆”边界弄毛 → 隐藏
  if (S.groundObj) S.groundObj.visible = v !== 'top'
  // 前景尘埃/光斑/近景星在俯视里会盖住旋臂末端 → 只留三成
  S.dustView = v === 'top' ? 0.30 : 1
  if (S.dustMat) S.dustMat.uniforms.uOpacity.value = (S.atmosScale?.dust ?? 1) * S.dustView
  if (S.bokehMat) S.bokehMat.uniforms.uOpacity.value = (S.atmosScale?.dust ?? 1) * S.dustView
  if (S.nearMat) S.nearMat.uniforms.uOpacity.value = (S.atmosScale?.star ?? 1) * S.dustView
  for (const m of S.flareMats) m.opacity = m.userData.base * (S.atmosScale?.wisp ?? 1) * S.dustView
  applyTopNormalize(v)
}

// 俯视透视补偿：每根旋臂按“末端到相机的高度”缩放半径，使 25 个末端投影到同一圆上。
// 只改 aRad 数组（渲染与拾取共用），切回斜视时从 radBase 还原。
function applyTopNormalize(v) {
  if (!S.geo || !S.radBase || !S.band) return
  const rad = S.geo.getAttribute('aRad')
  const arr = rad.array
  const n = S.n
  if (v !== 'top') {
    for (let i = 0; i < n; i++) arr[i] = S.radBase[i]
    rad.needsUpdate = true
    return
  }
  const nb = S.stats ? S.stats.branches.length : 1
  const y = S.geo.getAttribute('aY').array
  const br = S.geo.getAttribute('aBranch').array
  const maxR = new Float32Array(nb), maxY = new Float32Array(nb)
  for (let i = 0; i < n; i++) {
    const b = br[i] | 0
    if (S.radBase[i] > maxR[b]) { maxR[b] = S.radBase[i]; maxY[b] = y[i] }
  }
  const camY = TOP_CAM_Y
  // 目标投影半径 0.33：俯视时盘子铺得更满（原 0.26 偏小）；仍保证 25 个末端落进同一圆
  const target = 0.33
  const K = new Float32Array(nb).fill(1)
  for (let b = 0; b < nb; b++) {
    if (maxR[b] <= 0) continue
    const s = maxR[b] / Math.max(1, camY - maxY[b])
    K[b] = Math.min(6.0, Math.max(0.45, target / s))
  }
  for (let i = 0; i < n; i++) arr[i] = S.radBase[i] * K[br[i] | 0]
  rad.needsUpdate = true
}

// ── 正置 / 倒置：只翻 Y，不动 XZ 与旋臂形状 ────────────────
function applyFlip() {
  const H = S.stats ? S.stats.tree.height : 88
  if (S.geo && S.yBase) {
    const pa = S.geo.getAttribute('position'), ay = S.geo.getAttribute('aY')
    for (let i = 0; i < S.n; i++) {
      const y = S.flipped ? H - S.yBase[i] : S.yBase[i]
      pa.array[i * 3 + 1] = y
      ay.array[i] = y
    }
    pa.needsUpdate = true
    ay.needsUpdate = true
  }
  // 光柱粒子在 shader 里算 Y，用 uFlip 让它从另一头流
  for (const m of S.trunkMats) if (m.uniforms.uFlip) m.uniforms.uFlip.value = S.flipped ? 1 : 0
  if (S.groundObj) S.groundObj.position.y = S.flipped ? H : 0
  const btn = $('#flipbtn')
  if (btn) {
    btn.classList.toggle('on', S.flipped)
    btn.textContent = S.flipped ? '倒置' : '正置'
  }
  applyTopNormalize(S.view)
}

// 取景：按当前视口比例算“刚好装下整棵建木”的相机距离，再按 fill 收紧。
// fill 越大越贴边；0.74 ≈ 树占画面七成高（老版固定 252，看着偏小）。
function treeSpan() {
  const H = S.stats ? S.stats.tree.height : 88
  let maxR = 0
  if (S.radBase) for (let i = 0; i < S.n; i++) if (S.radBase[i] > maxR) maxR = S.radBase[i]
  return { halfH: H * 0.5 + 3, maxR: (maxR || 62) + 4 }
}
function fitDistance(fill = 0.74) {
  const { halfH, maxR } = treeSpan()
  const vf = Math.tan((camera.fov * Math.PI / 180) / 2)
  const needH = halfH / vf
  const needW = maxR / (vf * Math.max(0.55, camera.aspect))
  return Math.max(needH, needW) / fill
}

// 俯视相机高度：layout 归一化用同一个值，改这里两边一起变
const TOP_CAM_Y = 230

function setView(v, keepAuto) {
  const H = S.stats ? S.stats.tree.height : 88
  if (!keepAuto) controls.autoRotate = false
  if (S.focus) {
    if (S.focusHi >= 0 && S.geo) {
      const hi = S.geo.getAttribute('aHi'); hi.array[S.focusHi] = 0; hi.needsUpdate = true
    }
    S.focus = null; S.focusHi = -1; S.prevView = null; S.camAnim = null
    const btn = $('#focusreset'); if (btn) btn.style.display = 'none'
  }
  S.view = v
  applyViewTone(v)
  if (v === 'top') {
    camera.up.set(0, 0, -1)
    camera.position.set(0.01, TOP_CAM_Y, 0.01)
    controls.target.set(0, H * 0.5, 0)
    controls.maxDistance = Math.max(TOP_CAM_Y, 240)
  } else {
    const D = fitDistance(0.74)
    const az = (AZ0 || 0) * Math.PI / 180
    const dir = new THREE.Vector3(Math.sin(az), 0.20, Math.cos(az)).normalize()
    camera.up.set(0, 1, 0)
    controls.target.set(0, H * 0.5, 0)
    camera.position.copy(controls.target).addScaledVector(dir, D)
    // 想拉远看全貌也够用，但不让用户把树缩成一粒米
    controls.maxDistance = Math.max(240, D * 1.5)
  }
  controls.update()
  for (const b of $('#view').children) b.classList.toggle('on', b.dataset.v === v)
}
$('#view').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-v]')
  if (btn) setView(btn.dataset.v)
})
$('#focusreset').onclick = () => resetFocus(true)
$('#flipbtn').onclick = () => { S.flipped = !S.flipped; applyFlip() }

// ── 全屏：按钮 + Esc 退出 ────────────────────────────────
// 三条路，按可用性依次尝试：
//   1) 浏览器原生 Fullscreen API（独立打开时最完整，Esc 原生退出）；
//   2) 内嵌且同源：直接把自己的 iframe 框改成 fixed 铺满父窗口（不用宿主配合，立即生效）；
//   3) 跨源内嵌：postMessage 请 client.js 把 iframe 撑满（刷新 DSH 后可用）。
// Esc 都由页面自己监听，两条兜底路径按钮文案一致。
const fsBtn = $('#fsbtn')
let fsFake = false
let frameFsSaved = null
function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null
}
function isFs() { return fsFake || Boolean(fsElement()) }
function postFsToHost(on) {
  if (!EMBED) return
  try { parent.postMessage({ type: 'jianmu-starmap:fullscreen', on }, '*') } catch { /* ignore */ }
}
// 同源 iframe：直接改 frameElement 与宿主 wrapper 的样式；成功返回 true
function applyFrameFs(on) {
  if (!EMBED) return false
  let fe = null
  try { fe = window.frameElement } catch { fe = null }
  if (!fe) return false
  if (on) {
    if (frameFsSaved) return true
    const wrap = fe.parentElement
    frameFsSaved = {
      feStyle: fe.getAttribute('style') || '',
      wrap,
      wrapStyle: wrap ? (wrap.getAttribute('style') || '') : null,
    }
    fe.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147482000;border:0;border-radius:0;background:#04070e'
    if (wrap) {
      wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;z-index:2147481999;' +
        'background:#04070e;margin:0;padding:0;max-width:none;max-height:none;overflow:hidden;border-radius:0'
    }
    return true
  }
  const saved = frameFsSaved
  frameFsSaved = null
  if (!saved) return false
  try { fe.setAttribute('style', saved.feStyle) } catch { /* ignore */ }
  if (saved.wrap) {
    try {
      if (saved.wrapStyle === null) saved.wrap.removeAttribute('style')
      else saved.wrap.setAttribute('style', saved.wrapStyle)
    } catch { /* ignore */ }
  }
  return true
}
function enterFakeFs() {
  fsFake = true
  if (!applyFrameFs(true)) postFsToHost(true)
  syncFsBtn()
}
function exitFakeFs() {
  fsFake = false
  if (!applyFrameFs(false)) postFsToHost(false)
  syncFsBtn()
}
async function requestNativeFs() {
  const el = document.documentElement
  if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
  else throw new Error('浏览器不支持全屏')
}
async function exitNativeFs() {
  if (document.exitFullscreen) await document.exitFullscreen()
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
}
async function toggleFullscreen() {
  // 已经在全屏 → 退出
  if (fsFake) { exitFakeFs(); return }
  if (fsElement()) { try { await exitNativeFs() } catch { /* ignore */ } return }
  try {
    await requestNativeFs()
  } catch (err) {
    // 原生被拒（最常见：DSH 的 iframe 没放行 fullscreen / 窗口未聚焦）
    // 内嵌场景退到「铺满宿主窗口」；独立页面则提示一次并保持原样
    if (EMBED) {
      enterFakeFs()
    } else {
      const m = $('#msg')
      if (m) m.textContent = '浏览器拒绝了全屏请求（窗口未聚焦时常见）'
      console.warn('fullscreen failed', err)
    }
  }
}
function syncFsBtn() {
  const on = isFs()
  if (fsBtn) {
    fsBtn.classList.toggle('on', on)
    fsBtn.textContent = on ? '退出' : '全屏'
    fsBtn.title = on ? '退出全屏（Esc）' : '全屏（Esc 退出）'
  }
  document.body.classList.toggle('is-fs', on)
  // 个别宿主切全屏不触发 resize，这里补一次投影/画布尺寸
  requestAnimationFrame(() => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
    composer.setSize(innerWidth, innerHeight)
  })
}
if (fsBtn) fsBtn.onclick = toggleFullscreen
document.addEventListener('fullscreenchange', syncFsBtn)
document.addEventListener('webkitfullscreenchange', syncFsBtn)
// 宿主（client.js）在 Esc / 自己的按钮里要求退出铺满
addEventListener('message', (e) => {
  const d = e.data
  if (!d || d.type !== 'jianmu-starmap:fullscreen-exit') return
  if (fsFake) exitFakeFs()
})
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (fsFake) { exitFakeFs(); return }
  if (!fsElement()) return
  try { exitNativeFs().catch(() => {}) } catch { /* ignore */ }
})
// 页面若在「铺满」状态被销毁，把宿主样式还原，别把 DSH 面板留在 fixed 状态
addEventListener('pagehide', () => { if (frameFsSaved) { try { applyFrameFs(false) } catch { /* ignore */ } } })

// ── 人格切换 ────────────────────────────────────────────
$('#persona').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-p]')
  if (!btn) return
  const p = btn.dataset.p
  if (p === S.persona && S.points) return
  for (const b of $('#persona').children) b.classList.toggle('on', b === btn)
  loadPersona(p).catch((err) => fail(err))
})

// ── 循环 ────────────────────────────────────────────────
function tick(now) {
  requestAnimationFrame(tick)
  const dt = now - S.last
  S.frames++
  if (dt > 1000) {
    S.fps = Math.round((S.frames * 1000) / dt); S.frames = 0; S.last = now
    $('#p-fps').textContent = `${S.fps}fps`
  }
  const tNow = now / 1000 + (S.timeOffset || 0) + TIME0
  if (S.mat) S.mat.uniforms.uTime.value = tNow
  // AR 遥测：每 6 帧更新一次方位/仰角/距离
  if ((S.telTick = (S.telTick || 0) + 1) % 6 === 0) updateTelemetry()
  for (const o of S.env) if (o.material && o.material.uniforms && o.material.uniforms.uTime) o.material.uniforms.uTime.value = tNow
  if (S.ringMat) S.ringMat.uniforms.uTime.value = tNow
  if (S.scan) S.scan.rotation.y = -now / 1000 * 0.22
  if (nebulaMesh) nebulaMesh.rotation.y = NEB_ROT + now / 1000 * 0.005
  if (nebulaMesh2) nebulaMesh2.rotation.y = NEB_ROT - 0.6 + now / 1000 * 0.0035
  // 星云薄雾：绕原位缓慢漂浮 + 云团自转（不改变拾取，纯背景）
  for (const spr of S.wisps) {
    const u = spr.userData
    spr.position.x = u.bx + Math.sin(tNow * 0.045 + u.phase) * u.drift
    spr.position.z = u.bz + Math.cos(tNow * 0.038 + u.phase * 1.7) * u.drift
    spr.material.rotation = u.spin * tNow
  }
  // 近景星芒：跟着公转 + 明灭呼吸
  for (const spr of S.flareSprites) {
    const u = spr.userData
    const ang = u.a + tNow * u.spin
    spr.position.x = Math.cos(ang) * u.r
    spr.position.z = Math.sin(ang) * u.r
    spr.material.opacity = u.base * (S.atmosScale ? S.atmosScale.wisp : 1) * (0.50 + 0.50 * Math.sin(tNow * u.speed + u.phase))
  }
  // 镜头推近 / 回退
  if (S.camAnim) {
    const k = Math.min(1, (now - S.camAnim.start) / S.camAnim.dur)
    const e = k * k * (3 - 2 * k)
    camera.position.lerpVectors(S.camAnim.p0, S.camAnim.p1, e)
    controls.target.lerpVectors(S.camAnim.t0, S.camAnim.t1, e)
    if (k >= 1) S.camAnim = null
  }
  // 聚焦跟随：星点在转，镜头跟着平移，保持局部在画面里
  if (S.focus && S.mat) {
    const p = worldAt(S.focus.idx, S.mat.uniforms.uTime.value)
    if (!S.camAnim) {
      const d = p.clone().sub(S.focus.last)
      camera.position.add(d); controls.target.add(d)
    }
    S.focus.last.copy(p)
  }
  controls.update()
  composer.render()
}

// ── AR 遥测读数（只是显示，不影响视角）────────────────────
function updateTelemetry() {
  const dx = camera.position.x - controls.target.x
  const dy = camera.position.y - controls.target.y
  const dz = camera.position.z - controls.target.z
  const az = (Math.atan2(dx, dz) * 57.2957795 + 360) % 360
  const el = Math.atan2(dy, Math.hypot(dx, dz)) * 57.2957795
  const rng = Math.hypot(dx, dy, dz)
  const a = $('#t-az'), e = $('#t-el'), r = $('#t-rng')
  if (a) a.textContent = az.toFixed(1).padStart(5, '0') + '°'
  if (e) e.textContent = (el >= 0 ? '+' : '') + el.toFixed(1) + '°'
  if (r) r.textContent = String(Math.round(rng)).padStart(3, '0')
}

function fail(e) {  const el = $('#err')
  el.style.display = 'block'
  el.innerHTML = `星图加载失败<br><span style="color:#8ea3c8;font-size:11px">${String((e && e.message) || e)}</span>`
  console.error(e)
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  composer.setSize(innerWidth, innerHeight)
  if (S.mat) S.mat.uniforms.uPR.value = renderer.getPixelRatio()
  if (S.ringMat) S.ringMat.uniforms.uPR.value = renderer.getPixelRatio()
  // 视口尺寸变了（尤其是进/出全屏）→ 斜视重新取景，免得全屏后树显得变小
  if (S.stats && S.view === 'iso' && !S.focus) {
    try {
      const D = fitDistance(0.74)
      const dir = camera.position.clone().sub(controls.target)
      if (dir.lengthSq() > 1e-6) {
        dir.normalize()
        camera.position.copy(controls.target).addScaledVector(dir, D)
        controls.maxDistance = Math.max(240, D * 1.5)
        controls.update()
      }
    } catch { /* ignore */ }
  }
})

// ── 星图重建（A1）：POST /build + 轮询 build-status ──────────────
const BUILD_URL = `${STARMAP_API}/build`
const BUILD_STATUS_URL = `${STARMAP_API}/build-status`
let buildPoll = null

function setBuildUi(running, text, tail) {
  const btn = $('#buildbtn'), msg = $('#buildmsg')
  if (btn) { btn.disabled = !!running; btn.textContent = running ? '重建中…' : '重建星图' }
  if (msg) { msg.textContent = text || ''; msg.title = tail || text || '' }
}

function stopBuildPoll() {
  if (buildPoll) { clearInterval(buildPoll); buildPoll = null }
}

async function fetchBuildStatus() {
  const r = await fetch(`${BUILD_STATUS_URL}?t=${Date.now()}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`build-status ${r.status}`)
  return r.json()
}

async function refreshAfterBuild() {
  try {
    await loadPersona(S.persona)
    await syncPersonaButtons()
    const pts = $('#p-pts') ? $('#p-pts').textContent : ''
    setBuildUi(false, `完成 · ${pts} 点`)
  } catch (e) {
    setBuildUi(false, `构建完成，但刷新失败：${e.message}`)
    fail(e)
  }
}

async function pollBuild() {
  stopBuildPoll()
  let done = false
  const tick = async () => {
    if (done) return
    let s
    try {
      s = await fetchBuildStatus()
    } catch (e) {
      done = true; stopBuildPoll(); setBuildUi(false, `状态查询失败：${e.message}`); return
    }
    if (s.running) {
      setBuildUi(true, `重建中… ${Math.round((Number(s.elapsedMs) || 0) / 1000)}s`)
      return
    }
    done = true
    stopBuildPoll()
    if (s.ok) {
      setBuildUi(false, '完成，刷新中…')
      await refreshAfterBuild()
    } else {
      const lines = String(s.tail || '').split('\n').map((x) => x.trim()).filter(Boolean)
      const tail = lines.slice(-3).join(' / ')
      setBuildUi(false, `失败（${s.code || '未知'}）${tail ? '：' + tail : ''}`, tail)
      console.warn('[starmap] 构建失败', s.tail || '')
    }
  }
  await tick()
  if (!done) buildPoll = setInterval(() => { tick().catch(() => {}) }, 2000)
}

async function startBuild() {
  const btn = $('#buildbtn')
  if (btn && btn.disabled) return
  if (!confirm('从最新 claim 重建星图？\n\n· 只写本机 <dataRoot>/starmap\n· 约 1–3 分钟，期间可继续看旧数据\n· 会重建全部人格')) return
  setBuildUi(true, '正在启动…')
  try {
    const r = await fetch(`${BUILD_URL}?confirm=1`, { method: 'POST', cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (r.status === 409) {
      setBuildUi(true, '已有一个构建在跑，接上进度…')
    } else if (!r.ok) {
      setBuildUi(false, `启动失败：${j?.error?.message || r.status}`)
      return
    }
    await pollBuild()
  } catch (e) {
    setBuildUi(false, `启动失败：${e.message}`)
  }
}

{ const bb = $('#buildbtn'); if (bb) { if (EMBED) bb.onclick = () => { startBuild() }; else bb.style.display = 'none' } }

async function syncPersonaButtons() {
  if (!EMBED) return
  try {
    const st = await fetch(`${STARMAP_API}/status`, { cache: 'no-store' }).then((r) => r.json())
    const list = st.personas || []
    if (!list.length) return
    const wrap = $('#persona')
    wrap.innerHTML = ''
    for (const per of list) {
      const btn = document.createElement('button')
      btn.dataset.p = per.id
      btn.textContent = per.displayName || DISPLAY[per.id] || per.id
      if (per.id === S.persona) btn.classList.add('on')
      wrap.appendChild(btn)
    }
  } catch { /* 保留静态按钮 */ }
}

async function waitBuildDone(limitMs = 600000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    let s
    try { s = await fetchBuildStatus() } catch { return }
    if (!s.running) return
    setBuildUi(true, `重建中… ${Math.round((Number(s.elapsedMs) || 0) / 1000)}s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function boot() {
  let pid = PERSONA_PARAM
  if (EMBED) {
    try {
      const st = await fetch(`${STARMAP_API}/status`, { cache: 'no-store' }).then((r) => r.json())
      const list = st.personas || []
      // 默认打开列表第一个人格；alice 只是测试夹具，真实用户没有这个名字
      if (!pid && list.length) pid = list[0].id
    } catch { /* ignore */ }
  }
  // 后台重建可能正在重写 stats/meta/bin：先探一次，别把半成品当故障
  let bootBuilding = false
  if (EMBED) {
    try {
      const bs = await fetchBuildStatus()
      bootBuilding = !!bs.running
      if (bootBuilding) setBuildUi(true, `重建中… ${Math.round((Number(bs.elapsedMs) || 0) / 1000)}s`)
    } catch { /* 老版本没有 build-status 端点就忽略 */ }
  }
  if (!pid) {
    const ee = $('#err')
    if (ee) { ee.style.display = 'block'; ee.textContent = '还没有星图数据：先到「年轮」页生成一次，或点侧栏「星图」里的「重建星图」。' }
    const sb = $('#subtitle'); if (sb) sb.textContent = '暂无数据'
    return
  }
  let loaded = false
  try {
    await loadPersona(pid)
    loaded = true
  } catch (e) {
    if (!bootBuilding) throw e
  }
  if (bootBuilding) {
    if (!loaded) {
      setBuildUi(true, '构建中，完成后自动加载…')
      await waitBuildDone()
      await loadPersona(pid)
      setBuildUi(false, '已完成')
    } else {
      setBuildUi(true, '构建进行中，完成后自动刷新…')
      pollBuild().catch(() => {})
    }
  }
  await syncPersonaButtons()
  { const seg = $('#theme'); if (seg) for (const b of seg.children) b.classList.toggle('on', b.dataset.t === THEME_ID) }
  { const tag = $('#themeTag'); if (tag) tag.textContent = THEME_ID === 'gold' ? 'BLACK GOLD' : 'ROSE GOLD' }
  if (VIEW0 === 'top') setView('top')
  else setView('iso', true)   // 保留相机自转；只做一次自适应取景
  requestAnimationFrame(tick)
}

window.__starmap = { S, pick, showCard, loadPersona, applySearch, applyTime, toggleIsolate, setView, camera, controls, renderer,
  get nebulaMesh() { return nebulaMesh }, get nebulaMesh2() { return nebulaMesh2 } }
boot().catch(fail)
