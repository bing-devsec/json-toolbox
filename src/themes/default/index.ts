import type { ThemeDefinition } from '../contract';

/** The default theme keeps the original Element Plus appearance. */
const defaultTheme: ThemeDefinition = {
    id: 'default',
    zh: '经典默认',
    en: 'Classic Default',
    descriptionZh: '经典 Element 蓝，分区清晰，最接近原版工具。',
    descriptionEn: 'Familiar Element blue, clear zones, closest to the original.',
    getVariables: () => ({}),
};

export default defaultTheme;
