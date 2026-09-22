/**
 * mermaid 放大浮层（C2）
 *
 * 刻意**不引第三方 lightbox**：只需要「放大/缩小 + 拖动平移 + 下载 + 关闭」几件事，
 * 自己实现即可，且不引入新的依赖与样式冲突（缩放 / 平移全部自实现，零依赖）。
 *
 * 三种关闭方式：**ESC / 点遮罩 / ✕**（PRD §2.3）。
 *
 * ## 几何模型（第五轮-2 重写，务必看完再改）
 *
 * 画布（`.preview-mermaid-zoom-canvas`）**只表达自然尺寸**：布局宽高恒等于
 * `natural.w × natural.h`（viewBox 尺寸），**不随 scale 变**；缩放全部交给
 * `transform: translate(x, y) scale(s)`，且 `transform-origin: 0 0`。
 * 于是「画布局部坐标 → body 局部坐标」只有**一条**式子：
 *
 * ```
 * screen = t + s · content        （t = (x, y)，content 为画布局部坐标）
 * ```
 *
 * 缩放锚点就由这条式子直接反解 —— 令锚点 `p` 下的内容坐标不变：
 *
 * ```
 * contentPt = (p − t) / sOld
 * tNew      = p − contentPt · sNew
 * ```
 *
 * ⚠️ 上一轮的实现同时用**布局尺寸**和 `transform: scale()` 表达缩放，且靠
 * `margin:auto` 居中：一旦画布尺寸超过 body，flex 的 auto margin 只吃**正**
 * 的剩余空间 → 负值退化成 0 → 画布瞬间贴到 body 左上角。这就是用户报的
 * 「不管双击、点按钮还是滚轮，都是从左上角为中心放大缩小」的根因。
 * 现在画布尺寸恒定、原点固定在 (0,0)、缩放只走 transform，锚点是**算**出来的，
 * 不再依赖 flex 的居中行为。
 *
 * 平移：鼠标**按住图面拖动**（光标 grab / grabbing，拖拽时禁用过渡），
 * 位移钳制在**一个视口尺寸**内（保证图面中心不离开视口，拖不丢）；Reset 同样能拉回来。
 *
 * 传入的 `svgHtml` 已由 UI 层把 `<style>` 重新作用域到
 * {@link MERMAID_ZOOM_BODY_CLASS}（浮层容器），因此这里直接内联即可，
 * **不要再过** `sanitizeHtml`（那份白名单不含 svg）。
 *
 * @module MermaidZoomOverlay
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  MERMAID_ZOOM_CLASS,
  MERMAID_ZOOM_MASK_CLASS,
  MERMAID_ZOOM_BODY_CLASS,
} from '../lib/mermaid-preview';

export interface MermaidZoomState {
  /** 已清洗且**已作用域化到浮层容器**的 SVG 字符串（只用于**内联显示**） */
  svgHtml: string;
  /**
   * **未作用域化**且已补齐 `xmlns` 的 SVG —— **仅用于下载/导出**。
   *
   * ⚠️ 不能下载上面那份：它的 `<style>` 选择器被加成了
   * `.preview-mermaid-zoom-body .node rect {…}`，一旦存成 `.svg` 脱离浮层单独打开，
   * 那个祖先不存在 → **整份图 CSS 失配** → 节点退回默认填充（用户实测「一片黑块」）。
   */
  rawSvgHtml: string;
}

interface MermaidZoomOverlayProps {
  /** 当前浮层内容；null = 关闭 */
  state: MermaidZoomState | null;
  /** 关闭浮层 */
  onClose: () => void;
  /** 下载 SVG */
  onDownload: (svgHtml: string) => void;
}

/** 缩放上下限（相对 scale） */
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
/** 每次点击放大 / 缩小的步进 */
const SCALE_STEP = 0.25;
/** fit 的下限：超大图要能缩到**看得全**，不能被手动缩放的下限 0.5 卡住 */
const MIN_FIT_SCALE = 0.05;
/**
 * fit 的上限 = **1**：不放大超过 100%。
 * 用户规格：「弹窗宽高超过图形的 100% 就按 100% 显示」——小图不做放大凑版面。
 */
