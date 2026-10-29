import { createRetryableModuleLoader } from './jsonToolLoadController';

type WorkbenchComponent = typeof import('../JsonToolWorkbench.vue')['default'];

/** 桌面页面和异步组件复用同一次下载；失败后允许重新加载。 */
export const loadJsonToolWorkbench = createRetryableModuleLoader<WorkbenchComponent>(
    () => import('../JsonToolWorkbench.vue').then(module => module.default),
);
