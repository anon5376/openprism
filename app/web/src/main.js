import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = '/static/pdf.worker.min.mjs';

const $ = (selector) => document.querySelector(selector);

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function api(path, body = {}) {
  const response = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error?.message || `Request failed (${response.status})`, data?.error?.code);
  return data;
}

async function stream(path, body, onEvent) {
  const response = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error?.message || `Request failed (${response.status})`, data?.error?.code);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}

function remember(name, fallback) {
  try {
    const value = localStorage.getItem('openprism-' + name);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function store(name, value) {
  try {
    localStorage.setItem('openprism-' + name, JSON.stringify(value));
  } catch {
    // A private window can refuse storage, and these are only conveniences.
  }
}

const S = {
  project: null,
  tabs: new Map(),
  active: null,
  diagnostics: [],
  providers: [],
  models: {},
  selection: null,
  effort: 'max',
  preset: 'anthropic',
  settingsLoaded: false,
  chats: [],
  chat: null,
  request: null,
  compiling: false,
  compileAgain: false,
  sending: false,
  pdf: null,
  pdfTask: null,
  scale: null,
  files: [],
  editingProvider: null,
  realtime: remember('realtime', false),
  projects: [],
  lastCompile: null,
};

const PRESETS = [
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', url: 'https://api.anthropic.com' },
  { id: 'openai', name: 'OpenAI', type: 'openai', url: 'https://api.openai.com/v1' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', url: 'https://openrouter.ai/api/v1' },
  { id: 'google', name: 'Google', type: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'xai', name: 'xAI', type: 'openai', url: 'https://api.x.ai/v1' },
  { id: 'other', name: 'Other', type: 'openai', url: '' },
];
const EFFORTS = [
  { id: 'low', label: 'Low', hint: 'Fastest and cheapest', bars: 1 },
  { id: 'medium', label: 'Medium', hint: 'For everyday edits', bars: 2 },
  { id: 'high', label: 'High', hint: 'For careful work', bars: 3 },
  { id: 'xhigh', label: 'Very high', hint: 'For hard problems', bars: 4 },
  { id: 'max', label: 'Maximum', hint: 'Slowest, and costs the most', bars: 5 },
  { id: 'default', label: "Model's default", hint: 'Sends no effort setting', bars: 0 },
];
const APPEARANCE_DEFAULTS = {
  theme: 'system', motion: 'full', accent: '', background: '', panel: '', text: '', uiFont: '', editorFont: '',
  uiSize: 13, editorSize: 13, editorLeading: 1.6, corners: 1,
};
const ACCENTS = ['#6e95f5', '#3fb6c6', '#4fb286', '#d9b44a', '#f08a4b', '#e5645b', '#e56fa3', '#9b7bf0'];
const UI_FONTS = ['Helvetica Neue', 'Avenir Next', 'Gill Sans', 'Optima', 'Georgia', 'Charter', 'Iowan Old Style', 'Palatino'];
const EDITOR_FONTS = ['Menlo', 'Monaco', 'Courier New', 'Andale Mono', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono'];
const THEME_OPTIONS = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];
const MOTION_OPTIONS = [['full', 'Full'], ['reduced', 'Reduced'], ['none', 'Off']];

// Appearance

function luminance(hex) {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function tokenColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const editorTheme = new Compartment();

function uiIsDark() {
  const look = S.appearance;
  if (look.background) return luminance(look.background) < 0.35;
  if (look.theme !== 'system') return look.theme === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function syncEditorTheme() {
  if (editorTheme.get(view.state) === undefined) return;
  view.dispatch({ effects: editorTheme.reconfigure(uiIsDark() ? oneDark : []) });
}

function fontStack(name, fallback) {
  if (!name) return null;
  const quoted = name.split(',').map((part) => part.trim().replace(/["']/g, '')).filter(Boolean).map((part) => `"${part}"`);
  return `${quoted.join(', ')}, ${fallback}`;
}

function applyAppearance() {
  const look = S.appearance;
  const root = document.documentElement;
  const set = (name, value) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
  if (look.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = look.theme;
  root.dataset.motion = look.motion;
  set('--size-ui', `${look.uiSize}px`);
  set('--size-editor', `${look.editorSize}px`);
  set('--leading-editor', String(look.editorLeading));
  set('--r', String(look.corners));
  set('--font-ui', fontStack(look.uiFont, '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'));
  set('--font-editor', fontStack(look.editorFont, 'ui-monospace, Menlo, monospace'));
  // A colour set here wins over the theme, and the shades around it follow from it.
  set('--accent', look.accent);
  set('--send', look.accent);
  set('--on-send', look.accent ? (luminance(look.accent) > 0.4 ? '#101010' : '#ffffff') : '');
  set('--tools', look.accent ? `color-mix(in srgb, ${look.accent} 28%, var(--editor))` : '');
  set('--tools-text', look.accent ? `color-mix(in srgb, ${look.accent} 62%, var(--text))` : '');
  set('--window', look.background);
  set('--editor', look.background);
  set('--side', look.panel);
  set('--panel', look.panel);
  const textColor = look.text || 'var(--text)';
  set('--raised', look.panel ? `color-mix(in srgb, ${look.panel} 88%, ${textColor})` : '');
  set('--raised-hover', look.panel ? `color-mix(in srgb, ${look.panel} 80%, ${textColor})` : '');
  set('--line', look.panel ? `color-mix(in srgb, ${look.panel} 82%, ${textColor})` : '');
  set('--text', look.text);
  set('--muted', look.text ? `color-mix(in srgb, ${look.text} 62%, ${look.background || 'var(--window)'})` : '');
  try {
    localStorage.setItem('openprism-appearance', JSON.stringify(look));
  } catch {
    // The page works without it. It only avoids a flash of the default look on the next load.
  }
  syncEditorTheme();
  view.requestMeasure();
}

// Editor

function cachedLook() {
  try {
    return { ...APPEARANCE_DEFAULTS, ...JSON.parse(localStorage.getItem('openprism-appearance') || '{}') };
  } catch {
    return { ...APPEARANCE_DEFAULTS };
  }
}

S.appearance = cachedLook();

const view = new EditorView({ parent: $('#editor') });
applyAppearance();
let saveTimer = null;
let outlineTimer = null;
let realtimeTimer = null;

function editorState(rel, text) {
  const isTex = /\.(tex|sty|cls|ltx|bib|bbl)$/.test(rel);
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      lintGutter(),
      isTex ? StreamLanguage.define(stex) : [],
      editorTheme.of(uiIsDark() ? oneDark : []),
      Prec.high(keymap.of([
        { key: 'Mod-Enter', run: () => { compile(); return true; } },
        { key: 'Mod-s', run: () => { saveAll(); return true; } },
        { key: 'Mod-j', run: () => { gotoPdf(); return true; } },
      ])),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const tab = S.tabs.get(rel);
        if (!tab) return;
        tab.dirty = true;
        renderTabs();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveAll, 800);
        clearTimeout(outlineTimer);
        outlineTimer = setTimeout(renderOutline, 300);
        if (S.realtime) {
          clearTimeout(realtimeTimer);
          realtimeTimer = setTimeout(compile, 1500);
        }
      }),
    ],
  });
}

function activeDoc(rel) {
  return (rel === S.active ? view.state : S.tabs.get(rel).state).doc.toString();
}

function saveTab(rel) {
  const tab = S.tabs.get(rel);
  if (!tab) return Promise.resolve();
  tab.chain = tab.chain.then(async () => {
    if (!tab.dirty || !S.tabs.has(rel)) return;
    const text = activeDoc(rel);
    tab.dirty = false;
    try {
      const { hash } = await api('file/write', { project: S.project.root, rel, text, expected_hash: tab.hash });
      tab.hash = hash;
    } catch (error) {
      tab.dirty = true;
      if (error.code === 'stale') showStale(rel);
      else showNotice(`Could not save ${rel}: ${error.message}`);
    }
    renderTabs();
  });
  return tab.chain;
}

function saveAll() {
  clearTimeout(saveTimer);
  return Promise.all([...S.tabs.keys()].map(saveTab));
}

function showNotice(message, ...buttons) {
  const notice = $('#notice');
  notice.replaceChildren(el('span', { class: 'spacer' }, message), ...buttons,
    el('button', { type: 'button', class: 'pill small', onclick: () => { notice.hidden = true; } }, 'Dismiss'));
  notice.hidden = false;
}

function showStale(rel) {
  showNotice(`${rel} changed on disk, so it was not saved.`,
    el('button', {
      type: 'button',
      class: 'pill small',
      onclick: async () => {
        $('#notice').hidden = true;
        await reloadTab(rel);
      },
    }, 'Load the disk version'));
}

async function reloadTab(rel) {
  const tab = S.tabs.get(rel);
  if (!tab) return;
  const { text, hash } = await api('file/read', { project: S.project.root, rel });
  tab.hash = hash;
  tab.state = editorState(rel, text);
  tab.dirty = false;
  if (S.active === rel) {
    view.setState(tab.state);
    syncEditorTheme();
    applyDiagnostics();
    renderOutline();
  }
  renderTabs();
}

async function openFile(rel, line) {
  if (!S.tabs.has(rel)) {
    let file;
    try {
      file = await api('file/read', { project: S.project.root, rel });
    } catch (error) {
      showNotice(error.message);
      return;
    }
    S.tabs.set(rel, { state: editorState(rel, file.text), hash: file.hash, dirty: false, chain: Promise.resolve() });
  }
  activate(rel);
  if (line) gotoLine(line);
}

function activate(rel) {
  if (S.active && S.tabs.has(S.active)) S.tabs.get(S.active).state = view.state;
  S.active = rel;
  view.setState(S.tabs.get(rel).state);
  syncEditorTheme();
  applyDiagnostics();
  renderTabs();
  renderTree();
  renderOutline();
}

async function closeTab(rel) {
  await saveTab(rel);
  S.tabs.delete(rel);
  if (S.active !== rel) return renderTabs();
  S.active = null;
  const next = [...S.tabs.keys()].at(-1);
  if (next) activate(next);
  else {
    view.setState(EditorState.create({ doc: '' }));
    renderTabs();
    renderTree();
    renderOutline();
  }
}

function gotoLine(line) {
  const number = Math.min(Math.max(line, 1), view.state.doc.lines);
  const position = view.state.doc.line(number).from;
  view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
  view.focus();
}

function applyDiagnostics() {
  if (!S.active) return;
  const doc = view.state.doc;
  const marks = S.diagnostics
    .filter((d) => d.rel === S.active && d.line && d.line <= doc.lines)
    .map((d) => {
      const line = doc.line(d.line);
      return { from: line.from, to: line.to, severity: d.severity, message: d.message };
    });
  view.dispatch(setDiagnostics(view.state, marks));
}

function renderTabs() {
  $('#tabs').replaceChildren(...[...S.tabs.entries()].map(([rel, tab]) => el('div', { class: 'file-tab' + (rel === S.active ? ' on' : '') },
    el('button', { type: 'button', title: rel, onclick: () => activate(rel) }, rel.split('/').pop() + (tab.dirty ? ' •' : '')),
    el('button', { type: 'button', 'aria-label': `Close ${rel}`, onclick: () => closeTab(rel) }, '×'))));
}

function renderTree() {
  const build = (nodes) => el('ul', {}, ...nodes.map((node) => (node.type === 'dir'
    ? el('li', {}, el('div', { class: 'dir' }, node.name), build(node.children))
    : el('li', {}, el('button', {
      type: 'button',
      class: 'file-row' + (node.rel === S.active ? ' active' : ''),
      title: node.rel,
      onclick: () => openFile(node.rel),
    }, node.name)))));
  $('#tree').replaceChildren(build(S.project.tree));
}

function renderOutline() {
  const outline = $('#outline');
  if (!S.active) return outline.replaceChildren();
  const rows = [];
  const pattern = /^[ \t]*\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/;
  const depth = { part: 0, chapter: 0, section: 0, subsection: 1, subsubsection: 2 };
  let number = 0;
  for (const line of view.state.doc.iterLines()) {
    number += 1;
    const match = pattern.exec(line);
    if (match) {
      const target = number;
      const button = el('button', { type: 'button', onclick: () => gotoLine(target) }, match[2]);
      button.style.paddingLeft = `${22 + depth[match[1]] * 10}px`;
      rows.push(button);
    }
  }
  outline.replaceChildren(...rows);
}

function flatten(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === 'dir') flatten(node.children, out);
    else out.push(node.rel);
  }
  return out;
}

function renderMainPicker() {
  S.files = flatten(S.project.tree);
  const tex = S.files.filter((rel) => rel.endsWith('.tex'));
  const picker = $('#main-file');
  const chosen = picker.value && tex.includes(picker.value) ? picker.value : S.project.main;
  picker.replaceChildren(...tex.map((rel) => el('option', { value: rel }, rel)));
  if (chosen) picker.value = chosen;
}

async function refreshTree() {
  const { tree, main } = await api('project/tree', { project: S.project.root });
  S.project.tree = tree;
  S.project.main = main;
  renderTree();
  renderMainPicker();
}

// Compile

function setStatus(text, kind = '') {
  $('#status').textContent = text;
  const button = $('#compile');
  button.classList.toggle('bad', kind === 'bad');
  const icon = $('#status-icon');
  icon.classList.toggle('spin', kind === 'busy');
  const name = { ok: 'check', bad: 'x', busy: 'redo' }[kind] || 'redo';
  icon.querySelector('use').setAttribute('href', `#i-${name}`);
}

async function compile() {
  if (!S.project) return;
  if (S.compiling) {
    if (S.realtime) S.compileAgain = true;
    return;
  }
  S.compiling = true;
  closeMenus();
  $('#cancel').hidden = false;
  try {
    await saveAll();
    const main = $('#main-file').value;
    if (!main) {
      setStatus('No main .tex file', 'bad');
      return;
    }
    setStatus('Compiling…', 'busy');
    const lines = [];
    let result = null;
    await stream('compile', { project: S.project.root, main }, (event) => {
      if (event.type === 'line') {
        lines.push(event.text);
        if (/downloading/i.test(event.text)) setStatus('Downloading packages…', 'busy');
      } else if (event.type === 'result') {
        result = event;
      } else if (event.type === 'error') {
        setStatus(event.message, 'bad');
      }
    });
    if (!result) return;
    S.diagnostics = result.diagnostics;
    S.lastCompile = { ...result, finished: new Date() };
    applyDiagnostics();
    renderLog(result.log || lines.join('\n'));
    renderInfo();
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
    if (result.cancelled) setStatus('Cancelled');
    else if (errors) setStatus(`${errors} error${errors === 1 ? '' : 's'}`, 'bad');
    else setStatus('Compiled', 'ok');
    $('#view-errors').hidden = !errors;
    if (result.has_pdf) await loadPdf();
  } catch (error) {
    setStatus(error.message, 'bad');
  } finally {
    S.compiling = false;
    $('#cancel').hidden = true;
    if (S.compileAgain) {
      S.compileAgain = false;
      compile();
    }
  }
}

function renderLog(text) {
  $('#log-text').textContent = text;
  $('#diagnostics').replaceChildren(...S.diagnostics.map((d) => {
    const place = d.rel ? `${d.rel}${d.line ? `:${d.line}` : ''}` : '';
    const label = `${d.severity === 'error' ? 'Error' : 'Warning'}${place ? ` ${place}` : ''}: ${d.message}`;
    if (!d.rel) return el('li', { class: d.severity }, label);
    return el('li', {}, el('button', {
      type: 'button',
      class: d.severity,
      onclick: () => openFile(d.rel, d.line),
    }, label));
  }));
}

// PDF

const pageObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) renderPage(entry.target);
  }
}, { root: $('#pdf'), rootMargin: '400px' });

