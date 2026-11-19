import type { Move, PieceType, Side, Square } from '../types.ts';

const NS = 'http://www.w3.org/2000/svg';

export const CELL = 90;
const LEFT = 40;
const TOP = 40;
const COLS = 9;
const ROWS = 10;

export interface PieceView {
  id: number;
  type: PieceType;
  side: Side;
  file: number;
  rank: number;
}

const GLYPHS: Record<Side, Record<PieceType, string>> = {
  red: { K: '帥', A: '仕', B: '相', N: '馬', R: '車', C: '炮', P: '兵' },
  black: { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' },
};

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

export class BoardView {
  private readonly svg: SVGSVGElement;
  private readonly underLayer: SVGGElement;
  private readonly piecesLayer: SVGGElement;
  private readonly overLayer: SVGGElement;
  private readonly hitLayer: SVGGElement;
  private readonly nodes = new Map<number, SVGGElement>();
  private orientation: Side = 'red';
  private onCell: ((sq: Square) => void) | null = null;

  constructor(svg: SVGSVGElement) {
    this.svg = svg;
    svg.replaceChildren();

    const defs = el('defs');
    const marker = el('marker', {
      id: 'hint-arrow',
      viewBox: '0 0 10 10',
      refX: 8,
      refY: 5,
      markerWidth: 5,
      markerHeight: 5,
      orient: 'auto-start-reverse',
    });
    marker.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'hint-head' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    svg.appendChild(this.buildStatic());

    this.underLayer = el('g', { class: 'under' });
    this.piecesLayer = el('g', { class: 'pieces' });
    this.overLayer = el('g', { class: 'over' });
    this.hitLayer = el('g', { class: 'hits' });
    svg.appendChild(this.underLayer);
    svg.appendChild(this.piecesLayer);
    svg.appendChild(this.overLayer);
    svg.appendChild(this.hitLayer);

    for (let dr = 0; dr < ROWS; dr += 1) {
      for (let df = 0; df < COLS; df += 1) {
        const rect = el('rect', {
          x: LEFT + df * CELL - CELL / 2,
          y: TOP + dr * CELL - CELL / 2,
          width: CELL,
          height: CELL,
          'data-df': df,
          'data-dr': dr,
        });
        this.hitLayer.appendChild(rect);
      }
    }

    this.hitLayer.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      const cell = target?.closest('[data-df]');
      if (!cell) return;
      const df = Number(cell.getAttribute('data-df'));
      const dr = Number(cell.getAttribute('data-dr'));
      const sq =
        this.orientation === 'red'
          ? { file: df, rank: ROWS - 1 - dr }
          : { file: COLS - 1 - df, rank: dr };
      this.onCell?.(sq);
    });
  }

  setCellHandler(handler: (sq: Square) => void): void {
    this.onCell = handler;
  }

  setOrientation(side: Side): void {
    this.orientation = side;
  }

  reset(pieces: PieceView[]): void {
    this.piecesLayer.replaceChildren();
    this.nodes.clear();
    this.sync(pieces, false);
  }

  sync(pieces: PieceView[], animate = true): void {
    if (!animate) this.svg.classList.add('instant');
    const seen = new Set<number>();

    for (const piece of pieces) {
      seen.add(piece.id);
      let node = this.nodes.get(piece.id);
      if (!node) {
        node = this.createPiece(piece);
        this.nodes.set(piece.id, node);
        this.piecesLayer.appendChild(node);
      }
      const point = this.pointFor(piece.file, piece.rank);
      node.style.transform = `translate(${point.x}px, ${point.y}px)`;
    }

    for (const [id, node] of [...this.nodes]) {
      if (seen.has(id)) continue;
      this.nodes.delete(id);
      node.classList.add('captured');
      window.setTimeout(() => node.remove(), 260);
    }

    if (!animate) {
      void this.svg.getBoundingClientRect();
      requestAnimationFrame(() => this.svg.classList.remove('instant'));
    }
  }

  setSelected(sq: Square | null): void {
    this.replaceGroup(this.underLayer, 'selection', (layer) => {
      if (!sq) return;
      const point = this.pointFor(sq.file, sq.rank);
      layer.appendChild(el('circle', { cx: point.x, cy: point.y, r: 43, class: 'selection-ring' }));
    });
  }

  setTargets(targets: Array<{ move: Move; capture: boolean }>): void {
    this.replaceGroup(this.underLayer, 'target', (layer) => {
      for (const target of targets) {
        const point = this.pointFor(target.move.to.file, target.move.to.rank);
        layer.appendChild(
          target.capture
            ? el('circle', { cx: point.x, cy: point.y, r: 39, class: 'target capture' })
            : el('circle', { cx: point.x, cy: point.y, r: 10, class: 'target dot' }),
        );
      }
    });
  }

  setLastMove(move: Move | null): void {
    this.replaceGroup(this.underLayer, 'last', (layer) => {
      if (!move) return;
      const from = this.pointFor(move.from.file, move.from.rank);
      const to = this.pointFor(move.to.file, move.to.rank);
      layer.appendChild(el('circle', { cx: from.x, cy: from.y, r: 15, class: 'last-from' }));
      layer.appendChild(el('circle', { cx: to.x, cy: to.y, r: 45, class: 'last-to' }));
    });
  }

  setHint(moves: Move[]): void {
    this.replaceGroup(this.overLayer, 'hint', (layer) => {
      moves.slice(0, 3).forEach((move, index) => {
        const from = this.pointFor(move.from.file, move.from.rank);
        const to = this.pointFor(move.to.file, move.to.rank);
        layer.appendChild(
          el('line', {
            x1: from.x,
            y1: from.y,
            x2: to.x,
            y2: to.y,
            class: index === 0 ? 'hint-line' : 'hint-line secondary',
            'marker-end': 'url(#hint-arrow)',
          }),
        );
        layer.appendChild(
          el('circle', {
            cx: to.x,
            cy: to.y,
            r: 46,
            class: index === 0 ? 'hint-ring' : 'hint-ring secondary',
          }),
        );
        const tag = el('text', {
          x: to.x + 28,
          y: to.y - 24,
          class: 'hint-tag',
        });
        tag.textContent = String(index + 1);
        layer.appendChild(tag);
      });
    });
  }

  setCheck(sq: Square | null): void {
    this.replaceGroup(this.underLayer, 'check', (layer) => {
      if (!sq) return;
      const point = this.pointFor(sq.file, sq.rank);
      layer.appendChild(el('circle', { cx: point.x, cy: point.y, r: 45, class: 'check-ring' }));
    });
  }

  pointFor(file: number, rank: number): { x: number; y: number } {
    const df = this.orientation === 'red' ? file : COLS - 1 - file;
    const dr = this.orientation === 'red' ? ROWS - 1 - rank : rank;
    return { x: LEFT + df * CELL, y: TOP + dr * CELL };
  }

  private createPiece(piece: PieceView): SVGGElement {
    const node = el('g', { class: `piece ${piece.side}` });
    node.dataset.id = String(piece.id);
    const glyph = el('text', { x: 0, y: 2, class: 'glyph' });
    glyph.textContent = GLYPHS[piece.side][piece.type];
    node.appendChild(glyph);
    return node;
  }

  private replaceGroup(
    parent: SVGGElement,
    name: string,
    draw: (layer: SVGGElement) => void,
  ): void {
    const previous = parent.querySelector(`:scope > g.${name}`);
    const layer = el('g', { class: name });
    draw(layer);
    if (previous) parent.replaceChild(layer, previous);
    else parent.appendChild(layer);
  }

  private buildStatic(): SVGGElement {
    const root = el('g', { class: 'board-lines' });
    const x = (file: number) => LEFT + file * CELL;
    const y = (rank: number) => TOP + (ROWS - 1 - rank) * CELL;

    for (let rank = 0; rank < ROWS; rank += 1) {
      root.appendChild(
        el('line', { x1: x(0), y1: y(rank), x2: x(8), y2: y(rank), class: 'lane' }),
      );
    }

    for (let file = 0; file < COLS; file += 1) {
      if (file === 0 || file === 8) {
        root.appendChild(el('line', { x1: x(file), y1: y(9), x2: x(file), y2: y(0), class: 'lane' }));
      } else {
        root.appendChild(el('line', { x1: x(file), y1: y(9), x2: x(file), y2: y(5), class: 'lane' }));
        root.appendChild(el('line', { x1: x(file), y1: y(4), x2: x(file), y2: y(0), class: 'lane' }));
      }
    }

    const diagonal = (f1: number, r1: number, f2: number, r2: number) => {
      root.appendChild(
        el('line', { x1: x(f1), y1: y(r1), x2: x(f2), y2: y(r2), class: 'lane palace' }),
      );
    };
    diagonal(3, 0, 5, 2);
    diagonal(5, 0, 3, 2);
    diagonal(3, 7, 5, 9);
    diagonal(5, 7, 3, 9);

    return root;
  }
}