const MAX_FIT_SCALE = 1;
/**
 * 弹窗占窗口的比例（第五轮-2 用户规格：**固定** 90%，上下左右各留 5%）。
 *
 * ⚠️ 这一轮之前 75% 是「上限」、且面板会**贴合图形**收缩 —— 用户实测反馈
 * 「弹窗在跟着图形大小在跟着变动，感觉奇奇怪怪的」，要求改成恒定 90%。
 * 现在面板尺寸纯由 CSS（`width:90vw; height:90vh`）决定，JS **不再**写内联宽度；
 * 这个常量只用于「窗口还没布局完」时的兜底预算，与 CSS 保持同一个数。
 */
const PANEL_RATIO = 0.9;
/** 舞台里图形的实际占比（其余即四边留白 → 上下左右各约 5%） */
const FIT_MARGIN = 0.9;
/** 滚轮每格缩放系数 */
const WHEEL_STEP = 1.12;
/** 双击放大系数 */
const DOUBLE_STEP = 1.6;
/**
 * body 的 padding 已归零（画布是绝对定位、以 body padding-box 左上角为原点，
 * 留白改由 {@link FIT_MARGIN} 表达）—— 保留常量仅为文档化该事实。
 */
const BODY_PAD = 0;
/**
 * 面板边框(2) + body 两侧 padding({@link BODY_PAD})：由舞台尺寸折算面板尺寸的补偿。
 * 现在只用于「body 量不到尺寸」时的窗口兜底预算。
 */
const PANEL_FRAME = 2 + BODY_PAD;
/**
 * 面板宽度的下限（px）见 CSS `min-width: min(360px, 98vw)` 处注释 —— 头部行 5 个按钮
 * 实测最少要 306px；面板改成恒定 90vw 后，极窄窗口的兜底策略也在那里（最多退到 98vw，
 * 绝不撑破视口，以保证「点非弹窗区域关闭」这个出口始终存在）。
 */
/** 平移边界兜底值（px）：仅在拿不到 body 尺寸时使用；正常走视口尺寸约束 */
const MAX_PAN = 2000;

/** 视图状态：缩放 + 平移。平移量是**body 局部坐标**下的 px（画布原点相对 body 左上角） */
interface ViewState {
  scale: number;
  x: number;
  y: number;
}

/** 数值钳制 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 保留两位小数，避免 0.30000000000000004 这类值进 transform */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 读 SVG 的**固有尺寸**（不受当前 transform 影响）。
 *
 * 优先 `viewBox`（mermaid 产出基本都带，且是图坐标空间的真实尺寸），
 * 其次 `width/height` 属性，最后兜底 `getBoundingClientRect`。
 *
 * @param svg SVG 根元素
 * @returns 固有宽高；读不到返回 null
 */
function readNaturalSize(svg: SVGSVGElement): { w: number; h: number } | null {
  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }
  const wAttr = Number.parseFloat(svg.getAttribute('width') ?? '');
  const hAttr = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(wAttr) && Number.isFinite(hAttr) && wAttr > 0 && hAttr > 0) {
    return { w: wAttr, h: hAttr };
  }
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { w: rect.width, h: rect.height };
  }
  return null;
}

