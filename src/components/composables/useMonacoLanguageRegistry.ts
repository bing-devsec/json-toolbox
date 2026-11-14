import { onBeforeUnmount, type Ref } from 'vue';
import { monacoApi, createMonacoWorker } from '../utils/monacoRuntime';
import { createOptionalLanguageLoader } from '../utils/optionalLanguageLoader';
import { createJsonLanguageActivation } from '../utils/jsonLanguageActivation';
import {
    defineJsonToolMonacoThemes,
    getJsonToolThemeForLanguage,
    type JsonToolThemeMode,
} from '../utils/monacoThemes';

/**
 * 集中管理 JSON 工具的 Monaco Worker、主题与可选语言贡献。
 * themeMode 是当前明暗主题；返回值提供环境初始化、语言注册与按需加载能力。
 */
export const useMonacoLanguageRegistry = (themeMode: Ref<JsonToolThemeMode>) => {
    let jsonLanguageActivation: ReturnType<typeof createJsonLanguageActivation> | undefined;
    let diagnosticsEnabled = true;
    const configureJsonLanguageFeatures = (enabled: boolean) => {
        diagnosticsEnabled = enabled;
        jsonLanguageActivation?.setDiagnosticsEnabled(enabled);
    };
    onBeforeUnmount(() => jsonLanguageActivation?.dispose());
    const languageLoader = createOptionalLanguageLoader(() => monacoApi, {
        yaml: () => import('../utils/languages/yaml'),
        xml: () => import('../utils/languages/xml'),
        html: () => import('../utils/languages/html'),
        css: () => import('../utils/languages/css'),
        toml: () => import('../utils/languages/toml'),
        go: () => import('monaco-editor/esm/vs/basic-languages/go/go.contribution').then(() => ({ register() {} })),
        typescript: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution').then(() => ({ register() {} })),
    });
    onBeforeUnmount(() => languageLoader.dispose());
    const ensureMonacoLanguageRegistered = languageLoader.load;
    const loadMonacoLanguageContribution = languageLoader.load;

    /** 初始化 Monaco 的 Worker 路由和项目主题，无输入参数与返回值。 */
    const initializeMonacoEnvironment = (): void => {
        if (typeof window === 'undefined') return;
        jsonLanguageActivation ??= createJsonLanguageActivation(
            monacoApi.editor,
            configuration => monacoApi.languages.json.jsonDefaults.setModeConfiguration(configuration),
            diagnosticsEnabled,
        );
        window.MonacoEnvironment = {
            getWorker(_, label): Worker {
                return createMonacoWorker(label);
            },
        };

        defineJsonToolMonacoThemes(monacoApi);
        monacoApi.editor.setTheme(getJsonToolThemeForLanguage('json', themeMode.value));
    };

    return {
        isMonacoLanguageRegistered: languageLoader.isReady,
        ensureMonacoLanguageRegistered,
        loadMonacoLanguageContribution,
        initializeMonacoEnvironment,
        configureJsonLanguageFeatures,
    };
};
