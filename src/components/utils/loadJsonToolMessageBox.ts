import { createRetryableModuleLoader } from './jsonToolLoadController';

/** Keep confirmation UI and its styles off the normal editor startup path. */
export const loadJsonToolMessageBox = createRetryableModuleLoader(async () => {
    const [module] = await Promise.all([
        import('element-plus/es/components/message-box/index.mjs'),
        import('./jsonToolMessageBoxStyles'),
    ]);
    return module.ElMessageBox;
});
