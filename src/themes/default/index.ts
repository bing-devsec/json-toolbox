import type { ThemeDefinition } from '../contract';
import { getDefaultVariables } from './tokens';

/** Preserve the original layout and editor palette, with readable action colors. */
const defaultTheme: ThemeDefinition = {
    id: 'default',
    zh: '经典默认',
    en: 'Classic Default',
    descriptionZh: '经典 Element 蓝，分区清晰，最接近原版工具。',
    descriptionEn: 'Familiar Element blue, clear zones, closest to the original.',
    getVariables: getDefaultVariables,
};

export default defaultTheme;