async function renderPage(wrapper) {
  const doc = S.pdf;
  const scale = S.scale;
  if (!doc || wrapper.dataset.rendered === String(scale)) return;
  wrapper.dataset.rendered = String(scale);
  try {
    const page = await doc.getPage(Number(wrapper.dataset.page));
    const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
    const canvas = el('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, viewport }).promise;
    if (doc !== S.pdf || scale !== S.scale) return;
    wrapper.querySelector('canvas')?.remove();
    wrapper.prepend(canvas);
  } catch (error) {
    // A newer compile replaced this document while it was drawing, which is normal.
    if (doc === S.pdf) setStatus(`Could not draw the PDF: ${error.message}`, 'bad');
  }
}

function pdfUrl() {
  return `/api/pdf?project=${encodeURIComponent(S.project.root)}&v=${Date.now()}`;
}

async function fitScale(doc) {
  const first = await doc.getPage(1);
  return Math.max(0.3, ($('#pdf').clientWidth - 40) / first.getViewport({ scale: 1 }).width);
}

async function loadPdf() {
  const pane = $('#pdf');
  const top = pane.scrollTop;
  const url = pdfUrl();
  const task = pdfjs.getDocument({ url, isEvalSupported: false, wasmUrl: '/static/wasm/' });
  const doc = await task.promise;
  const previous = S.pdfTask;
  S.pdf = doc;
  S.pdfTask = task;
  if (!S.scale) S.scale = await fitScale(doc);
  await layoutPages();
  pane.scrollTop = top;
  $('#download-pdf').href = url;
  previous?.destroy().catch(() => {});
}

async function layoutPages() {
  const pane = $('#pdf');
  pageObserver.disconnect();
  const wrappers = [];
  for (let number = 1; number <= S.pdf.numPages; number += 1) {
    const page = await S.pdf.getPage(number);
    const viewport = page.getViewport({ scale: S.scale });
    const wrapper = el('div', { class: 'page' });
    wrapper.dataset.page = String(number);
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    wrapper.addEventListener('dblclick', onPdfDoubleClick);
    wrappers.push(wrapper);
  }
  pane.replaceChildren(...wrappers);
  wrappers.forEach((wrapper) => pageObserver.observe(wrapper));
}

async function jumpToSource(page, x, y) {
  const { target } = await api('synctex/to_source', { project: S.project.root, page, x, y });
  if (target) await openFile(target.rel, target.line);
  else setStatus('No source found there');
}

async function onPdfDoubleClick(event) {
  const wrapper = event.currentTarget;
  const box = wrapper.getBoundingClientRect();
  await jumpToSource(Number(wrapper.dataset.page), (event.clientX - box.left) / S.scale, (event.clientY - box.top) / S.scale);
}

async function gotoSourceFromView() {
  const pane = $('#pdf');
  const middle = pane.getBoundingClientRect().top + pane.clientHeight / 2;
  const wrapper = [...document.querySelectorAll('.page')].find((page) => {
    const box = page.getBoundingClientRect();
    return box.top <= middle && box.bottom >= middle;
  }) || document.querySelector('.page');
  if (!wrapper) {
    setStatus('Compile first');
    return;
  }
  const box = wrapper.getBoundingClientRect();
  await jumpToSource(Number(wrapper.dataset.page), box.width / 2 / S.scale, (middle - box.top) / S.scale);
}

async function gotoPdf() {
  if (!S.active || !S.pdf) {
    setStatus('Compile first');
    return;
  }
  await saveTab(S.active);
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const { target } = await api('synctex/to_pdf', { project: S.project.root, rel: S.active, line });
  if (!target) {
    setStatus('That line is not in the PDF');
    return;
  }
  setToolsOpen(false);
  const wrapper = document.querySelector(`.page[data-page="${target.page}"]`);
  if (!wrapper) return;
  const top = target.y * S.scale;
  const pane = $('#pdf');
  pane.scrollTop = wrapper.offsetTop - pane.offsetTop + top - pane.clientHeight / 2;
  const marker = el('div', { class: 'marker' });
  marker.style.top = `${top - 11 * S.scale}px`;
  marker.style.height = `${14 * S.scale}px`;
  wrapper.append(marker);
  requestAnimationFrame(() => marker.classList.add('gone'));
  setTimeout(() => marker.remove(), 2600);
}

async function zoom(factor) {
  closeMenus();
  if (!S.pdf) return;
  S.scale = Math.min(4, Math.max(0.3, S.scale * factor));
  await layoutPages();
}

async function zoomFit() {
  if (!S.pdf) return;
  S.scale = await fitScale(S.pdf);
  await layoutPages();
}

// Tools

function setToolsOpen(open) {
  $('#tools-panel').hidden = !open;
  $('#pdf-panel').hidden = open;
  $('#tools-label').textContent = open ? 'Close' : 'Tools';
  $('#tools-icon').setAttribute('href', open ? '#i-x' : '#i-grid');
}

function setTool(name) {
  document.querySelectorAll('.tool-tab').forEach((tab) => tab.classList.toggle('on', tab.dataset.tool === name));
  document.querySelectorAll('.tool-view').forEach((pane) => { pane.hidden = pane.dataset.view !== name; });
  if (name === 'versions') renderHistory();
  if (name === 'info') renderInfo();
}

function openLogs() {
  setToolsOpen(true);
  setTool('logs');
}

function renderInfo() {
  if (!S.project) return;
  const rows = [
    ['Name', S.project.name],
    ['Folder', S.project.root],
    ['Main file', $('#main-file').value || 'None found'],
    ['Files', String(S.files.length)],
    ['Engine', 'Tectonic (XeTeX), on this Mac'],
  ];
  if (S.lastCompile) {
    const errors = S.lastCompile.diagnostics.filter((d) => d.severity === 'error').length;
    rows.push(['Last compile', `${(S.lastCompile.duration_ms / 1000).toFixed(1)} s, ${errors} error${errors === 1 ? '' : 's'}, ${S.lastCompile.diagnostics.length - errors} warning${S.lastCompile.diagnostics.length - errors === 1 ? "" : "s"}`]);
  }
  $('#info').replaceChildren(...rows.flatMap(([name, value]) => [el('dt', {}, name), el('dd', {}, value)]));
}

async function renderHistory() {
  const { commits } = await api('history/list', { project: S.project.root });
  const list = $('#history-list');
  $('#history-count').textContent = commits.length ? `Showing ${commits.length} version${commits.length === 1 ? '' : 's'}` : '';
  if (!commits.length) {
    list.replaceChildren(el('li', { class: 'muted' }, 'No saved versions yet.'));
    return;
  }
  list.replaceChildren(...commits.map((commit) => el('li', { class: 'version' },
    el('div', { class: 'info' }, commit.message,
      el('div', { class: 'muted small' }, new Date(commit.time * 1000).toLocaleString())),
    el('button', {
      type: 'button',
      class: 'pill small',
      onclick: async () => {
        await saveAll();
        try {
          await api('history/restore', { project: S.project.root, commit: commit.id });
          await refreshTree();
          for (const rel of [...S.tabs.keys()]) {
            if (S.files.includes(rel)) await reloadTab(rel);
            else await closeTab(rel);
          }
          await renderHistory();
        } catch (error) {
          $('#history-error').textContent = error.message;
          $('#history-error').hidden = false;
        }
      },
    }, 'Restore'))));
}

// Assistant

function newChat() {
  const chat = { id: null, title: 'New chat', box: el('div') };
  S.chats.unshift(chat);
  showChat(chat, false);
  renderChatList();
  return chat;
}

function showChat(chat, reveal = true) {
  S.chat = chat;
  $('#messages').replaceChildren(chat.box);
  $('#chat-panel').hidden = !reveal || !chat.box.children.length;
  renderChatList();
}

function renderChatList() {
  $('#chat-list').replaceChildren(...S.chats.map((chat) => el('li', {},
    el('button', {
      type: 'button',
      class: 'file-row' + (chat === S.chat ? ' active' : ''),
      onclick: () => showChat(chat),
    }, chat.title))));
}

function addMessage(kind, text) {
  const node = el('p', { class: `msg ${kind}` }, text);
  S.chat.box.append(node);
  $('#chat-panel').hidden = false;
  scrollMessages();
  return node;
}

function scrollMessages() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

// The model and effort menus

function effortLevels() {
  const known = S.models[S.selection?.provider]?.models.find((model) => model.id === S.selection?.model)?.efforts;
  return known ? EFFORTS.filter((level) => known.includes(level.id) || level.id === 'default') : EFFORTS;
}

// The level a request uses: the writer's choice, or the nearest one below it that this model takes.
function effortInUse() {
  const allowed = effortLevels();
  if (allowed.some((level) => level.id === S.effort)) return S.effort;
  const wanted = EFFORTS.findIndex((level) => level.id === S.effort);
  const below = allowed.filter((level) => EFFORTS.indexOf(level) < wanted && level.id !== 'default');
  return below.length ? below[below.length - 1].id : 'default';
}

function meter(bars) {
  return el('span', { class: 'meter', 'aria-hidden': 'true' }, ...meterBars(bars));
}

function meterBars(bars) {
  return [1, 2, 3, 4, 5].map((n) => {
    const bar = el('i', { class: n <= bars ? 'lit' : '' });
    bar.style.setProperty('--n', n);
    return bar;
  });
}

function swapLabel(node, text) {
  if (node.textContent === text) return;
  node.textContent = text;
  node.classList.remove('swap');
  void node.offsetWidth;
  node.classList.add('swap');
}

function renderPills() {
  const provider = S.providers.find((p) => p.id === S.selection?.provider);
  const pill = $('#model-open');
  swapLabel($('#model-label'), S.selection?.model ? S.selection.name || S.selection.model : 'Choose a model');
  pill.classList.toggle('empty', !S.selection?.model);
  pill.title = provider && S.selection?.model ? `${S.selection.name} from ${provider.name}` : '';
  const level = EFFORTS.find((row) => row.id === effortInUse());
  swapLabel($('#effort-label'), level.label);
  const bars = $('#effort-meter');
  if (!bars.children.length) bars.append(...meterBars(level.bars));
  [...bars.children].forEach((bar, index) => bar.classList.toggle('lit', index < level.bars));
}

function renderProviders() {
  $('#send').disabled = !S.providers.length;
  $('#welcome').hidden = S.providers.some((p) => p.has_key);
  renderPills();
}

async function loadProviderModels(provider) {
  if (!provider.has_key) {
    S.models[provider.id] = { state: 'nokey', models: [] };
    renderModelMenu();
    return;
  }
  S.models[provider.id] = { state: 'loading', models: S.models[provider.id]?.models || [] };
  renderModelMenu();
  try {
    const { models } = await api('provider/models', { provider: provider.id });
    S.models[provider.id] = { state: 'ready', models };
  } catch (error) {
    S.models[provider.id] = { state: 'error', models: [], error: error.message };
  }
  renderModelMenu();
  renderProviderList();
  renderPills();
}

function saveSettingsSoon() {
  clearTimeout(saveSettingsSoon.timer);
  saveSettingsSoon.timer = setTimeout(() => {
    api('settings/save', {
      appearance: S.appearance,
      selection: S.selection || { provider: '', model: '', name: '' },
      effort: S.effort,
    }).catch(() => {});
  }, 250);
}

function selectModel(provider, id, name) {
  const changed = S.selection?.provider !== provider.id || S.selection?.model !== id;
  S.selection = { provider: provider.id, model: id, name };
  saveSettingsSoon();
  renderPills();
  closePickers();
  if (changed && S.chat?.box.children.length) addMessage('tool', `Switched to ${name}.`);
  $('#prompt').focus();
}

function modelRow(provider, model, index) {
  const on = S.selection?.provider === provider.id && S.selection?.model === model.id;
  const row = el('button', {
    type: 'button',
    class: 'pick-row' + (on ? ' on' : ''),
    title: model.id,
    onclick: () => selectModel(provider, model.id, model.name),
  }, el('span', { class: 'pick-name' }, model.name), on ? icon('check') : '');
  row.style.setProperty('--i', Math.min(index, 10));
  return row;
}

function typedModelRow(provider) {
  const row = el('button', {
    type: 'button',
    class: 'pick-row quiet',
    onclick: (event) => {
      event.stopPropagation();
      const input = el('input', { type: 'text', placeholder: 'The model\'s exact name', spellcheck: false });
      input.setAttribute('aria-label', `Model name at ${provider.name}`);
      input.addEventListener('keydown', (key) => {
        if (key.key !== 'Enter') return;
        key.preventDefault();
        key.stopPropagation();
        const name = input.value.trim();
        if (name) selectModel(provider, name, name);
      });
      const box = el('div', { class: 'pick-type' }, input);
      row.replaceWith(box);
      input.focus();
    },
  }, 'Type a model name');
  return row;
}

function renderModelMenu() {
  const filter = $('#model-filter').value.trim().toLowerCase();
  const total = S.providers.reduce((sum, p) => sum + (S.models[p.id]?.models.length || 0), 0);
  $('#model-filter-row').hidden = total <= 8;
  let index = 0;
  const groups = [];
  for (const provider of S.providers) {
    const entry = S.models[provider.id] || { state: provider.has_key ? 'loading' : 'nokey', models: [] };
    const models = [...entry.models];
    if (S.selection?.provider === provider.id && S.selection.model && !models.some((m) => m.id === S.selection.model)) {
      models.unshift({ id: S.selection.model, name: S.selection.name || S.selection.model });
    }
    const shown = models.filter((m) => !filter || m.name.toLowerCase().includes(filter) || m.id.toLowerCase().includes(filter));
    if (filter && !shown.length) continue;
    const rows = shown.map((model) => modelRow(provider, model, index++));
    if (entry.state === 'loading' && !shown.length) rows.push(el('div', { class: 'pick-skeleton' }), el('div', { class: 'pick-skeleton' }));
    if (entry.state === 'nokey') rows.push(el('p', { class: 'pick-note' }, 'No key yet. Add one in Settings.'));
    if (entry.state === 'error') rows.push(el('p', { class: 'pick-note bad' }, entry.error));
    // Most providers list their models. The rest still need a way in.
    if (!filter && provider.has_key && entry.state !== 'loading' && !entry.models.length) rows.push(typedModelRow(provider));
    groups.push(el('section', { class: 'pick-group' }, el('h5', {}, provider.name), ...rows));
  }
  if (!S.providers.length) groups.push(el('p', { class: 'pick-empty' }, 'Add a provider to see its models.'));
  else if (!groups.length) groups.push(el('p', { class: 'pick-empty' }, `Nothing matches "${$('#model-filter').value.trim()}".`));
  $('#model-list').replaceChildren(...groups);
}

function renderEffortMenu() {
  const now = effortInUse();
  $('#effort-menu').replaceChildren(el('div', { class: 'picker-list stagger' }, ...effortLevels().map((level, index) => {
    const on = level.id === now;
    const row = el('button', {
      type: 'button',
      class: 'pick-row' + (on ? ' on' : ''),
      onclick: () => {
        S.effort = level.id;
        saveSettingsSoon();
        renderPills();
        closePickers();
        $('#prompt').focus();
      },
    }, meter(level.bars), el('span', { class: 'pick-name' }, level.label, el('span', { class: 'pick-hint' }, level.hint)), on ? icon('check') : '');
    row.style.setProperty('--i', index);
    return row;
  })));
}

const PICKERS = [['#model-open', '#model-menu'], ['#effort-open', '#effort-menu']];

function closePickers() {
  for (const [button, menu] of PICKERS) {
    const node = $(menu);
    if (node.hidden || node.classList.contains('closing')) continue;
    $(button).setAttribute('aria-expanded', 'false');
    node.classList.add('closing');
    clearTimeout(node.closeTimer);
    node.closeTimer = setTimeout(() => {
      node.hidden = true;
      node.classList.remove('closing');
    }, S.appearance.motion === 'none' ? 0 : 105);
  }
}

function openPicker(button, menu) {
  const node = $(menu);
  closeMenus();
  closePickers();
  clearTimeout(node.closeTimer);
  node.classList.remove('closing');
  node.hidden = false;
  $(button).setAttribute('aria-expanded', 'true');
  if (menu === '#model-menu') {
    $('#model-filter').value = '';
    renderModelMenu();
    const list = $('#model-list');
    list.classList.add('stagger');
    setTimeout(() => list.classList.remove('stagger'), 500);
    if (!$('#model-filter-row').hidden) $('#model-filter').focus();
    else (node.querySelector('.pick-row.on') || node.querySelector('.pick-row'))?.focus();
  } else {
    renderEffortMenu();
    (node.querySelector('.pick-row.on') || node.querySelector('.pick-row'))?.focus();
  }
}

function pickerKeys(event, button) {
  const rows = [...event.currentTarget.querySelectorAll('.pick-row, .picker-foot')];
  const at = rows.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePickers();
    $(button).focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  } else if (event.key === 'Enter' && event.target.id === 'model-filter') {
    event.preventDefault();
    rows[0]?.click();
  }
}

