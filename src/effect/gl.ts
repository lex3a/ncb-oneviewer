/**
 * Minimal WebGL2 back end for the effect player: textured, vertex-coloured triangles submitted in
 * screen space. Projection happens on the CPU (like the PSP's GE transform); each vertex carries its
 * clip w so the GPU interpolates UVs perspective-correctly.
 */
import type { RgbaImage } from '../formats/palette'

export type BlendMode = 'alpha' | 'add' | 'sub' | 'none'

export interface Vertex {
  /** Screen position in virtual pixels (0..width, 0..height, +y down). */
  x: number
  y: number
  /** Clip w (depth along the view axis); 1 for 2D draws. */
  w: number
  /** GE depth / 65535 (0..1; larger is nearer, the GE tests GEQUAL). Interpolated linearly on screen. */
  d?: number
  u: number
  v: number
  /** Per-vertex RGBA 0..1; overrides the colour passed to `triangles` (Gouraud-shaded GE prims). */
  c?: [number, number, number, number]
}

const VS = `#version 300 es
uniform vec2 uScreen;
in vec4 aPos;   // x, y (screen px), w, depth 0..1
in vec2 aUv;
in vec4 aCol;
out vec2 vUv;
out vec4 vCol;
void main() {
  vec2 ndc = vec2(aPos.x / uScreen.x * 2.0 - 1.0, 1.0 - aPos.y / uScreen.y * 2.0);
  gl_Position = vec4(ndc * aPos.z, (aPos.w * 2.0 - 1.0) * aPos.z, aPos.z);
  vUv = aUv;
  vCol = aCol;
}`

const FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform bool uTextured;
in vec2 vUv;
in vec4 vCol;
out vec4 outColor;
void main() {
  vec4 t = uTextured ? texture(uTex, vUv) : vec4(1.0);
  outColor = t * vCol;
  // GE alpha test: GREATER than 0x28.
  if (outColor.a <= 40.0 / 255.0) discard;
}`

export class GlRenderer {
  readonly gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private buf: WebGLBuffer
  private uScreen: WebGLUniformLocation
  private uTextured: WebGLUniformLocation
  private textures = new WeakMap<RgbaImage, WebGLTexture>()
  private data = new Float32Array(4096 * 10)
  private count = 0
  private curTex: WebGLTexture | null = null
  private curBlend: BlendMode = 'alpha'
  smooth = true
  /** Emulate the GE depth buffer (cleared to 0, GEQUAL, writes on). */
  depthTest = true

  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number

  constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.canvas = canvas
    this.width = width
    this.height = height
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false, depth: true, preserveDrawingBuffer: true })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link')
    this.prog = p
    this.buf = gl.createBuffer()!
    this.uScreen = gl.getUniformLocation(p, 'uScreen')!
    this.uTextured = gl.getUniformLocation(p, 'uTextured')!
    gl.useProgram(p)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const stride = 10 * 4
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(p, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4)
    }
    attr('aPos', 4, 0)
    attr('aUv', 2, 4)
    attr('aCol', 4, 6)
  }

  texture(img: RgbaImage): WebGLTexture {
    let t = this.textures.get(img)
    if (t) return t
    const gl = this.gl
    t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.textures.set(img, t)
    return t
  }

  begin(clear: [number, number, number]) {
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(clear[0], clear[1], clear[2], 1)
    gl.clearDepth(0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (this.depthTest) {
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.GEQUAL)
    } else gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.prog)
    gl.uniform2f(this.uScreen, this.width, this.height)
    gl.enable(gl.BLEND)
    this.count = 0
    this.curTex = null
    this.setBlend('alpha', true)
  }

  /** gfxClearDepth mid-frame: flush, clear the depth buffer to 0 and turn the GEQUAL test on or off. */
  depthReset(test: boolean) {
    this.flush()
    const gl = this.gl
    gl.clearDepth(0)
    gl.clear(gl.DEPTH_BUFFER_BIT)
    this.depthTest = test
    if (test) {
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.GEQUAL)
    } else gl.disable(gl.DEPTH_TEST)
  }

  private setBlend(mode: BlendMode, force = false) {
    if (mode === this.curBlend && !force) return
    const gl = this.gl
    this.curBlend = mode
    if (mode === 'none') {
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.ONE, gl.ZERO)
    } else if (mode === 'add') {
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    } else if (mode === 'sub') {
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
    } else {
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    }
  }

  /** Queue triangles (3 vertices each). `color` is RGBA 0..1 applied to every vertex without its own `c`. */
  triangles(tex: WebGLTexture | null, blend: BlendMode, verts: Vertex[], color: [number, number, number, number]) {
    if (tex !== this.curTex || blend !== this.curBlend) {
      this.flush()
      this.curTex = tex
      this.setBlend(blend)
    }
    for (const v of verts) {
      if (this.count * 10 + 10 > this.data.length) this.flush()
      const o = this.count * 10
      const w = v.w > 1e-4 ? v.w : 1e-4
      this.data[o] = v.x
      this.data[o + 1] = v.y
      this.data[o + 2] = w
      this.data[o + 3] = v.d ?? 0.5
      this.data[o + 4] = v.u
      this.data[o + 5] = v.v
      const c = v.c ?? color
      this.data[o + 6] = c[0]
      this.data[o + 7] = c[1]
      this.data[o + 8] = c[2]
      this.data[o + 9] = c[3]
      this.count++
    }
  }

  flush() {
    if (!this.count) return
    const gl = this.gl
    gl.uniform1i(this.uTextured, this.curTex ? 1 : 0)
    if (this.curTex) {
      gl.bindTexture(gl.TEXTURE_2D, this.curTex)
      const f = this.smooth ? gl.LINEAR : gl.NEAREST
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.count * 10), gl.STREAM_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, this.count)
    this.count = 0
  }

  end() {
    this.flush()
  }
}
