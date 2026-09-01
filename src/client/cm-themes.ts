/**
 * CodeMirror 6 theme pieces for the sidebar editor. The editor surface
 * (background, caret, gutter) rides the DSH theme tokens so it blends with
 * the panel in both schemes; only the syntax token colors need concrete
 * values, and those come from the same designed palettes the app's code
 * surfaces use — the one-dark family for dark, the one-light family for
 * light. The scheme flip reconfigures these via a compartment (see
 * TextEditor), so the document, undo history and scroll survive re-theming.
 */
import { Compartment } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags, type Tag } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

/** Token-driven surface shared by both schemes (pure CSS values). */
export const cmSurfaceTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
  },
  '.cm-content': {
    caretColor: 'var(--dsw-alias-label-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    border: 'none',
  },
})

/**
 * Find-in-file panel surface (token-driven). The search panel docks at the
 * bottom of the editor; its inputs/buttons mirror the path-input / icon-button
 * styling in sidebar.module.css so the panel reads as native sidebar chrome.
 */
export const cmSearchTheme = EditorView.theme({
  '.cm-panel.cm-search': {
    padding: '6px 8px',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    borderTop: '1px solid var(--dsw-alias-border-l1)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '12px',
  },
  '.cm-panel.cm-search .cm-textfield': {
    boxSizing: 'border-box',
    height: '26px',
    padding: '0 8px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'var(--dsw-font-xxs-12)',
  },
  '.cm-panel.cm-search .cm-textfield:focus': {
    outline: 'none',
    borderColor: 'var(--dsw-alias-border-l2)',
  },
  '.cm-panel.cm-search .cm-button': {
    padding: '2px 8px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'var(--dsw-font-xxs-12)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search .cm-button:hover': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-primary)',
  },
  '.cm-panel.cm-search label': {
    color: 'var(--dsw-alias-label-tertiary)',
  },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--dsw-alias-label-secondary)',
  },
})

/** Scheme-specific surface tints (selection, active line, search matches). */
function cmSurfaceTint(dark: boolean): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
    '.cm-selectionBackground, .cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
    },
    // Find-in-file match highlights. CodeMirror's own base theme keys these
    // off `&light`/`&dark`, but this editor never applies a `cm-dark` class
    // (its scheme lives in the compartment), so the defaults would always
    // resolve to the light palette. Override them scheme-explicitly here.
    '.cm-searchMatch': {
      backgroundColor: dark ? 'rgba(0,255,255,0.16)' : 'rgba(255,255,0,0.30)',
    },
    '.cm-searchMatch-selected': {
      backgroundColor: dark ? 'rgba(255,0,255,0.24)' : 'rgba(255,106,0,0.34)',
    },
    '.cm-selectionMatch': {
      backgroundColor: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
    },
  })
}

/** One syntax rule: a tag (or tag set) mapped to a concrete color/style. */
interface HighlightRule {
  tag: Tag | readonly Tag[]
  color?: string
  fontStyle?: string
}

/** one-dark syntax palette (mirrors @codemirror/theme-one-dark). */
const HIGHLIGHTS_DARK: HighlightRule[] = [
  { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#c678dd' },
  { tag: tags.string, color: '#98c379' },
  { tag: tags.number, color: '#d19a66' },
  { tag: tags.bool, color: '#d19a66' },
  { tag: tags.atom, color: '#d19a66' },
  { tag: tags.typeName, color: '#e5c07b' },
  { tag: tags.className, color: '#e5c07b' },
  { tag: tags.propertyName, color: '#e06c75' },
  { tag: tags.function(tags.variableName), color: '#61afef' },
  { tag: tags.variableName, color: '#e06c75' },
  { tag: tags.operator, color: '#56b6c2' },
  { tag: tags.tagName, color: '#e06c75' },
  { tag: tags.attributeName, color: '#d19a66' },
  { tag: tags.heading, color: '#e06c75', fontStyle: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontStyle: 'bold' },
  { tag: tags.link, color: '#61afef', fontStyle: 'underline' },
  { tag: tags.meta, color: '#e5c07b' },
  { tag: tags.invalid, color: '#ffffff', fontStyle: 'bold' },
]

/** one-light syntax palette (the light counterpart of one-dark). */
const HIGHLIGHTS_LIGHT: HighlightRule[] = [
  { tag: tags.comment, color: '#a0a1a7', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#a626a4' },
  { tag: tags.string, color: '#50a14f' },
  { tag: tags.number, color: '#986801' },
  { tag: tags.bool, color: '#0184bc' },
  { tag: tags.atom, color: '#0184bc' },
  { tag: tags.typeName, color: '#c18401' },
  { tag: tags.className, color: '#c18401' },
  { tag: tags.propertyName, color: '#e45649' },
  { tag: tags.function(tags.variableName), color: '#c18401' },
  { tag: tags.variableName, color: '#e45649' },
  { tag: tags.operator, color: '#383a42' },
  { tag: tags.tagName, color: '#e45649' },
  { tag: tags.attributeName, color: '#986801' },
  { tag: tags.heading, color: '#e45649', fontStyle: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontStyle: 'bold' },
  { tag: tags.link, color: '#4078f2', fontStyle: 'underline' },
  { tag: tags.meta, color: '#c18401' },
  { tag: tags.invalid, color: '#ffffff', fontStyle: 'bold' },
]

/** The scheme-dependent extension pair (surface tint + syntax highlight). */
function cmThemeExtensions(dark: boolean): Array<ReturnType<typeof EditorView.theme>> {
  return [
    cmSurfaceTint(dark),
    syntaxHighlighting(HighlightStyle.define(dark ? HIGHLIGHTS_DARK : HIGHLIGHTS_LIGHT)),
  ]
}

/**
 * A Compartment holding the two scheme-dependent extensions. Created once
 * per editor view; a scheme flip dispatches `reconfigure(dark)` on it, so
 * the document, undo history, scroll and keymaps survive re-theming.
 */
export class CmThemeCompartment {
  private readonly compartment = new Compartment()

  /** `of(...)` payload for EditorState.create. */
  of(dark: boolean): ReturnType<Compartment['of']> {
    return this.compartment.of(cmThemeExtensions(dark))
  }

  /** Reconfigure for a new scheme. */
  reconfigure(dark: boolean): ReturnType<Compartment['reconfigure']> {
    return this.compartment.reconfigure(cmThemeExtensions(dark))
  }
}