export default function MermaidZoomOverlay({ state, onClose, onDownload }: MermaidZoomOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 头部行：fit 时要扣掉它的高度（它占掉了 75% 预算里的一段） */
  const barRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  /** 拖动起点的快照（用 ref，避免每次 move 触发额外渲染闭包） */
  const dragRef = useRef({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });
  /** 图的固有尺寸（viewBox）：null = 还没量到（此时舞台不设尺寸，等下一帧） */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /**
   * 当前「刚好铺满可用空间」的视图（缩放 + 居中平移）；Reset 直接还原**这个对象**，
   * 所以「Reset 后的 scale 与打开时完全一致」是**构造性保证**，不是靠两次算得一样。
   */
  const fitRef = useRef<ViewState>({ scale: 1, x: 0, y: 0 });

  /**
   * 读 body 的可用尺寸（画布的定位基准 = body padding-box，body 无 padding 无边框，
   * 所以 == 内容区）。量不到时按窗口 90% 兜底（与 CSS 的 `width:90vw/height:90vh` 同源）。
   */
  const readBodySize = useCallback(() => {
    const body = bodyRef.current;
    if (body && body.clientWidth > 0 && body.clientHeight > 0) {
      return { w: body.clientWidth, h: body.clientHeight };
    }
    const barH = barRef.current?.offsetHeight ?? 0;
    return {
      w: Math.max(window.innerWidth * PANEL_RATIO - PANEL_FRAME, 1),
      h: Math.max(window.innerHeight * PANEL_RATIO - PANEL_FRAME - barH, 1),
    };
  }, []);

  /**
   * 算出「图形完整可见、不变形、四边各留约 5% 且**居中**」的视图。
   *
   * 面板尺寸现在是 CSS 常量（90vw × 90vh），**不随图形变**，所以 body 的
   * clientWidth/Height 在 fit 的那一刻就是真值，读它不会引入上一轮那个漂移
   * （老代码里面板宽度是 JS 算的，读了就会「打开时 2.06、按 Reset 却变 1.56」）。
   *
   * 两条用户规格：
   * - 弹窗恒定 90%（上下左右各留 5%）—— 见 {@link PANEL_RATIO}；
   * - 图形放大**不超过 100%**（{@link MAX_FIT_SCALE} = 1）。
   */
  const fitView = useCallback(() => {
    if (!natural) return;
    const { w: bw, h: bh } = readBodySize();
    const raw = Math.min((bw * FIT_MARGIN) / natural.w, (bh * FIT_MARGIN) / natural.h);
    const scale = round2(clamp(Math.min(raw, MAX_FIT_SCALE), MIN_FIT_SCALE, MAX_FIT_SCALE));
    const next: ViewState = {
      scale,
      // 画布尺寸恒为自然尺寸，缩放后视觉尺寸 = natural * scale，居中即此
      x: round2((bw - natural.w * scale) / 2),
      y: round2((bh - natural.h * scale) / 2),
    };
    fitRef.current = next;
    setView(next);
  }, [natural, readBodySize]);

  // 打开 / 切换图 → 复位，并**先量**图的固有尺寸（state 每次打开都是新对象）
  useEffect(() => {
    if (!state) return;
    setView({ scale: 1, x: 0, y: 0 });
    setDragging(false);
    setNatural(null);
    fitRef.current = { scale: 1, x: 0, y: 0 };

    // ⚠️ 这里**只量尺寸**，不算 fit：此时 SVG 刚进 DOM，量到的才是 viewBox 真值；
    // fit 由下面那个依赖 natural 的 effect 在 rAF 里做（保持「先量后算」两段式，
    // 避免把上一次的漂移 bug 改回来）。
    const measure = () => {
      const svg = bodyRef.current?.querySelector('svg');
      if (!svg) return;
      const size = readNaturalSize(svg);
      if (size) setNatural(size);
    };
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  // 固有尺寸**落地之后**再算 fit（此时面板尺寸与 viewBox 都已是真值）
  useEffect(() => {
    if (!state || !natural) return;
    const raf = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(raf);
  }, [state, natural, fitView]);

  // 窗口 resize → 重新 fit（90% 面板跟着窗口变，缩放与居中平移都要重算）
  useEffect(() => {
    if (!state || !natural) return;
    const handleResize = () => fitView();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [state, natural, fitView]);

  /**
   * **带锚点**的缩放（全部缩放路径的唯一入口）。
   *
   * @param anchorX 锚点 x（**body 局部坐标**：body 左上角为原点，px）
   * @param anchorY 锚点 y
   * @param nextScaleOf 由当前缩放算出目标缩放；外面统一 clamp + round2
   *
   * 锚点不变式：`p = t + s · contentPt` 中的 `contentPt` 缩放前后保持恒定
   * → `tNew = p − ((p − tOld) / sOld) · sNew`。
   *
   * ⚠️ 写成**纯 updater**（不在里面 setState / 不读外部可变值）：React StrictMode
   * 会把 updater 跑两遍，带副作用的写法会算出错误的平移量。
   */
  const applyZoom = useCallback(
    (anchorX: number, anchorY: number, nextScaleOf: (current: number) => number) => {
      setView((v) => {
        const scale = round2(clamp(nextScaleOf(v.scale), MIN_SCALE, MAX_SCALE));
        if (scale === v.scale) return v;
        const contentX = (anchorX - v.x) / v.scale;
        const contentY = (anchorY - v.y) / v.scale;
        return {
          scale,
          x: round2(anchorX - contentX * scale),
          y: round2(anchorY - contentY * scale),
        };
      });
    },
    [],
  );

  /** 把视口坐标（clientX/Y）换算成 body 局部坐标（锚点换算的公共前置） */
  const toBodyPoint = useCallback((clientX: number, clientY: number) => {
    const body = bodyRef.current;
    if (!body) return null;
    const rect = body.getBoundingClientRect();
    return {
      x: clientX - rect.left + body.scrollLeft,
      y: clientY - rect.top + body.scrollTop,
    };
  }, []);

  /** 按钮（＋ / −）的锚点：body **可视区中心**（用户规格：点按钮按窗口中心缩放） */
  const bodyCenter = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return null;
    return { x: body.clientWidth / 2, y: body.clientHeight / 2 };
  }, []);

  // 滚轮缩放（第三轮反馈：只点按钮不方便）→ 锚点 = **光标位置**。
  // ⚠️ 必须用**原生**监听 + `{ passive: false }`：React 的 onWheel 是 passive 的，
  // 里面 preventDefault 无效且会告警 —— 那样滚动会穿透到下面的预览区。
  useEffect(() => {
    if (!state) return;
    const body = bodyRef.current;
    if (!body) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toBodyPoint(e.clientX, e.clientY);
      if (!p) return;
      const factor = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      applyZoom(p.x, p.y, (s) => s * factor);
    };
    body.addEventListener('wheel', handleWheel, { passive: false });
    return () => body.removeEventListener('wheel', handleWheel);
  }, [state, applyZoom, toBodyPoint]);

  // ESC 关闭 + 打开时把焦点移进浮层（键盘可达性）
  useEffect(() => {
    if (!state) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    panelRef.current?.focus();

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [state, onClose]);

  /** ＋：以 body 中心为锚点放大一档 */
  const zoomIn = useCallback(() => {
    const c = bodyCenter();
    if (!c) return;
    applyZoom(c.x, c.y, (s) => Math.round((s + SCALE_STEP) * 100) / 100);
  }, [applyZoom, bodyCenter]);

  /** −：以 body 中心为锚点缩小一档 */
  const zoomOut = useCallback(() => {
    const c = bodyCenter();
    if (!c) return;
    applyZoom(c.x, c.y, (s) => Math.round((s - SCALE_STEP) * 100) / 100);
  }, [applyZoom, bodyCenter]);

  /**
   * 复位：回到「刚好铺满」的适配视图（不是硬性 100%）。
   *
   * ⚠️ 直接还原 fitRef 里**缓存的对象**，而不是重算一遍 —— 这样「Reset 后的 scale
   * 与打开时完全一致（差 0）」是构造性成立的，不受任何中间布局抖动影响。
   */
  const resetView = useCallback(() => {
    setView(fitRef.current);
  }, []);

  /** 双击图面：以**光标**为锚点，在「适配」与「再放大一档」之间来回切 */
  const toggleZoom = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const p = toBodyPoint(e.clientX, e.clientY);
      if (!p) return;
      const base = fitRef.current.scale;
      applyZoom(p.x, p.y, (s) => (s > base * 1.05 ? base : s * DOUBLE_STEP));
    },
    [applyZoom, toBodyPoint],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // 只认主键
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        baseX: view.x,
        baseY: view.y,
      };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [view.x, view.y],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d.active) return;
    // 边界约束按**视口尺寸**算（不是固定 4000px）：最多平移一个视口，
    // 保证图面中心始终留在视口内 —— 拖不丢；再配 Reset 兜底。
    const body = bodyRef.current;
    const limitX = body ? body.clientWidth : MAX_PAN;
    const limitY = body ? body.clientHeight : MAX_PAN;
    setView((v) => ({
      ...v,
      x: clamp(d.baseX + (e.clientX - d.startX), -limitX, limitX),
      y: clamp(d.baseY + (e.clientY - d.startY), -limitY, limitY),
    }));
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  if (!state) return null;

  const { scale, x: offsetX, y: offsetY } = view;
  const percent = Math.round(scale * 100);

  return (
    <div className={MERMAID_ZOOM_CLASS} role="dialog" aria-modal="true" aria-label="Mermaid diagram">
      {/* 遮罩：点击即关闭（点面板本身不关 —— 面板是遮罩的**兄弟**节点，
          点击不会冒泡到遮罩上，无需 stopPropagation）。
          ⚠️ 遮罩铺满 inset:0，面板恒定 90% → 四周那 5% 边距就是可点的遮罩区。 */}
      <div
        className={MERMAID_ZOOM_MASK_CLASS}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* ⚠️ 不再写内联 width：面板尺寸恒定 = 视口 90%（CSS `width:90vw/height:90vh`），
          不随图形大小变化（第五轮-2 用户反馈「弹窗跟着图形变，感觉奇奇怪怪的」）。 */}
      <div
        className="preview-mermaid-zoom-panel"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="preview-mermaid-zoom-bar" ref={barRef}>
          <span className="preview-mermaid-zoom-title">Diagram · {percent}%</span>
          <div className="preview-mermaid-zoom-actions">
            <button
              type="button"
              className="preview-mermaid-zoom-btn"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="preview-mermaid-zoom-btn"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              aria-label="Zoom in"
            >
              ＋
            </button>
            <button
              type="button"
              className="preview-mermaid-zoom-btn"
              onClick={resetView}
              aria-label="Reset view"
            >
              Reset
            </button>
            <button
              type="button"
              className="preview-mermaid-zoom-btn"
              onClick={() => onDownload(state.rawSvgHtml)}
            >
              Download SVG
            </button>
            <button
              type="button"
              className="preview-mermaid-zoom-btn preview-mermaid-zoom-close"
              onClick={onClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div
          className={`${MERMAID_ZOOM_BODY_CLASS}${dragging ? ' is-dragging' : ''}`}
          ref={bodyRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={toggleZoom}
        >
          <div
            className="preview-mermaid-zoom-canvas"
            // 几何模型（详见文件头注释）：布局尺寸**恒等于自然尺寸**，缩放全部交给
            // transform，`transform-origin: 0 0` ⇒ 局部点 p 落在 t + s·p。
            // ⚠️ 画布**不再**用布局尺寸表达缩放：那会让 flex 的 `margin:auto`
            // 在负剩余空间时退化成 0 → 画布贴左上角 → 用户看到的「从左上角缩放」。
            style={
              natural
                ? {
                    width: natural.w,
                    height: natural.h,
                    transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
                  }
                : { transform: `translate(${offsetX}px, ${offsetY}px)` }
            }
            // SVG 已由 mermaid-sanitize 的独立 Purify 实例清洗过，且 <style> 已作用域到
            // 本容器（MERMAID_ZOOM_BODY_CLASS），不再过 sanitizeHtml
            dangerouslySetInnerHTML={{ __html: state.svgHtml }}
          />
        </div>
      </div>
    </div>
  );
}
