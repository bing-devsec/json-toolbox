type JsonToolSampleLocale = 'zh' | 'en';

/** Each JSON string contains another container, for focused recursive-decoding regression coverage. */
export const getRecursiveUnescapeSampleJson = (locale?: JsonToolSampleLocale): string =>
    JSON.stringify(
        {
            payload: JSON.stringify({
                details: JSON.stringify({
                    message: locale === 'en' ? 'Hello, JSON!' : '你好，JSON！',
                    tags: JSON.stringify(['json', 'demo']),
                }),
            }),
        },
        null,
        2,
    );