function renderProposal(proposal) {
  const decide = async (action) => {
    if (action === 'edit/apply') await saveAll();
    try {
      const result = await api(action, { project: S.project.root, proposal: proposal.id });
      await refreshTree();
      if (S.tabs.has(result.rel)) {
        if (result.status === 'undone' && result.hash === null && !S.files.includes(result.rel)) await closeTab(result.rel);
        else await reloadTab(result.rel);
      } else if (result.status === 'kept') {
        await openFile(result.rel);
      }
      update(result.status);
    } catch (error) {
      addMessage('err', error.message);
    }
  };
  const lines = proposal.diff.split('\n').map((line) => {
    let kind = '';
    if (line.startsWith('@@')) kind = 'hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) kind = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) kind = 'del';
    return el('div', { class: kind }, line || ' ');
  });
  const keep = el('button', { type: 'button', class: 'pill light small', onclick: () => decide('edit/apply') }, 'Keep');
  const undoButton = el('button', { type: 'button', class: 'pill small', onclick: () => decide('edit/undo') }, 'Undo');
  const state = el('span', { class: 'muted small' });
  const actions = el('span', { class: 'row' }, state, keep, undoButton);
  function update(status) {
    keep.hidden = true;
    undoButton.hidden = status !== 'kept';
    state.textContent = status === 'kept' ? 'Kept' : 'Undone';
  }
  S.chat.box.append(el('div', { class: 'proposal' },
    el('div', { class: 'proposal-head' }, el('span', {}, `${proposal.rel}: ${proposal.summary}`), actions),
    el('pre', {}, ...lines)));
  $('#chat-panel').hidden = false;
  scrollMessages();
}

