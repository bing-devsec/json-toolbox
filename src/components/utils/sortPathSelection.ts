/** Resolve autocomplete selection identically for root and field paths. */
export function resolveSortPathSelection(contextInput: string, selectedValue: string): string {
    let newPath = selectedValue;

    if (contextInput && contextInput !== selectedValue) {
        if (selectedValue.startsWith(contextInput)) {
            newPath = selectedValue;
        } else if (contextInput.endsWith('.') || contextInput.endsWith('[')) {
            newPath = contextInput + selectedValue;
        } else if (contextInput.match(/\[\d*\]$/) || contextInput.endsWith(']')) {
            newPath = contextInput + '.' + selectedValue;
        } else {
            const lastDotIndex = contextInput.lastIndexOf('.');
            const lastBracketIndex = contextInput.lastIndexOf('[');

            if (lastDotIndex !== -1 && (lastBracketIndex === -1 || lastDotIndex > lastBracketIndex)) {
                const basePath = contextInput.substring(0, lastDotIndex + 1);
                newPath = basePath + selectedValue;
            } else if (lastBracketIndex !== -1) {
                const bracketEndIndex = contextInput.indexOf(']', lastBracketIndex);
                if (bracketEndIndex !== -1) {
                    const basePath = contextInput.substring(0, bracketEndIndex + 1);
                    newPath = basePath + '.' + selectedValue;
                } else {
                    newPath = selectedValue;
                }
            } else {
                newPath = selectedValue;
            }
        }
    }
    return newPath;
}
