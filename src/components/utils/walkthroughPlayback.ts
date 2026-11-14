export interface DemoPointer { x: number; y: number; visible: boolean; pressing: boolean }
export type DemoPoint = { x: number; y: number };

/** Page-only demonstration pointer. Each playback owns cancellable waits. */
export function createWalkthroughPlayback(update: (pointer: DemoPointer) => void) {
    let controller: AbortController | undefined;
    let pointer: DemoPointer = { x: 0, y: 0, visible: false, pressing: false };
    const publish = (next: Partial<DemoPointer>) => { pointer = { ...pointer, ...next }; update(pointer); };
    const cancel = () => { controller?.abort(); controller = undefined; publish({ visible: false, pressing: false }); };
    const start = (isCurrent: () => boolean, reducedMotion = false) => {
        cancel();
        const current = controller = new AbortController();
        const check = () => { if (current.signal.aborted || !isCurrent()) throw new Error('Walkthrough playback cancelled'); };
        const pause = (duration: number) => new Promise<void>((resolve, reject) => {
            try { check(); } catch (error) { reject(error); return; }
            const cleanup = () => current.signal.removeEventListener('abort', abort);
            const timer = setTimeout(() => { cleanup(); try { check(); resolve(); } catch (error) { reject(error); } }, duration);
            const abort = () => { clearTimeout(timer); cleanup(); reject(new Error('Walkthrough playback cancelled')); };
            current.signal.addEventListener('abort', abort, { once: true });
        });
        const point = async (target: HTMLElement | DemoPoint) => {
            check();
            const rect = 'getBoundingClientRect' in target ? target.getBoundingClientRect() : null;
            const destination = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : target as DemoPoint;
            if (!pointer.visible) { publish({ x: Math.max(8, destination.x - 70), y: Math.max(8, destination.y + 50), visible: true }); await pause(30); }
            check(); publish({ ...destination, visible: true });
            await pause(reducedMotion ? 80 : 550);
        };
        const press = async (action: () => void) => {
            check(); publish({ pressing: true });
            await pause(140);
            check(); action();
            await pause(180); check(); publish({ pressing: false });
        };
        const waitFor = async <T>(find: () => T | null | undefined | false, timeout = 5000): Promise<T> => {
            const deadline = Date.now() + timeout;
            while (true) {
                check(); const result = find(); if (result) return result;
                if (Date.now() >= deadline) throw new Error('Walkthrough target unavailable');
                await pause(50);
            }
        };
        const finish = () => { if (controller === current) cancel(); };
        return { point, press, pause, waitFor, finish, check };
    };
    return { start, cancel };
}