function askConsent(provider) {
  return new Promise((resolve) => {
    const dialog = $('#consent');
    $('#consent-host').textContent = new URL(provider.base_url).host;
    const items = [`The open file${S.active ? ` (${S.active})` : ''} and your selection`, 'Your message, and the earlier messages in this chat', 'The names of the files in this project', "The last compile's errors and warnings"];
    $('#consent-list').replaceChildren(...items.map((item) => el('li', {}, item)));
    const finish = (answer) => {
      $('#consent-yes').onclick = null;
      $('#consent-no').onclick = null;
      dialog.close();
      resolve(answer);
    };
    $('#consent-yes').onclick = () => finish(true);
    $('#consent-no').onclick = () => finish(false);
    dialog.showModal();
  });
}

async function send(event) {
  event.preventDefault();
  if (S.sending) return;
  const text = $('#prompt').value.trim();
  if (!text) return;
  const provider = S.providers.find((p) => p.id === S.selection?.provider);
  if (!provider || !S.selection.model) {
    openPicker('#model-open', '#model-menu');
    return;
  }
  const chat = S.chat;
  if (!provider.has_key) {
    addMessage('err', `${provider.name} has no API key yet. Add it in Settings.`);
    return;
  }
  if (!provider.consented) {
    if (!(await askConsent(provider))) return;
    await api('provider/consent', { provider: provider.id });
    provider.consented = true;
  }
  await saveAll();
  $('#prompt').value = '';
  if (chat.title === 'New chat') {
    chat.title = text.slice(0, 40);
    renderChatList();
  }
  addMessage('user', text);
  S.sending = true;
  $('#send').hidden = true;
  $('#stop').hidden = false;
  let reply = null;
  const thinking = el('p', { class: 'msg thinking' }, 'Thinking');
  const startedAt = Date.now();
  const thinkingClock = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (seconds >= 5) thinking.textContent = `Thinking, ${seconds} s`;
  }, 1000);
  chat.box.append(thinking);
  scrollMessages();
  const selection = view.state.selection.main;
  const context = {
    rel: S.active,
    selection: selection.empty ? '' : view.state.sliceDoc(selection.from, selection.to),
  };
  try {
    await stream('assistant/send', {
      project: S.project.root,
      provider: provider.id,
      model: S.selection.model,
      effort: effortInUse(),
      conversation: chat.id,
      text,
      context,
    }, (ev) => {
      if (ev.type === 'start') {
        S.request = ev.request;
        chat.id = ev.conversation;
      } else if (ev.type === 'text') {
        thinking.remove();
        reply ??= addMessage('assistant', '');
        reply.textContent += ev.text;
        scrollMessages();
      } else if (ev.type === 'tool_call') {
        addMessage('tool', `Read ${ev.rel}`);
        reply = null;
        chat.box.append(thinking);
      } else if (ev.type === 'edit_proposal') {
        renderProposal(ev);
        reply = null;
        chat.box.append(thinking);
      } else if (ev.type === 'note') {
        addMessage('tool', ev.text);
        chat.box.append(thinking);
      } else if (ev.type === 'error') {
        addMessage('err', ev.message);
      } else if (ev.type === 'done' && ev.stopped) {
        addMessage('tool', 'Stopped.');
      }
    });
  } catch (error) {
    if (error.code === 'needs_consent') provider.consented = false;
    addMessage('err', error.message);
  }
  clearInterval(thinkingClock);
  thinking.remove();
  S.sending = false;
  S.request = null;
  $('#send').hidden = false;
  $('#stop').hidden = true;
}

