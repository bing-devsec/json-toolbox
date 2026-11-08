import ts from 'typescript';

/** The parser exposes diagnostics at runtime although SourceFile omits that field. */
/** @typedef {ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }} ParsedSource */
/** @param {string} name @param {string} code @param {ts.ScriptTarget} target @param {boolean} parents @param {ts.ScriptKind} kind @returns {ParsedSource} */
export const parseSource = (name, code, target, parents, kind) =>
    /** @type {ParsedSource} */ (ts.createSourceFile(name, code, target, parents, kind));
