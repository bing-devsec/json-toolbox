import type { InterfaceStyle } from './ids';
import { createRetryableModuleLoader } from '../components/utils/jsonToolLoadController';

// The saved theme is ready before the workbench mounts. The settings dialog prepares
// the remaining styles before it offers a switch, so switching never flashes unstyled UI.
const loaders: Record<InterfaceStyle, () => Promise<unknown>> = {
    default: async () => {},
    ide: createRetryableModuleLoader(() => import('./ide/styles')),
    glass: createRetryableModuleLoader(() => import('./glass/styles')),
    retro: createRetryableModuleLoader(() => import('./retro/styles')),
    paper: createRetryableModuleLoader(() => import('./paper/styles')),
};
export const loadThemeStyles = async (style: InterfaceStyle): Promise<void> => { await loaders[style](); };
export const preloadThemeStyles = async (): Promise<void> => { await Promise.all(Object.values(loaders).map(load => load())); };