// Settings

const SECTIONS = ['models', 'instructions', 'appearance'];

function showSection(name) {
  SECTIONS.forEach((section, index) => {
    const on = section === name;
    $(`#set-${section}`).hidden = !on;
    document.querySelector(`.set-tab[data-section="${section}"]`).classList.toggle('on', on);
    if (on) $('#set-tabs').style.setProperty('--on', index);
  });
  document.querySelector('.set-body').scrollTop = 0;
}

async function openSettings(section = 'models') {
  closePickers();
  closeMenus();
  await loadState();
  fillProviderForm(null);
  await loadInstructions();
  renderAppearance();
  showSection(section);
  $('#settings').showModal();
}

function closeSettings() {
  const dialog = $('#settings');
  if (S.appearance.motion === 'none') {
    dialog.close();
    return;
  }
  dialog.classList.add('closing');
  setTimeout(() => {
    dialog.classList.remove('closing');
    dialog.close();
  }, 125);
}

let modelTicket = 0;
let modelTimer = null;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function keyHint() {
  const host = hostOf($('#p-url').value);
  return `Stored in the macOS keychain. It is never shown again, and it is sent only to ${host || 'the base URL above'}.`;
}

function chipsOf(models, limit) {
  const chips = models.slice(0, limit).map((model) => el('span', { class: 'model-chip', title: model.id }, model.name));
  if (models.length > limit) chips.push(el('span', { class: 'model-chip more' }, `and ${models.length - limit} more`));
  return chips;
}

function showFound(line, models = [], isBad = false) {
  const box = $('#p-found');
  box.hidden = !line;
  box.replaceChildren(
    el('p', { class: 'found-line' + (isBad ? ' error' : '') }, line),
    ...(models.length ? [el('div', { class: 'model-chips' }, ...chipsOf(models, 8))] : []),
  );
}

