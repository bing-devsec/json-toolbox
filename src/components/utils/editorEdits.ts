import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { monacoApi } from './monacoRuntime';

/**
 * 用 executeEdits 做全文替换，保留 undo/redo 栈。
 * 关键点：
 *   1. 通过 pushStackElement 把本次替换强制切成独立的 undo step，
 *      避免和用户此前的手动输入合并在一起、一次 Ctrl+Z 撤销过多；
 *   2. source 参数会挂到 undo step 上，便于未来排查到底是哪个操作产生的变更。
 *
 * 绝对不要直接 editor.setValue(...) —— setValue 会把整个 undo/redo 栈清空，
 * 导致用户感觉"撤销/取消撤销失灵"。
 */
export const replaceEditorValuePreservingUndo = (editor: monaco.editor.IStandaloneCodeEditor, newValue: string, source: string) => {
    const model = editor.getModel();
    if (!model) {
        editor.setValue(newValue);
        return;
    }
    const currentValue = model.getValue();
    if (currentValue === newValue) return;

    const lastLine = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lastLine);
    const fullRange = new monacoApi.Range(1, 1, lastLine, lastCol);

    // 关键：编辑前后各切一次 undo step，保证本次替换独占一个 undo group
    model.pushStackElement();
    editor.executeEdits(source, [{ range: fullRange, text: newValue }]);
    model.pushStackElement();
};
