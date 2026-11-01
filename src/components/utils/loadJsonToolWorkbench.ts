import { createRetryableModuleLoader } from './jsonToolLoadController';
import { loadThemeStyles } from '../../themes/styles';
import { normalizeInterfaceStyle } from '../../themes/ids';

type WorkbenchComponent = typeof import('../JsonToolWorkbench.vue')['default'];

/** Share the download and wait for the stored theme before rendering the editor. */
export const loadJsonToolWorkbench = createRetryableModuleLoader<WorkbenchComponent>(
    async () => {
        const [module] = await Promise.all([
            import('../JsonToolWorkbench.vue'),
            loadThemeStyles(normalizeInterfaceStyle(document.body.dataset.interfaceStyle)),
        ]);
        return module.default;
    },
);