async function loadFormModels() {
  const ticket = ++modelTicket;
  const key = $('#p-key').value.trim();
  const baseUrl = $('#p-url').value.trim().replace(/\/+$/, '');
  if (!key) {
    showFound('');
    return;
  }
  showFound('Looking for your models…');
  try {
    const { models } = await api('provider/models', { type: $('#p-type').value, base_url: baseUrl, key });
    if (ticket !== modelTicket) return;
    showFound(models.length ? `Found ${models.length} ${models.length === 1 ? 'model' : 'models'}. Press Save to add them.` : 'This key lists no models. You can still save it and type a model name.', models);
  } catch (error) {
    if (ticket !== modelTicket) return;
    showFound(`${error.message.replace(/\.?$/, '.')} Check the key. You can still save it if this provider has no model list.`, [], true);
  }
}

// A pasted key never follows a changed address on its own.
function setPreset(id) {
  S.preset = id;
  const preset = PRESETS.find((row) => row.id === id);
  $('#p-type').value = preset.type;
  $('#p-name').value = id === 'other' ? '' : preset.name;
  $('#p-url').value = preset.url;
  $('#p-key').value = '';
  $('#p-custom').hidden = id !== 'other';
  $('#p-key-state').textContent = keyHint();
  $('#p-error').hidden = true;
  [...$('#p-presets').children].forEach((chip) => chip.classList.toggle('on', chip.dataset.preset === id));
  loadFormModels();
}

function fillProviderForm(provider) {
  S.editingProvider = provider || null;
  $('#provider-form-title').textContent = provider ? `Edit ${provider.name}` : 'Add a provider';
  $('#p-presets').hidden = Boolean(provider);
  $('#p-clear').hidden = !provider;
  $('#p-error').hidden = true;
  if (!$('#p-presets').children.length) {
    $('#p-presets').append(...PRESETS.map((preset) => {
      const chip = el('button', { type: 'button', class: 'chip', onclick: () => setPreset(preset.id) }, preset.name);
      chip.dataset.preset = preset.id;
      return chip;
    }));
  }
  if (!provider) {
    const unused = PRESETS.find((row) => row.id !== 'other' && !S.providers.some((p) => p.base_url === row.url));
    setPreset((unused || PRESETS[PRESETS.length - 1]).id);
    $('#p-key').placeholder = 'Paste your key here';
    return;
  }
  $('#p-custom').hidden = false;
  $('#p-type').value = provider.type;
  $('#p-name').value = provider.name;
  $('#p-url').value = provider.base_url;
  $('#p-key').value = '';
  $('#p-key').placeholder = provider.has_key ? 'A key is saved. Paste to replace it.' : 'Paste your key here';
  $('#p-key-state').textContent = keyHint();
  showFound('');
}

async function loadInstructions() {
  const { text, custom } = await api('instructions/get');
  $('#instructions').value = text;
  $('#instructions-state').textContent = custom ? 'You have edited these.' : 'These are the defaults.';
}

function flashSaved(text) {
  const note = $('#instructions-saved');
  note.textContent = '';
  void note.offsetWidth;
  note.textContent = text;
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => { note.textContent = ''; }, 2400);
}

function providerStateLine(provider) {
  const entry = S.models[provider.id];
  if (!provider.has_key) return 'No key yet';
  if (entry?.state === 'loading') return 'Key saved. Loading models…';
  if (entry?.state === 'error') return `Key saved. ${entry.error}`;
  const count = entry?.models.length;
  return count ? `Key saved. ${count} ${count === 1 ? 'model' : 'models'}.` : 'Key saved';
}

function renderProviderList(fresh) {
  const box = $('#provider-list');
  box.replaceChildren(...S.providers.map((provider) => {
    const models = S.models[provider.id]?.models || [];
    return el('li', { class: 'provider-row' + (provider.id === fresh ? ' fresh' : '') },
      el('div', { class: 'provider-mono', 'aria-hidden': 'true' }, provider.name.slice(0, 1).toUpperCase()),
      el('div', { class: 'provider-name', title: provider.base_url }, provider.name),
      el('div', { class: 'provider-actions' },
        el('button', { type: 'button', class: 'link-quiet', onclick: () => fillProviderForm(provider) }, 'Edit'),
        provider.has_key ? el('button', {
          type: 'button',
          class: 'link-quiet',
          onclick: async () => {
            await api('key/delete', { provider: provider.id });
            await loadState();
            loadProviderModels(S.providers.find((p) => p.id === provider.id));
          },
        }, 'Remove key') : '',
        el('button', {
          type: 'button',
          class: 'link-quiet bad',
          onclick: async () => {
            await api('provider/delete', { provider: provider.id });
            delete S.models[provider.id];
            if (S.selection?.provider === provider.id) {
              S.selection = null;
              saveSettingsSoon();
            }
            await loadState();
            fillProviderForm(null);
          },
        }, 'Delete')),
      el('div', { class: 'provider-state' }, providerStateLine(provider)),
      ...(models.length ? [el('div', { class: 'model-chips' }, ...chipsOf(models, 8))] : []));
  }));
}

// Appearance controls

function segmented(box, options, value, onChange) {
  const at = Math.max(0, options.findIndex(([id]) => id === value));
  box.style.setProperty('--count', options.length);
  box.style.setProperty('--on', at);
  if (box.children.length) {
    [...box.querySelectorAll('button')].forEach((button, index) => button.classList.toggle('on', index === at));
    return;
  }
  box.append(el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }), ...options.map(([id, label], index) => el('button', {
    type: 'button',
    class: index === at ? 'on' : '',
    onclick: () => onChange(id),
  }, label)));
}

function setLook(changes) {
  Object.assign(S.appearance, changes);
  applyAppearance();
  renderAppearance();
  saveSettingsSoon();
}

function fillFontSelect(select, other, fonts, value, defaultLabel) {
  if (!select.options.length) {
    select.append(el('option', { value: '' }, defaultLabel), ...fonts.map((font) => el('option', { value: font }, font)),
      el('option', { value: '__other__' }, 'Other…'));
  }
  const known = !value || fonts.includes(value);
  if (select.value !== '__other__' || known) select.value = known ? value : '__other__';
  other.hidden = select.value !== '__other__';
  if (!known && document.activeElement !== other) other.value = value;
}

function renderAppearance() {
  const look = S.appearance;
  segmented($('#a-theme'), THEME_OPTIONS, look.theme, (theme) => setLook({ theme }));
  segmented($('#a-motion'), MOTION_OPTIONS, look.motion, (motion) => setLook({ motion }));

  const accent = $('#a-accent');
  const current = look.accent || '';
  if (!accent.children.length) {
    accent.append(...ACCENTS.map((color, index) => {
      const swatch = el('button', {
        type: 'button',
        class: 'swatch',
        title: index === 0 ? 'Default' : color,
        onclick: () => setLook({ accent: index === 0 ? '' : color }),
      });
      swatch.setAttribute('aria-label', index === 0 ? 'Default accent' : `Accent ${color}`);
      swatch.dataset.color = index === 0 ? '' : color;
      swatch.style.setProperty('--c', color);
      return swatch;
    }), el('input', {
      id: 'a-accent-custom',
      type: 'color',
      title: 'Any colour',
      oninput: (event) => setLook({ accent: event.target.value }),
    }));
    $('#a-accent-custom').setAttribute('aria-label', 'Any accent colour');
  }
  [...accent.querySelectorAll('.swatch')].forEach((swatch) => swatch.classList.toggle('on', swatch.dataset.color === current));
  $('#a-accent-custom').value = tokenColor('--accent').startsWith('#') ? tokenColor('--accent') : '#6e95f5';

  for (const [name, token] of [['background', '--window'], ['panel', '--panel'], ['text', '--text']]) {
    const hex = tokenColor(token);
    if (hex.startsWith('#') && hex.length === 7) $(`#a-${name}`).value = hex;
    document.querySelector(`[data-color-reset="${name}"]`).hidden = !look[name];
  }

  fillFontSelect($('#a-ui-font'), $('#a-ui-font-other'), UI_FONTS, look.uiFont, 'System');
  fillFontSelect($('#a-editor-font'), $('#a-editor-font-other'), EDITOR_FONTS, look.editorFont, 'System monospace');

  for (const [id, name, unit, digits] of [['ui-size', 'uiSize', ' px', 0], ['editor-size', 'editorSize', ' px', 0],
    ['editor-leading', 'editorLeading', '', 1], ['corners', 'corners', '', 1]]) {
    $(`#a-${id}`).value = look[name];
    $(`#a-${id}-value`).textContent = `${Number(look[name]).toFixed(digits)}${unit}`;
  }

  const textHex = tokenColor('--text');
  const backHex = tokenColor('--panel');
  const bad = textHex.startsWith('#') && backHex.startsWith('#') && textHex.length === 7 && backHex.length === 7 && contrast(textHex, backHex) < 4.5;
  $('#a-contrast').hidden = !bad;
  $('#a-contrast').textContent = bad ? 'This text colour is hard to read on these panels.' : '';
}

