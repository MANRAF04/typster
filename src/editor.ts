import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  HighlightStyle,
  Language,
  LanguageSupport,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  languageDataProp,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  TypstLezerParser,
  typstLezerFoldService,
  typstLezerFolding,
  typstLezerHighlighting,
  typstLezerIndentService,
  typstLezerIndentation,
  typstLezerLanguageData,
  typstLezerListKeymap,
  typstTags,
} from "codemirror-lang-typst/lezer";
import type * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { api, type Diag } from "./ipc";
import type { Project } from "./project";
import { getState, setState } from "./store";

/** `typst_lezer()` without its syntax linter: the compiler reports the same errors, better. */
const typst = new LanguageSupport(
  new Language(
    typstLezerLanguageData,
    new TypstLezerParser(
      languageDataProp.add((type) => (type.isTop ? typstLezerLanguageData : undefined)),
      typstLezerHighlighting,
      typstLezerIndentation,
      typstLezerFolding,
    ),
    [],
    "typst",
  ),
  [typstLezerIndentService, typstLezerListKeymap, typstLezerFoldService],
);

/** Colors come from CSS variables so light and dark themes share one style. */
const highlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [tags.keyword, tags.bool, typstTags.listMarker], color: "var(--syn-keyword)" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: [tags.function(tags.variableName), typstTags.interpolated], color: "var(--syn-function)" },
  { tag: tags.propertyName, color: "var(--syn-property)" },
  { tag: [tags.operator, tags.punctuation, tags.paren], color: "var(--syn-punctuation)" },
  { tag: tags.escape, color: "var(--syn-escape)" },
  { tag: typstTags.mathDelimiter, color: "var(--syn-math)" },
  { tag: tags.heading, color: "var(--syn-heading)", fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.monospace, color: "var(--syn-raw)" },
  { tag: tags.link, color: "var(--syn-link)", textDecoration: "underline" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", color: "var(--text)", backgroundColor: "var(--editor-bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  // Room to scroll the last line up to the middle of the screen.
  ".cm-content": { padding: "14px 0 45vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 18px 0 6px" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", border: "none", color: "var(--faint)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "36px" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--selection-match)", outline: "none" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--faint)", padding: "0 4px" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-popover)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "13px", maxHeight: "18em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 8px", lineHeight: "1.5" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
  ".cm-tooltip.cm-completionInfo": { padding: "8px 10px", maxWidth: "360px", fontSize: "13px", lineHeight: "1.45" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "12px" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent)", fontWeight: "600" },
  ".cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": { padding: "6px 10px", whiteSpace: "pre-wrap", fontSize: "13px", maxWidth: "560px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warning)", textUnderlineOffset: "3px" },
  ".cm-panels": { backgroundColor: "var(--chrome)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "none" },
  ".cm-ySelectionInfo": { fontFamily: "var(--font-ui)", fontSize: "11px", fontWeight: "600", padding: "1px 5px", borderRadius: "4px" },
});

const common: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  lintGutter(),
  syntaxHighlighting(highlightStyle),
  EditorView.lineWrapping,
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
    indentWithTab,
  ]),
  theme,
];

async function completions(context: CompletionContext): Promise<CompletionResult | null> {
  const path = editor.path;
  if (!path) return null;
  const result = await api.complete(path, context.pos, context.explicit).catch(() => null);
  if (!result || context.aborted) return null;
  return {
    from: result.from,
    options: result.items.map((item): Completion => {
      // Short details (a color, a symbol) fit inline; documentation goes to the side panel.
      const inline = item.detail !== null && item.detail.length <= 24 && !item.detail.includes("\n");
      return {
        label: item.label,
        type: item.kind,
        detail: inline ? item.detail! : undefined,
        info: inline ? undefined : (item.detail ?? undefined),
        // CodeMirror reads `#{` as a snippet field, but in Typst it is a code block.
        apply: item.apply ? snippet(item.apply.replaceAll("#{", "#\\{")) : undefined,
      };
    }),
    validFor: /^[\p{L}\p{N}_-]*$/u,
  };
}

const hover = hoverTooltip(
  async (_view, pos, side) => {
    const path = editor.path;
    if (!path) return null;
    const info = await api.tooltip(path, pos, side < 0).catch(() => null);
    if (!info) return null;
    return {
      pos,
      create: () => {
        const dom = document.createElement("div");
        dom.className = info.code ? "hover hover-code" : "hover";
        dom.textContent = info.text;
        return { dom };
      },
    };
  },
  { hoverTime: 400 },
);

function toEditorDiagnostics(diagnostics: Diag[], path: string, length: number): Diagnostic[] {
  // Results can trail the latest edit by a keystroke, so clamp into the document.
  return diagnostics
    .filter((diag) => diag.path === path)
    .map((diag) => ({
      from: Math.min(diag.from, length),
      to: Math.min(Math.max(diag.from, diag.to), length),
      severity: diag.error ? "error" : "warning",
      message: [diag.message, ...diag.hints.map((hint) => `Hint: ${hint}`)].join("\n"),
    }));
}

const emptyState = () => EditorState.create({ extensions: [common, EditorState.readOnly.of(true)] });

class Editor {
  readonly view = new EditorView({ state: emptyState() });
  path: string | null = null;
  private text: Y.Text | null = null;
  private cursorTimer = 0;
  /** Called once the cursor rests, to sync the preview. */
  onCursorRest: (path: string, offset: number) => void = () => {};

  mount(parent: HTMLElement) {
    parent.append(this.view.dom);
  }

  show(project: Project, path: string, text: Y.Text, offset?: number) {
    if (this.path !== path || this.text !== text) {
      this.path = path;
      this.text = text;
      this.view.setState(
        EditorState.create({
          doc: text.toString(),
          extensions: [
            common,
            path.endsWith(".typ") ? [typst, autocompletion({ override: [completions] }), hover] : [],
            yCollab(text, project.awareness, { undoManager: project.undoManager(path, text) }),
            keymap.of(yUndoManagerKeymap),
            this.listener,
          ],
        }),
      );
      this.setDiagnostics(getState().diagnostics);
      setState({ cursor: { line: 1, col: 1 } });
    }
    if (offset !== undefined) this.reveal(offset);
  }

  clear() {
    this.path = null;
    this.text = null;
    this.view.setState(emptyState());
  }

  focus() {
    this.view.focus();
  }

  /** Inserts text on its own line where something was dropped. */
  insertAt(point: { x: number; y: number }, text: string) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(this.view.posAtCoords(point) ?? this.view.state.selection.main.head);
    const from = line.length === 0 ? line.from : line.to;
    const insert = line.length === 0 ? text : `\n${text}`;
    this.view.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length } });
    this.view.focus();
  }

  reveal(offset: number) {
    const pos = Math.min(offset, this.view.state.doc.length);
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    this.view.focus();
  }

  setDiagnostics(diagnostics: Diag[]) {
    if (!this.path) return;
    const state = this.view.state;
    this.view.dispatch(setDiagnostics(state, toEditorDiagnostics(diagnostics, this.path, state.doc.length)));
  }

  private listener = EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    setState({ cursor: { line: line.number, col: head - line.from + 1 } });
    const path = this.path;
    if (update.selectionSet && path) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = window.setTimeout(() => this.onCursorRest(path, head), 250);
    }
  });
}

export const editor = new Editor();
