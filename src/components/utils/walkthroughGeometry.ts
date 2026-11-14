export interface WalkthroughPoint { x: number; y: number }
export interface WalkthroughSize { width: number; height: number }
export interface WalkthroughRect extends WalkthroughPoint, WalkthroughSize {}
export type WalkthroughSide = 'right' | 'left' | 'bottom' | 'top';
export interface WalkthroughGeometryInput {
    target: WalkthroughRect;
    viewport: WalkthroughSize;
    note: WalkthroughSize;
}
export interface WalkthroughGeometry {
    note: WalkthroughRect;
    side: WalkthroughSide;
    arrow: { start: WalkthroughPoint; end: WalkthroughPoint; control: WalkthroughPoint };
}

const GAP = 64;
const ARROW_GAP = 8;
const CONTROLS_HEIGHT = 80;
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const positive = (value: number) => Math.max(0, finite(value));
const clamp = (value: number, maximum: number) => Math.max(0, Math.min(value, maximum));

/** Viewport coordinates; the caller clips the target against scrolling ancestors. */
export function calculateWalkthroughGeometry(input: WalkthroughGeometryInput): WalkthroughGeometry {
    const width = positive(input.viewport.width);
    const height = positive(input.viewport.height);
    const noteBottom = Math.max(0, height - CONTROLS_HEIGHT);
    const noteWidth = Math.min(positive(input.note.width), width);
    const noteHeight = Math.min(positive(input.note.height), noteBottom);
    const targetX = clamp(finite(input.target.x), width);
    const targetY = clamp(finite(input.target.y), height);
    const targetRight = clamp(finite(input.target.x) + positive(input.target.width), width);
    const targetBottom = clamp(finite(input.target.y) + positive(input.target.height), height);
    const target = {
        x: targetX, y: targetY,
        width: Math.max(0, targetRight - targetX), height: Math.max(0, targetBottom - targetY),
    };
    const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
    const candidates: Array<WalkthroughPoint & { side: WalkthroughSide }> = [
        { side: 'right', x: targetRight + GAP, y: center.y - noteHeight / 2 },
        { side: 'left', x: target.x - GAP - noteWidth, y: center.y - noteHeight / 2 },
        { side: 'bottom', x: center.x - noteWidth / 2, y: targetBottom + GAP },
        { side: 'top', x: center.x - noteWidth / 2, y: target.y - GAP - noteHeight },
    ];
    const fits = (point: WalkthroughPoint) => point.x >= 0 && point.y >= 0
        && point.x + noteWidth <= width && point.y + noteHeight <= noteBottom;
    const overlap = (point: WalkthroughPoint) =>
        Math.max(0, Math.min(point.x + noteWidth, targetRight) - Math.max(point.x, target.x))
        * Math.max(0, Math.min(point.y + noteHeight, targetBottom) - Math.max(point.y, target.y));
    let chosen = candidates.find(point => fits(point) && overlap(point) === 0);
    if (!chosen) {
        // A large target can leave no empty side. Prefer the least overlap, then
        // the smallest clamp distance; array order breaks ties predictably.
        chosen = candidates.map(point => {
            const x = clamp(point.x, width - noteWidth);
            const y = clamp(point.y, noteBottom - noteHeight);
            return { side: point.side, x, y, overlap: overlap({ x, y }), distance: Math.hypot(x - point.x, y - point.y) };
        }).sort((a, b) => a.overlap - b.overlap || a.distance - b.distance)[0]!;
    }
    const note = { x: chosen.x, y: chosen.y, width: noteWidth, height: noteHeight };
    // Clamping may place the note on a different side than its original candidate.
    const side: WalkthroughSide = note.x >= targetRight ? 'right'
        : note.x + noteWidth <= target.x ? 'left'
        : note.y >= targetBottom ? 'bottom'
        : note.y + noteHeight <= target.y ? 'top' : chosen.side;
    const noteCenter = { x: note.x + noteWidth / 2, y: note.y + noteHeight / 2 };
    const horizontal = side === 'right' || side === 'left';
    const start = horizontal
        ? { x: side === 'right' ? note.x - ARROW_GAP : note.x + noteWidth + ARROW_GAP, y: noteCenter.y }
        : { x: noteCenter.x, y: side === 'bottom' ? note.y - ARROW_GAP : note.y + noteHeight + ARROW_GAP };
    const end = horizontal
        ? { x: side === 'right' ? targetRight + ARROW_GAP : target.x - ARROW_GAP, y: center.y }
        : { x: center.x, y: side === 'bottom' ? targetBottom + ARROW_GAP : target.y - ARROW_GAP };
    for (const point of [start, end]) { point.x = clamp(point.x, width); point.y = clamp(point.y, height); }
    const bend = Math.min(10, Math.hypot(end.x - start.x, end.y - start.y) / 10);
    const control = {
        x: clamp((start.x + end.x) / 2 + (horizontal ? 0 : bend), width),
        y: clamp((start.y + end.y) / 2 + (horizontal ? bend : 0), height),
    };
    return { note, side, arrow: { start, end, control } };
}