function wireAppearance() {
  for (const name of ['background', 'panel', 'text']) {
    $(`#a-${name}`).oninput = (event) => setLook({ [name]: event.target.value });
    document.querySelector(`[data-color-reset="${name}"]`).onclick = () => setLook({ [name]: '' });
  }
  for (const [id, name] of [['ui-size', 'uiSize'], ['editor-size', 'editorSize'], ['editor-leading', 'editorLeading'], ['corners', 'corners']]) {
    $(`#a-${id}`).oninput = (event) => setLook({ [name]: Number(event.target.value) });
  }
  for (const [id, name] of [['ui-font', 'uiFont'], ['editor-font', 'editorFont']]) {
    const select = $(`#a-${id}`);
    const other = $(`#a-${id}-other`);
    select.onchange = () => {
      if (select.value === '__other__') {
        other.hidden = false;
        other.focus();
      } else {
        setLook({ [name]: select.value });
      }
    };
    other.oninput = () => {
      const value = other.value.trim();
      if (/^[\w .,'"-]{0,80}$/.test(value)) setLook({ [name]: value });
    };
  }
  $('#a-reset').onclick = () => setLook({ ...APPEARANCE_DEFAULTS });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    syncEditorTheme();
    if ($('#settings').open) renderAppearance();
  });
}

async function loadState() {
  const state = await api('state');
  S.providers = state.providers;
  S.projects = state.projects;
  if (!S.settingsLoaded) {
    S.settingsLoaded = true;
    S.selection = state.settings.selection?.model ? state.settings.selection : null;
    S.effort = state.settings.effort || S.effort;
    if (state.settings.appearance) {
      S.appearance = { ...APPEARANCE_DEFAULTS, ...state.settings.appearance };
      applyAppearance();
    }
    S.providers.forEach(loadProviderModels);
  }
  if (S.selection && !S.providers.some((p) => p.id === S.selection.provider)) S.selection = null;
  renderProviders();
  renderProviderList();
  renderModelMenu();
  return state;
}

async function saveProvider(event) {
  event.preventDefault();
  const errorBox = $('#p-error');
  errorBox.hidden = true;
  const key = $('#p-key').value;
  const baseUrl = $('#p-url').value.trim();
  const fallbackName = PRESETS.find((row) => row.id === S.preset && row.id !== 'other')?.name || hostOf(baseUrl) || 'Provider';
  try {
    const saved = await api('provider/save', {
      id: S.editingProvider?.id,
      type: $('#p-type').value,
      name: $('#p-name').value.trim() || fallbackName,
      base_url: baseUrl,
    });
    if (key) await api('key/set', { provider: saved.id, key });
    $('#p-key').value = '';
    await loadState();
    const row = S.providers.find((p) => p.id === saved.id);
    fillProviderForm(null);
    await loadProviderModels(row);
    renderProviderList(saved.id);
    setTimeout(() => renderProviderList(), 2400);
    showFound(S.selection?.model ? '' : `${row.name} is saved. Choose a model in the menu under your message box.`);
  } catch (error) {
    $('#p-key').value = '';
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

function askText(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const dialog = $('#ask');
    $('#ask-title').textContent = title;
    const input = $('#ask-input');
    input.value = value;
    input.placeholder = placeholder;
    const finish = (answer) => {
      $('#ask-form').onsubmit = null;
      $('#ask-cancel').onclick = null;
      dialog.close();
      resolve(answer);
    };
    $('#ask-form').onsubmit = (event) => {
      event.preventDefault();
      finish(input.value.trim());
    };
    $('#ask-cancel').onclick = () => finish(null);
    dialog.showModal();
    input.select();
  });
}

const MENUS = [['#project-menu-open', '#project-menu'], ['#compile-menu-open', '#compile-menu'],
  ['#more-open', '#more-menu'], ['#import-open', '#import-menu']];

function closeMenus() {
  MENUS.forEach(([, menu]) => { $(menu).hidden = true; });
  closePickers();
}

// Project list and switching

function age(seconds) {
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  if (delta < 60) return 'now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

function renderProjects() {
  const query = $('#project-search').value.toLowerCase();
  const rows = S.projects.filter((row) => row.name.toLowerCase().includes(query));
  const list = $('#project-rows');
  if (!rows.length) {
    list.replaceChildren(el('li', { class: 'empty-list' }, query ? 'No project matches that.' : 'No projects yet. Press New, or import a zip.'));
    return;
  }
  list.replaceChildren(...rows.map((row) => el('li', {},
    el('button', { type: 'button', title: row.path, onclick: () => openProject(() => api('project/open', { path: row.path })) },
      el('span', { class: 'thumb' }),
      el('span', { class: 'row-name' }, row.name, el('div', { class: 'row-path' }, row.path)),
      el('span', { class: 'row-time' }, age(row.modified))))));
}

function showStart() {
  $('#app').hidden = true;
  $('#start').hidden = false;
  $('#start-error').hidden = true;
  renderProjects();
}

function startError(error) {
  $('#start-error').textContent = error.message;
  $('#start-error').hidden = false;
}

async function openProject(request) {
  let project;
  try {
    project = await request();
  } catch (error) {
    startError(error);
    return;
  }
  S.project = project;
  S.tabs.clear();
  S.active = null;
  S.diagnostics = [];
  S.scale = null;
  S.chats = [];
  S.lastCompile = null;
  S.pdfTask?.destroy().catch(() => {});
  S.pdf = null;
  S.pdfTask = null;
  closeMenus();
  $('#project-name').textContent = project.name;
  $('#export').href = `/api/project/export?project=${encodeURIComponent(project.root)}`;
  $('#download-pdf').removeAttribute('href');
  $('#pdf').replaceChildren(el('p', { class: 'empty' }, 'Compile to see the PDF. Double-click the PDF to jump to the source.'));
  $('#log-text').textContent = '';
  $('#diagnostics').replaceChildren();
  $('#search-box').hidden = true;
  $('#search-results').hidden = true;
  $('#tree').hidden = false;
  setToolsOpen(false);
  setTool('info');
  setStatus('Compile');
  $('#view-errors').hidden = true;
  $('#notice').hidden = true;
  $('#start').hidden = true;
  $('#app').hidden = false;
  view.setState(EditorState.create({ doc: '' }));
  renderTabs();
  renderTree();
  renderMainPicker();
  renderInfo();
  newChat();
  await loadState();
  if (project.main) await openFile(project.main);
}

async function backToProjects() {
  await saveAll();
  S.project = null;
  await loadState();
  showStart();
}

function setSideTab(chats) {
  $('#files-view').hidden = chats;
  $('#chats-view').hidden = !chats;
  $('#tab-files').classList.toggle('on', !chats);
  $('#tab-chats').classList.toggle('on', chats);
}

let searchTimer = null;

function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = $('#search-input').value;
    const box = $('#search-results');
    if (!query) {
      box.hidden = true;
      $('#tree').hidden = false;
      return;
    }
    const { results } = await api('project/search', { project: S.project.root, query });
    box.replaceChildren(...results.map((row) => el('li', {},
      el('button', { type: 'button', title: `${row.rel}:${row.line}`, onclick: () => openFile(row.rel, row.line) },
        `${row.rel}:${row.line} ${row.text}`))));
    if (!results.length) box.replaceChildren(el('li', { class: 'muted' }, 'No matches.'));
    box.hidden = false;
    $('#tree').hidden = true;
  }, 200);
}

