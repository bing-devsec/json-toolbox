import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue';

const FIRST_USE_GUIDE_STORAGE_KEY = 'json-tool:first-use-guide-dismissed:v1';

interface GuideOptions {
    stepCount?: number;
    locale: Readonly<Ref<'zh' | 'en' | undefined>>;
    editorsInitialized: Readonly<Ref<boolean>>;
    isDiffMode: Readonly<Ref<boolean>>;
    isInputDragActive: Readonly<Ref<boolean>>;
    unavailable: Readonly<Ref<boolean>>;
    suppressAutomaticInvitation?: Readonly<Ref<boolean>>;
    beginDemo: () => boolean;
    restoreDemo: () => void;
    prepareStep: (step: number, isCurrent: () => boolean) => void | Promise<void>;
    // Returning false pauses this step until the user explicitly continues.
    performStep: (step: number, isCurrent: () => boolean) => void | false | Promise<void | false>;
    getTarget: (step: number) => HTMLElement | null;
}

/** A user-controlled walkthrough. Async actions belong to one step/session only. */
export const useJsonToolFirstUseGuide = (options: GuideOptions) => {
    const stepCount = options.stepCount ?? 7;
    const dismissed = ref(true);
    const inputHasContent = ref(false);
    const active = ref(false);
    const step = ref(0);
    const busy = ref(false);
    const done = ref(false);
    const error = ref('');
    const target = shallowRef<HTMLElement | null>(null);
    let generation = 0;
    let returnFocus: HTMLElement | null = null;
    const available = computed(() => options.editorsInitialized.value && !options.isDiffMode.value && !options.unavailable.value);
    const shouldShowFirstUseGuide = computed(() => available.value && !active.value && !options.isInputDragActive.value &&
        !options.suppressAutomaticInvitation?.value && !dismissed.value && !inputHasContent.value);

    function dismissFirstUseGuide() {
        dismissed.value = true;
        try { localStorage.setItem(FIRST_USE_GUIDE_STORAGE_KEY, '1'); } catch { /* Optional preference. */ }
    }
    function finish(restoreFocus = true) {
        generation++;
        if (!active.value) return;
        active.value = false;
        busy.value = false;
        target.value = null;
        options.restoreDemo();
        if (restoreFocus) void nextTick(() => {
            if (!active.value) (returnFocus?.isConnected ? returnFocus : document.querySelector<HTMLElement>('.settings-tool-button'))?.focus({ preventScroll: true });
        });
    }
    async function run(operation: (isCurrent: () => boolean) => void | Promise<void>) {
        if (!active.value || busy.value) return;
        const token = ++generation;
        const isCurrent = () => active.value && token === generation;
        busy.value = true;
        error.value = '';
        try {
            await operation(isCurrent);
            await nextTick();
            if (isCurrent()) target.value = options.getTarget(step.value);
        } catch {
            if (isCurrent()) error.value = options.locale.value === 'en' ? 'This step could not finish. Try again, or skip it.' : '这一步未完成，可以重试或跳过。';
        } finally {
            if (isCurrent()) busy.value = false;
        }
    }
    async function goTo(next: number) {
        if (!active.value || busy.value || !Number.isInteger(next)) return;
        if (next >= stepCount) { finish(); return; }
        step.value = Math.max(0, next);
        done.value = false;
        target.value = null;
        await run(isCurrent => options.prepareStep(step.value, isCurrent));
    }
    async function start() {
        if (!shouldShowFirstUseGuide.value) return;
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!options.beginDemo()) return;
        dismissFirstUseGuide();
        active.value = true;
        await goTo(0);
    }
    async function action() {
        await run(async isCurrent => {
            const completed = await options.performStep(step.value, isCurrent);
            if (isCurrent()) done.value = completed !== false;
        });
    }
    onMounted(() => {
        try { dismissed.value = localStorage.getItem(FIRST_USE_GUIDE_STORAGE_KEY) === '1'; }
        catch { dismissed.value = true; }
    });
    watch(available, value => { if (!value) finish(false); }, { flush: 'sync' });
    onBeforeUnmount(() => finish(false));
    return { inputHasContent, shouldShowFirstUseGuide, dismissFirstUseGuide, start, active, step, busy, done, error, target, action, goTo,
        next: () => goTo(step.value + 1), back: () => goTo(step.value - 1), finish };
};