function wire() {
  // Project list
  $('#project-search').oninput = renderProjects;
  $('#new-go').onclick = async () => {
    const name = await askText('New project', '', 'Project name');
    if (name !== null) openProject(() => api('project/new', { name }));
  };
  $('#open-folder').onclick = async () => {
    closeMenus();
    const path = await askText('Open a folder on this Mac', '', '/path/to/project');
    if (path) openProject(() => api('project/open', { path }));
  };
  $('#import-file').onchange = (event) => {
    const [file] = event.target.files;
    closeMenus();
    if (!file) return;
    openProject(async () => {
      const response = await fetch(`/api/project/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(data?.error?.message || 'Import failed', data?.error?.code);
      return data;
    });
    event.target.value = '';
  };

  // Menus
  for (const [button, menu] of MENUS) {
    $(button).onclick = (event) => {
      event.stopPropagation();
      const wasHidden = $(menu).hidden;
      closeMenus();
      $(menu).hidden = !wasHidden;
    };
    $(menu).onclick = (event) => event.stopPropagation();
  }
  document.addEventListener('click', closeMenus);

  // Sidebar
  $('#back-projects').onclick = backToProjects;
  $('#all-projects').onclick = backToProjects;
  $('#collapse').onclick = () => {
    const collapsed = $('#app').classList.toggle('collapsed');
    store('collapsed', collapsed);
  };
  $('#app').classList.toggle('collapsed', remember('collapsed', false));
  $('#tab-files').onclick = () => setSideTab(false);
  $('#tab-chats').onclick = () => setSideTab(true);
  $('#search-toggle').onclick = () => {
    setSideTab(false);
    const box = $('#search-box');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#search-input').focus();
    else {
      $('#search-results').hidden = true;
      $('#tree').hidden = false;
    }
  };
  $('#search-input').oninput = onSearchInput;
  $('#new-file').onclick = async () => {
    const rel = await askText('New file', '', 'chapters/intro.tex');
    if (!rel) return;
    try {
      await api('file/write', { project: S.project.root, rel, text: '', expected_hash: null });
      await refreshTree();
      await openFile(rel);
    } catch (error) {
      showNotice(error.message);
    }
  };
  $('#outline-toggle').onclick = () => {
    const closed = $('#outline-toggle').parentElement.classList.toggle('closed');
    $('#outline-toggle').setAttribute('aria-expanded', String(!closed));
  };
  const duplicate = async () => {
    closeMenus();
    await saveAll();
    try {
      await openProject(() => api('project/duplicate', { project: S.project.root }));
    } catch (error) {
      showNotice(error.message);
    }
  };
  $('#duplicate').onclick = duplicate;
  $('#duplicate-menu').onclick = duplicate;
  $('#rename-project').onclick = async () => {
    closeMenus();
    const name = await askText('Rename project', S.project.name);
    if (!name || name === S.project.name) return;
    await saveAll();
    try {
      const project = await api('project/rename', { project: S.project.root, name });
      await openProject(async () => project);
    } catch (error) {
      showNotice(error.message);
    }
  };

  // Compile and PDF
  $('#compile').onclick = compile;
  $('#view-errors').onclick = openLogs;
  $('#cancel').onclick = () => api('compile/cancel', { project: S.project.root });
  $('#main-file').onchange = renderInfo;
  $('#realtime').checked = S.realtime;
  $('#realtime').onchange = (event) => {
    S.realtime = event.target.checked;
    store('realtime', S.realtime);
  };
  $('#zoom-in').onclick = () => zoom(1.2);
  $('#zoom-out').onclick = () => zoom(1 / 1.2);
  $('#zoom-fit').onclick = zoomFit;
  $('#undo').onclick = () => { undo(view); view.focus(); };
  $('#redo').onclick = () => { redo(view); view.focus(); };
  $('#goto-pdf').onclick = gotoPdf;
  $('#goto-pdf-arrow').onclick = gotoPdf;
  $('#goto-source').onclick = gotoSourceFromView;

  let dragging = false;
  $('#split').onpointerdown = (event) => {
    dragging = true;
    event.target.setPointerCapture(event.pointerId);
  };
  $('#split').onpointermove = (event) => {
    if (!dragging) return;
    const width = Math.max(280, window.innerWidth - event.clientX - 3);
    $('#app').style.setProperty('--right-width', `${width}px`);
  };
  $('#split').onpointerup = () => { dragging = false; };

  // Tools
  $('#tools-toggle').onclick = () => {
    const opening = $('#tools-panel').hidden;
    setToolsOpen(opening);
    if (opening) setTool(document.querySelector('.tool-tab.on').dataset.tool);
  };
  document.querySelectorAll('.tool-tab').forEach((tab) => { tab.onclick = () => setTool(tab.dataset.tool); });
  $('#history-form').onsubmit = async (event) => {
    event.preventDefault();
    await saveAll();
    try {
      const { commit } = await api('history/commit', { project: S.project.root, message: $('#history-message').value });
      if (!commit) {
        $('#history-error').textContent = 'Nothing changed since the last version.';
        $('#history-error').hidden = false;
      } else {
        $('#history-error').hidden = true;
      }
      $('#history-message').value = '';
      await renderHistory();
    } catch (error) {
      $('#history-error').textContent = error.message;
      $('#history-error').hidden = false;
    }
  };

  // Assistant
  $('#composer').onsubmit = send;
  $('#prompt').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
  };
  $('#stop').onclick = () => { if (S.request) api('assistant/stop', { request: S.request }); };
  $('#new-chat').onclick = () => {
    newChat();
    setSideTab(false);
    $('#prompt').focus();
  };
  $('#chat-hide').onclick = () => { $('#chat-panel').hidden = true; };
  $('#chat-tab').onclick = () => {
    if (S.chat?.box.children.length) $('#chat-panel').hidden = !$('#chat-panel').hidden;
    $('#prompt').focus();
  };

  // Model and effort menus
  for (const [button, menu] of PICKERS) {
    $(button).onclick = (event) => {
      event.stopPropagation();
      const open = !$(menu).hidden && !$(menu).classList.contains('closing');
      if (open) closePickers();
      else openPicker(button, menu);
    };
    $(menu).onclick = (event) => event.stopPropagation();
    $(menu).onkeydown = (event) => pickerKeys(event, button);
  }
  $('#model-filter').oninput = renderModelMenu;
  $('#model-manage').onclick = () => openSettings('models');

  // Settings
  $('#open-settings').onclick = () => openSettings();
  $('#start-settings').onclick = () => openSettings();
  $('#welcome-settings').onclick = () => openSettings();
  $('#settings-close').onclick = closeSettings;
  document.querySelectorAll('.set-tab').forEach((tab) => {
    tab.onclick = () => {
      showSection(tab.dataset.section);
      if (tab.dataset.section === 'appearance') renderAppearance();
    };
  });
  $('#provider-form').onsubmit = saveProvider;
  $('#p-clear').onclick = () => fillProviderForm(null);
  // A pasted key never follows a changed address on its own.
  $('#p-type').onchange = () => {
    $('#p-key').value = '';
    showFound('');
  };
  $('#p-url').onchange = () => {
    $('#p-key').value = '';
    $('#p-key-state').textContent = keyHint();
    showFound('');
  };
  $('#p-key').oninput = () => {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(loadFormModels, 300);
  };
  $('#instructions-form').onsubmit = async (event) => {
    event.preventDefault();
    await api('instructions/save', { text: $('#instructions').value });
    await loadInstructions();
    flashSaved('Saved');
  };
  $('#instructions-reset').onclick = async () => {
    await api('instructions/save', { text: '' });
    await loadInstructions();
    flashSaved('Back to the defaults');
  };
  wireAppearance();
  window.addEventListener('beforeunload', () => { saveAll(); });
}

wire();
loadState().then(showStart).catch((error) => {
  document.body.textContent = error.message;
});
