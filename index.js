/**
 * 柠檬总结 (Ningmeng Summary) — SillyTavern 1.18+
 *
 * 与"把总结写进世界书"的插件不同，本扩展直接改写 chat[i].mes：
 * 选中的楼层被替换成一条普通角色消息（压缩记录）。
 * 因为 SillyTavern 构建提示词时只读取 chat[i].mes，所以这既改变了
 * 用户往上翻时看到的内容，也真实减少了发给模型的上下文 token。
 *
 * 不使用 is_system 消息（会被 ST 从上下文中过滤），不写世界书。
 */
'use strict';

/**
 * 资源路径一律基于模块自身 URL 解析。
 * ST 会把扩展克隆到以 GitHub 仓库名命名的目录（用户目录或全局目录均可），
 * 因此不能写死任何目录名，否则换个仓库名就找不到 panel.html。
 */
const PANEL_FILE_URL = new URL('./panel.html', import.meta.url);
const LS_CONFIG = 'ccx.config.v1';
const LS_UI = 'ccx.ui.v1';
const MARK = 'ccx_compressed';
const DB_NAME = 'ccx_backups_v1';
const DB_STORE = 'snapshots';

/* ---------------- 默认提示词（自行编写，不依赖任何外部预设） ---------------- */

const PRESETS = {
    balanced: `你是一名「对话历史压缩器」。把下面这段角色扮演聊天记录，改写成一份紧凑、可以直接当作上文继续使用的「前情记录」。

写作要求：
1. 只记录已经发生的事实：谁做了什么、说了什么关键信息、场景与时间的推进、人物关系与状态的变化、已经确立的设定／物品／地点／数字，以及尚未解决的冲突与伏笔。
2. 删掉寒暄、重复的心理与氛围描写、无信息量的对白和纯修辞；但任何会影响后续剧情的具体名称、数字、约定、承诺、伤势、位置都必须保留。
3. 严格按发生顺序输出，每条一行，以「- 」开头，每行只写一件事。使用原文中的角色名，使用第三人称。
4. 不要评价、不要续写、不要给建议，不要出现「用户」「AI」「摘要」「本文」「上文」这类元叙述，不要写标题、解释或代码块。
5. 输出语言与原文主要语言保持一致。结果长度控制在原文的 1/5 到 1/3；原文很长时优先保留信息密度高的事件。
6. 只输出记录正文。`,

    compact: `你是「对话历史压缩器」。把下面的聊天记录压成极简前情记录。

只保留会改变后续剧情走向的事件：关键决定、关系变化、新设定、未解决的冲突、重要的数字与名称。
按发生顺序，每条一行，以「- 」开头，每行不超过 30 字，使用原文角色名。
不要描写、不要评价、不要续写、不要标题、不要解释。
结果长度控制在原文的 1/10 以内，只输出记录正文。`,

    detailed: `你是「对话历史压缩器」。把下面的聊天记录改写成一份信息完整的前情记录，用于替代原文进入后续上下文。

要求：
1. 按发生顺序，逐条记录可见的动作、关键对白、场景与时间推进、人物状态与关系变化、已确立的设定与物品、未解决的冲突与伏笔。
2. 保留影响后续剧情的具体名称、数字、时间、位置、承诺与约定；删去重复铺陈与纯氛围描写。
3. 每条一行，以「- 」开头；必要时可在事件后补一句简短的因果说明。
4. 使用原文角色名与第三人称，不要评价、不要续写、不要元叙述、不要标题或代码块。
5. 结果长度控制在原文的 1/2 以内，语言与原文主要语言一致，只输出记录正文。`,
};

const DEFAULT_BLOCK_TEMPLATE = `【前情压缩 · 原第 {from}–{to} 楼】\n{summary}`;
const GUIDE_TEXT = '（以上为已发生剧情的压缩记录，请把它视作真实发生过的上文，在此基础上自然延续。）';
const DEFAULT_RECOMPRESS_PROMPT = `把下面几段「前情压缩记录」合并成一份更紧凑的记录。
规则：去掉重复事件，按时间顺序重排；保留全部关键事实、未解决的冲突与伏笔；不要新增、不要推测、不要续写。
输出格式与输入一致：每条一行，以「- 」开头，只输出记录正文。`;

const DEFAULT_CONFIG = {
    api: { url: '', key: '', modelsPath: '/models', chatPath: '/chat/completions', model: '', proxy: '' },
    jailbreak: '',
    taskPrompt: PRESETS.balanced,
    preset: 'balanced',
    blockTemplate: DEFAULT_BLOCK_TEMPLATE,
    recompressPrompt: DEFAULT_RECOMPRESS_PROMPT,
    manual: { from: 0, to: 0, chunk: 10, mode: 'chunk', skipCompressed: true },
    // 输出字数：off / ratio(按原文百分比) / perChunk(每段固定字数) / total(整次总字数，均分到各段)
    length: { mode: 'off', ratio: 20, perChunk: 300, total: 800, override: true },
    // 请求节流：避免批量压缩连续发请求被上游风控
    throttle: { enabled: true, gapSec: 2, minSec: 5, maxSec: 15, pauseSec: 0 },
    auto: { enabled: false, interval: 10, chunk: 10, keep: 6, trigger: 'received', cooldownSec: 120, maxChunks: 3, log: [] },
    adv: {
        temperature: 0.3, sendTemp: true, maxTokens: 4096, tokenField: 'max_tokens',
        timeout: 600, maxInput: 0, blockRole: 'assistant', addGuide: true,
        inlineBackup: true, showBall: true,
    },
};

/* ---------------- 基础工具（必须先于全局状态初始化） ---------------- */

const $id = (id) => document.getElementById(id);
const getCtx = () => globalThis.SillyTavern?.getContext?.() ?? null;
const getChat = () => getCtx()?.chat ?? [];
function clone(obj) {
    if (typeof globalThis.structuredClone === 'function') {
        try { return globalThis.structuredClone(obj); } catch { /* noop */ }
    }
    try { return JSON.parse(JSON.stringify(obj)); } catch { return { ...obj }; }
}
const clampInt = (v, min, max, fallback) => {
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/* ---------------- 全局状态 ---------------- */

let config = loadConfig();
let uiState = loadUI();
let busy = false;
let stopFlag = false;
let activeController = null;
let lastRequestAt = 0;
let isGenerating = false;
let lastAutoRunAt = 0;
let statsTimer = null;
let autoTimer = null;
let autoRunning = false;
let decorateTimer = null;
let panelReady = false;
let ballEl = null;
let panelEl = null;

function mergeConfig(target, src) {
    if (!src || typeof src !== 'object') return target;
    for (const k of Object.keys(src)) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && target[k] && typeof target[k] === 'object') {
            mergeConfig(target[k], src[k]);
        } else if (src[k] !== undefined) {
            target[k] = src[k];
        }
    }
    return target;
}
function loadConfig() {
    const base = clone(DEFAULT_CONFIG);
    try {
        const raw = localStorage.getItem(LS_CONFIG);
        if (!raw) return base;
        const merged = mergeConfig(base, JSON.parse(raw));
        // v1.4.3：旧默认超时 180 秒对长文本/慢模型太短，自动升级一次
        if (merged.adv?.timeout === 180) merged.adv.timeout = 600;
        return merged;
    } catch (e) {
        console.warn('[ContextCompressor] 配置读取失败，使用默认值', e);
        return base;
    }
}
function saveConfig() {
    try { localStorage.setItem(LS_CONFIG, JSON.stringify(config)); } catch (e) { console.warn('[ContextCompressor] 配置保存失败', e); }
}
function loadUI() {
    try { return JSON.parse(localStorage.getItem(LS_UI)) || {}; } catch { return {}; }
}
function saveUI() {
    try { localStorage.setItem(LS_UI, JSON.stringify(uiState)); } catch { /* noop */ }
}

/* ---------------- 日志 / 提示 ---------------- */

function log(msg, kind = '') {
    const box = $id('ccx-log');
    const st = $id('ccx-status');
    if (st) st.textContent = String(msg);
    if (!box) return;
    const d = document.createElement('div');
    if (kind) d.className = `ccx-log-${kind}`;
    d.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 120) box.removeChild(box.firstChild);
}
function toast(msg, type = 'info') {
    try {
        const fn = globalThis.toastr?.[type] ?? globalThis.toastr?.info;
        if (typeof fn === 'function') fn.call(globalThis.toastr, String(msg), '柠檬总结', { timeOut: 4200 });
    } catch { /* noop */ }
    log(msg, type === 'error' ? 'err' : type === 'success' ? 'ok' : '');
}
function setStatus(text, ok) {
    const el = $id('ccx-api-status');
    if (el) { el.textContent = text; el.style.color = ok === true ? 'var(--ccx-good)' : ok === false ? 'var(--ccx-bad)' : ''; }
}
function setProgress(done, total, text) {
    const wrap = $id('ccx-progress');
    if (!wrap) return;
    wrap.hidden = false;
    const bar = $id('ccx-progress-bar');
    if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    const t = $id('ccx-progress-text');
    if (t) t.textContent = text || '';
}
function hideProgressLater() {
    setTimeout(() => { const p = $id('ccx-progress'); if (p && !busy) p.hidden = true; }, 2500);
}
function setBusy(v) {
    busy = v;
    const run = $id('ccx-btn-run');
    const stop = $id('ccx-btn-stop');
    if (run) run.disabled = v;
    if (stop) stop.disabled = !v;
    if (ballEl) ballEl.classList.toggle('ccx-busy', v);
}
function appendAutoLog(text) {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
    config.auto.log = Array.isArray(config.auto.log) ? config.auto.log : [];
    config.auto.log.unshift(line);
    config.auto.log = config.auto.log.slice(0, 30);
    saveConfig();
    const box = $id('ccx-auto-log');
    if (box) box.textContent = config.auto.log.join('\n');
}

/* ---------------- 通用工具 ---------------- */

function estimateTokens(text) {
    const s = String(text || '');
    const cjk = (s.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.round(cjk + (s.length - cjk) / 4);
}
async function countTokensSafe(text) {
    // 刻意不调用 ST 的 getTokenCountAsync：OpenAI 主连接下它会向
    // /api/tokenizers/openai/count 发 POST，整段聊天每次变化都会多一个请求。
    // 面板只需要估算值，纯本地计算即可，避免放大聊天请求数。
    return estimateTokens(text);
}
function cleanSummary(text) {
    let t = String(text || '').trim();
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
    t = t.replace(/^```[a-zA-Z0-9_+-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    // 避免被 ST 的宏替换 / markdown 解析误伤
    t = t.replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝');
    t = t.replace(/</g, '〈').replace(/>/g, '〉');
    return t.trim();
}
/** 计算本次请求的目标字数；返回 null 表示不限制（沿用提示词自己的长度要求） */
function computeTargetChars(originalChars, segmentCount = 1) {
    const cfg = config.length || DEFAULT_CONFIG.length;
    const mode = cfg.mode || 'off';
    const chars = Math.max(1, Number(originalChars) || 0);
    if (mode === 'ratio') {
        const pct = Math.min(100, Math.max(1, Number(cfg.ratio) || 20));
        return Math.max(30, Math.round(chars * pct / 100));
    }
    if (mode === 'perChunk') {
        return Math.max(30, Math.round(Number(cfg.perChunk) || 300));
    }
    if (mode === 'total') {
        const total = Math.max(30, Math.round(Number(cfg.total) || 800));
        return Math.max(30, Math.round(total / Math.max(1, segmentCount)));
    }
    return null;
}
/** 生成高优先级长度指令；作为 system 提示词的最后一段注入 */
function describeLengthMode() {
    const cfg = config.length || DEFAULT_CONFIG.length;
    if (cfg.mode === 'ratio') return `按原文的 ${cfg.ratio}%`;
    if (cfg.mode === 'perChunk') return `每段约 ${cfg.perChunk} 字`;
    if (cfg.mode === 'total') return `整次共约 ${cfg.total} 字（自动均分到各段）`;
    return '不限制（沿用提示词里的长度要求）';
}
function buildLengthInstruction(targetChars, originalChars) {
    if (!targetChars) return '';
    const override = config.length?.override !== false;
    const head = override
        ? '【本次输出长度要求｜优先级最高，覆盖前面提示词里所有关于长度 / 篇幅的描述】'
        : '【本次输出长度要求｜若与前面提示词冲突，以前面的描述为准】';
    return `${head}\n本次压缩结果请控制在约 ${targetChars} 字（本次原文约 ${originalChars} 字），允许上下浮动 15%，但不要超过 ${Math.round(targetChars * 1.15)} 字。\n`
        + '字数不够时优先删去氛围描写、重复动作与无信息量对白，不得删掉具体名称、数字、时间、约定、未解决的冲突与伏笔。\n'
        + '仍然只输出记录正文，不要写标题、解释，也不要提及这段长度要求。';
}
function renderBlockTemplate(from, to, summary) {
    const tpl = String(config.blockTemplate || DEFAULT_BLOCK_TEMPLATE);
    return tpl
        .replace(/\{from\}/g, () => String(from))
        .replace(/\{to\}/g, () => String(to))
        .replace(/\{summary\}/g, () => String(summary));
}
function truncateMiddle(s, max) {
    if (!max || s.length <= max) return s;
    const head = Math.floor(max * 0.62);
    const tail = Math.max(200, max - head - 60);
    return `${s.slice(0, head)}\n\n…〔原文中间约 ${s.length - max} 字过长已略去，请依据剩余内容压缩〕…\n\n${s.slice(-tail)}`;
}
function friendlyError(e) {
    const m = String(e?.message || e || '未知错误');
    if (/Failed to fetch|NetworkError|Load failed|TypeError/i.test(m)) {
        return '浏览器无法直连该端点（常见于 CORS 跨域限制或地址错误）。请换用支持跨域的 API，或在「高级」填写代理前缀。';
    }
    if (/abort/i.test(m)) return '请求已取消';
    return m.slice(0, 400);
}

/* ---------------- 请求节流 / 随机延迟 ---------------- */

function randBetween(minSec, maxSec) {
    const a = Math.max(0, Number(minSec) || 0);
    const b = Math.max(a, Number(maxSec) || 0);
    return (a + Math.random() * (b - a)) * 1000;
}
/** 分片等待，期间可随时中止（用户点「停止」时不必干等） */
async function pacedWait(ms, shouldAbort, onTick) {
    let left = Math.max(0, Number(ms) || 0);
    while (left > 0) {
        if (shouldAbort?.()) throw new Error('请求已取消');
        const step = Math.min(200, left);
        await new Promise(r => setTimeout(r, step));
        left -= step;
        onTick?.(left);
    }
}
/** 段间停顿：填了固定秒数就用固定值，否则用随机区间 */
function computeChunkPause(thr) {
    const t = thr || config.throttle || DEFAULT_CONFIG.throttle;
    const pause = Math.max(0, Number(t.pauseSec) || 0);
    return pause > 0 ? pause * 1000 : randBetween(t.minSec, t.maxSec);
}
/** 任意两次生成请求之间的随机最小间隔；GET /models 等管理请求不受影响 */
async function throttleBeforeRequest() {
    const t = config.throttle || DEFAULT_CONFIG.throttle;
    if (!t.enabled) return;
    const gap = Math.max(0, Number(t.gapSec) || 0);
    const targetMs = randBetween(gap, gap * 2);
    const wait = Math.max(0, targetMs - (Date.now() - lastRequestAt));
    if (wait > 0) {
        log(`请求节流：随机等待 ${(wait / 1000).toFixed(1)} 秒`);
        await pacedWait(wait, () => stopFlag);
    }
    lastRequestAt = Date.now();
}

/* ---------------- API ---------------- */

function buildApiUrl(path) {
    const proxy = String(config.api.proxy || '').trim().replace(/\/+$/, '');
    const base = proxy || String(config.api.url || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 API 基础 URL');
    let p = String(path || '').trim();
    if (p && !p.startsWith('/')) p = `/${p}`;
    return base + p;
}
async function apiFetch(path, body, timeoutSec) {
    const url = buildApiUrl(path); // 先做参数校验，避免配置没填好还白等几秒
    // 只对 POST（生成 / 压缩）节流，模型列表等 GET 请求保持即时
    if (body) await throttleBeforeRequest();
    const headers = { 'Content-Type': 'application/json' };
    if (config.api.key) headers['Authorization'] = `Bearer ${config.api.key}`;
    const ctrl = new AbortController();
    activeController = ctrl;
    const timer = setTimeout(() => ctrl.abort('timeout'), Math.max(5, Number(timeoutSec) || 600) * 1000);
    try {
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 300); } catch { /* noop */ }
            throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` · ${detail}` : ''}`);
        }
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError' || ctrl.signal.aborted) throw new Error('请求已取消或超时');
        throw e;
    } finally {
        clearTimeout(timer);
        if (activeController === ctrl) activeController = null;
    }
}
function extractContent(data) {
    let c = data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.message?.content
        ?? data?.content
        ?? data?.response
        ?? '';
    if (Array.isArray(c)) c = c.map(x => typeof x === 'string' ? x : (x?.text ?? '')).join('');
    return typeof c === 'string' ? c : '';
}
async function callChat(messages, maxTokensOverride) {
    if (!config.api.model) throw new Error('请先选择或填写模型');
    const body = {
        model: String(config.api.model),
        messages,
        stream: false,
    };
    if (config.adv.sendTemp) body.temperature = Number(config.adv.temperature) || 0;
    const field = config.adv.tokenField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
    body[field] = Number(maxTokensOverride ?? config.adv.maxTokens) || 4096;
    const data = await apiFetch(config.api.chatPath, body, config.adv.timeout);
    const content = extractContent(data);
    if (!content.trim()) throw new Error('模型返回内容为空（推理模型可能需要更大的 max_tokens，或结果在其它字段）');
    return { content, usage: data?.usage ?? null, raw: data };
}
async function requestSummary(originalText, promptText, targetChars = null) {
    const lengthInstruction = buildLengthInstruction(targetChars, String(originalText || '').length);
    const systemParts = [
        String(config.jailbreak || '').trim(),
        String(promptText || PRESETS.balanced).trim(),
        lengthInstruction,
    ].filter(Boolean);
    const messages = [
        { role: 'system', content: systemParts.join('\n\n----\n\n') || PRESETS.balanced },
        { role: 'user', content: `以下是需要压缩的聊天记录原文：\n\n${originalText}\n\n请严格按照系统提示的要求输出压缩结果。` },
    ];
    // 目标字数较大时自动抬高 max_tokens，避免结果被 API 截断
    const baseTokens = Number(config.adv.maxTokens) || 4096;
    const needed = targetChars ? Math.ceil(targetChars * 2) + 256 : 0;
    const { content } = await callChat(messages, Math.max(baseTokens, needed));
    const cleaned = cleanSummary(content);
    if (!cleaned) throw new Error('模型返回内容清洗后为空');
    return cleaned;
}
async function loadModels() {
    const data = await apiFetch(config.api.modelsPath || '/models', null, 40);
    const raw = Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.models) ? data.models
            : Array.isArray(data) ? data : [];
    const ids = raw.map(m => typeof m === 'string' ? m : (m?.id ?? m?.name ?? m?.model ?? '')).filter(Boolean).map(String);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
async function testConnection(silent = false) {
    try {
        const ids = await loadModels();
        fillModelSelect(ids);
        setStatus(`✓ 连接成功 · 发现 ${ids.length} 个模型 · ${String(config.api.url || config.api.proxy).slice(0, 60)}`, true);
        if (!silent) toast(`连接成功，发现 ${ids.length} 个模型`, 'success');
        return ids;
    } catch (e) {
        const msg = friendlyError(e);
        setStatus(`✗ 连接失败 · ${msg}`, false);
        if (!silent) toast(`连接失败：${msg}`, 'error');
        return null;
    }
}
async function testGeneration() {
    try {
        setStatus('正在发送最小生成请求…');
        const { content, usage } = await callChat(
            [{ role: 'user', content: '只回复两个字：正常' }],
            32,
        );
        const used = usage?.total_tokens ? ` · 消耗 ${usage.total_tokens} token` : '';
        setStatus(`✓ 生成正常 · 返回「${content.trim().slice(0, 20)}」${used}`, true);
        toast('生成测试通过', 'success');
    } catch (e) {
        const msg = friendlyError(e);
        setStatus(`✗ 生成失败 · ${msg}`, false);
        toast(`生成失败：${msg}`, 'error');
    }
}
function fillModelSelect(ids) {
    const sel = $id('ccx-model-select');
    if (!sel) return;
    const current = String(config.api.model || '');
    sel.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— 请选择 —';
    sel.appendChild(empty);
    for (const id of ids) {
        const o = document.createElement('option');
        o.value = id; o.textContent = id;
        sel.appendChild(o);
    }
    if (current) {
        if (!ids.includes(current)) {
            const o = document.createElement('option');
            o.value = current; o.textContent = `${current} (已保存)`;
            sel.appendChild(o);
        }
        sel.value = current;
    }
    const st = $id('ccx-model-status');
    if (st) st.textContent = `当前模型：${current || '未选择'}${ids.length ? ` · 已加载 ${ids.length} 个模型` : ''}`;
}

/* ---------------- 压缩核心 ---------------- */

function formatOriginal(chat, indices) {
    return indices.map(i => {
        const m = chat[i] || {};
        const who = m.is_system ? '系统' : (m.is_user ? (m.name || '用户') : (m.name || '角色'));
        const body = String(m.mes ?? '').replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝');
        return `〔第 ${i} 楼 · ${who}〕\n${body}`;
    }).join('\n\n');
}
function splitSegments(chat, from, to, chunk, skipCompressed, mergeAll) {
    const segs = [];
    let cur = [];
    const flush = () => { if (cur.length) { segs.push({ indices: [...cur] }); cur = []; } };
    if (mergeAll) {
        for (let i = from; i <= to; i++) {
            if (!chat[i]) continue;
            if (skipCompressed && chat[i].extra?.[MARK]) continue;
            cur.push(i);
        }
        flush();
        return segs;
    }
    const size = Math.max(1, Number(chunk) || 10);
    for (let i = from; i <= to; i++) {
        const m = chat[i];
        if (!m) continue;
        if (skipCompressed && m.extra?.[MARK]) { flush(); continue; }
        cur.push(i);
        if (cur.length >= size) flush();
    }
    flush();
    return segs;
}
/** 取压缩块里每条原文对应的「压缩前楼层号」，兼容没有 ccx_floors 的旧数据 */
function getBlockFloors(m) {
    const e = m?.extra;
    const originals = Array.isArray(e?.ccx_original) ? e.ccx_original : [];
    if (Array.isArray(e?.ccx_floors) && e.ccx_floors.length === originals.length) {
        return e.ccx_floors.slice();
    }
    const start = Array.isArray(e?.ccx_range) ? Number(e.ccx_range[0]) || 0 : 0;
    return Array.from({ length: originals.length }, (_, k) => start + k);
}

function makeBlock(summary, indices, originals, stats, fallbackSource, floorsOverride) {
    const ctx = getCtx();
    const from = indices[0];
    const to = indices[indices.length - 1];
    let text = renderBlockTemplate(from, to, summary);
    if (config.adv.addGuide) text += `\n\n${GUIDE_TEXT}`;
    const asUser = config.adv.blockRole === 'user';
    const src = (originals && originals[0]) || fallbackSource || {};
    const name = asUser
        ? (src.is_user ? src.name : (ctx?.name1 || '用户'))
        : (src.name || ctx?.name2 || '角色');
    const extra = {
        [MARK]: true,
        ccx_version: 1,
        ccx_range: [from, to],
        ccx_count: indices.length,
        ccx_created: Date.now(),
        ccx_model: String(config.api.model || ''),
        ccx_stats: stats,
    };
    if (config.adv.inlineBackup && Array.isArray(originals) && originals.length) {
        extra.ccx_original = originals;
        extra.ccx_floors = (Array.isArray(floorsOverride) && floorsOverride.length === originals.length)
            ? floorsOverride.slice()
            : indices.slice();
    }
    return {
        name,
        is_user: asUser,
        is_system: false,
        send_date: src.send_date ?? Date.now(),
        mes: text,
        swipe_id: 0,
        swipes: [text],
        extra,
    };
}
function applyReplacements(reps, targetChat) {
    const chat = targetChat || getChat();
    const sorted = [...reps].sort((a, b) => b.indices[0] - a.indices[0]);
    for (const r of sorted) {
        const idxs = [...r.indices].sort((a, b) => a - b);
        for (let k = idxs.length - 1; k >= 0; k--) chat.splice(idxs[k], 1);
        chat.splice(idxs[0], 0, r.message);
    }
}
async function persist() {
    // 不再等待生成结束：旧版阻塞等待会让压缩看起来"卡住"，
    // 且 ST 生成异常漏发结束事件时会一直挂住。写入直接进行。
    const ctx = getCtx();
    try { await ctx?.saveChat?.(); } catch (e) { log(`保存聊天失败：${e?.message || e}`, 'err'); }
    try { await ctx?.printMessages?.(); } catch (e) { log(`重绘聊天失败：${e?.message || e}`, 'err'); }
    decorateBlocks();
    refreshStats();
    updateBadge();
}
function getPendingInfo() {
    const chat = getChat();
    let anchor = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.extra?.[MARK]) { anchor = i; break; }
    }
    const keep = Math.max(0, Number(config.auto.keep) || 0);
    const end = chat.length - 1 - keep;
    const start = anchor + 1;
    return { anchor, start, end, pending: Math.max(0, end - start + 1) };
}

/** 自动压缩单次最多处理几段，0 = 不限 */
function capAutoSegments(segments) {
    const cap = Math.max(0, Number(config.auto.maxChunks) || 0);
    return cap > 0 && segments.length > cap ? segments.slice(0, cap) : segments;
}

async function runCompression({ from, to, chunk, mode, skip, reason = '手动' }) {
    if (busy) { toast('已有压缩任务在运行', 'warning'); return; }
    const chat = getChat();
    if (!chat.length) { toast('当前没有聊天记录', 'warning'); return; }
    from = clampInt(from, 0, chat.length - 1, 0);
    to = clampInt(to, 0, chat.length - 1, chat.length - 1);
    if (from > to) [from, to] = [to, from];
    let segments = splitSegments(chat, from, to, chunk, !!skip, mode === 'merge');
    // 自动压缩限制单次请求数：一次只处理前几段，剩下的等冷却结束后再继续
    if (reason === '自动') {
        const before = segments.length;
        segments = capAutoSegments(segments);
        if (segments.length < before) {
            log(`自动压缩单次上限：本次只处理前 ${segments.length} 段，其余留到冷却后继续`);
        }
    }
    if (!segments.length) { toast('选中范围内没有可压缩的消息', 'warning'); return; }
    if (!String(config.api.url || config.api.proxy).trim()) {
        toast('请先在「API」页填写并保存连接配置', 'error'); switchTab('api'); return;
    }
    if (!String(config.api.model || '').trim()) {
        toast('请先选择或填写模型', 'error'); switchTab('api'); return;
    }

    stopFlag = false;
    setBusy(true);
    log(`${reason}压缩开始：楼层 ${from}–${to}，共 ${segments.length} 段，模型 ${config.api.model}`);
    if ((config.length?.mode || 'off') !== 'off') log(`输出字数：${describeLengthMode()}`);
    if (reason === '自动') appendAutoLog(`触发压缩：${from}–${to} 楼，${segments.length} 段`);

    const reps = [];
    let okCount = 0;
    let failCount = 0;
    try {
        // 压缩前自动留一份快照，任何情况下都能整体回滚
        try {
            await putSnapshot(chat, `${reason}压缩前自动快照`);
        } catch (e) {
            log(`自动快照失败（不影响压缩）：${e?.message || e}`, 'err');
        }

        for (let i = 0; i < segments.length; i++) {
            if (stopFlag) { log('已收到停止指令，提前结束'); break; }
            const seg = segments[i];
            const first = seg.indices[0];
            const last = seg.indices[seg.indices.length - 1];
            setProgress(i, segments.length, `第 ${i + 1}/${segments.length} 段 · 楼层 ${first}–${last}（${seg.indices.length} 条）`);
            try {
                const originals = seg.indices.map(idx => chat[idx]);
                const originalText = formatOriginal(chat, seg.indices);
                const inputText = truncateMiddle(originalText, Number(config.adv.maxInput) || 0);
                const targetChars = computeTargetChars(inputText.length, segments.length);
                const summary = await requestSummary(inputText, config.taskPrompt, targetChars);
                const beforeChars = originals.reduce((s, m) => s + String(m?.mes ?? '').length, 0);
                const stats = {
                    beforeChars,
                    afterChars: summary.length,
                    targetChars: targetChars || 0,
                    beforeTokens: estimateTokens(originalText),
                    afterTokens: estimateTokens(summary),
                };
                const msg = makeBlock(summary, seg.indices, originals.map(clone), stats, originals[0]);
                reps.push({ indices: seg.indices, message: msg });
                okCount++;
                log(`✓ 第 ${i + 1} 段完成：${first}–${last} 楼，${beforeChars} 字 → ${summary.length} 字${targetChars ? `（目标 ${targetChars} 字）` : ''}`, 'ok');
            } catch (e) {
                failCount++;
                const msg = friendlyError(e);
                log(`✗ 第 ${i + 1} 段失败（${first}–${last} 楼）：${msg}`, 'err');
                if (stopFlag || /取消|超时/.test(msg)) break;
            }

            // 段间额外随机延迟：批量压缩时避免连续请求被上游风控识别
            const thr = config.throttle || DEFAULT_CONFIG.throttle;
            if (!stopFlag && i < segments.length - 1 && thr.enabled) {
                const waitMs = computeChunkPause(thr);
                if (waitMs > 0) {
                    const pauseSec = Math.max(0, Number(thr.pauseSec) || 0);
                    log(pauseSec > 0 ? `段间固定停顿 ${pauseSec} 秒` : `段间随机延迟 ${(waitMs / 1000).toFixed(1)} 秒`);
                    let lastShown = -1;
                    try {
                        await pacedWait(waitMs, () => stopFlag, left => {
                            const sec = Math.ceil(left / 1000);
                            if (sec !== lastShown) {
                                lastShown = sec;
                                setProgress(i + 1, segments.length, `第 ${i + 1}/${segments.length} 段完成，${sec} 秒后继续…`);
                            }
                        });
                    } catch {
                        log('等待期间收到停止指令');
                        break;
                    }
                }
            }
        }

        if (reps.length) {
            if (getChat() !== chat) {
                log('检测到压缩期间切换了聊天，已放弃写入以保护数据', 'err');
                toast('压缩期间聊天已切换，结果未写入', 'error');
            } else {
                const beforeLen = chat.length;
                applyReplacements(reps, chat);
                await persist();
                log(`已写入 ${reps.length} 个压缩块，聊天楼层 ${beforeLen} → ${chat.length}`, 'ok');
            }
        }
        setProgress(okCount + failCount, segments.length, `完成 ${okCount} 段，失败 ${failCount} 段${stopFlag ? '（已手动停止）' : ''}`);
        toast(`压缩完成：成功 ${okCount} 段，失败 ${failCount} 段`, failCount ? 'warning' : 'success');
        if (reason === '自动') appendAutoLog(`压缩结束：成功 ${okCount} 段，失败 ${failCount} 段`);
    } catch (e) {
        log(`压缩流程异常：${friendlyError(e)}`, 'err');
        toast(`压缩异常：${friendlyError(e)}`, 'error');
    } finally {
        setBusy(false);
        hideProgressLater();
        try { await refreshSnapshots(); } catch { /* noop */ }
    }
}

async function recompress() {
    if (busy) { toast('已有任务在运行', 'warning'); return; }
    const chat = getChat();
    const idxs = [];
    chat.forEach((m, i) => { if (m?.extra?.[MARK]) idxs.push(i); });
    if (idxs.length < 2) { toast('至少需要 2 个压缩块才能二次压缩', 'warning'); return; }
    if (!String(config.api.model || '').trim()) { toast('请先选择模型', 'error'); switchTab('api'); return; }
    setBusy(true);
    try {
        await putSnapshot(chat, '二次压缩前快照');
        const blocks = idxs.map(i => chat[i]);
        const text = blocks.map(b => String(b.mes ?? '')).join('\n\n---\n\n');
        const input = truncateMiddle(text, Number(config.adv.maxInput) || 0);
        const targetChars = computeTargetChars(input.length, 1);
        log(`二次压缩：合并 ${idxs.length} 个压缩块，输入 ${input.length} 字${targetChars ? `，目标 ${targetChars} 字` : ''}`);
        const summary = await requestSummary(input, config.recompressPrompt, targetChars);
        const originals = [];
        const floors = [];
        for (const b of blocks) {
            const orig = b.extra?.ccx_original;
            if (!Array.isArray(orig)) continue;
            const bf = getBlockFloors(b);
            orig.forEach((om, k) => { originals.push(clone(om)); floors.push(bf[k]); });
        }
        // 按压缩前的楼层号重排，保证二次压缩后仍能按楼层选择性还原
        const order = floors.map((_, k) => k).sort((a, b) => (floors[a] ?? 0) - (floors[b] ?? 0));
        const sortedOriginals = order.map(k => originals[k]);
        const sortedFloors = order.map(k => floors[k]);
        const beforeChars = blocks.reduce((s, b) => s + String(b.mes ?? '').length, 0);
        const stats = {
            beforeChars, afterChars: summary.length,
            beforeTokens: estimateTokens(text), afterTokens: estimateTokens(summary),
        };
        const msg = makeBlock(summary, idxs, sortedOriginals, stats, blocks[0], sortedFloors);
        if (sortedFloors.length) {
            msg.extra.ccx_count = sortedOriginals.length;
            msg.extra.ccx_range = [sortedFloors[0], sortedFloors[sortedFloors.length - 1]];
        }
        applyReplacements([{ indices: idxs, message: msg }]);
        await persist();
        log(`二次压缩完成：${beforeChars} 字 → ${summary.length} 字`, 'ok');
        toast('二次压缩完成', 'success');
    } catch (e) {
        log(`二次压缩失败：${friendlyError(e)}`, 'err');
        toast(`二次压缩失败：${friendlyError(e)}`, 'error');
    } finally {
        setBusy(false);
        try { await refreshSnapshots(); } catch { /* noop */ }
    }
}

async function restoreAll() {
    if (busy) { toast('请等待当前任务结束', 'warning'); return; }
    const chat = getChat();
    let count = 0, missing = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m?.extra?.[MARK]) continue;
        const orig = m.extra.ccx_original;
        if (!Array.isArray(orig) || !orig.length) { missing++; continue; }
        chat.splice(i, 1, ...orig.map(clone));
        count++;
    }
    if (!count && !missing) { toast('当前聊天里没有压缩块', 'info'); return; }
    await persist();
    toast(`已还原 ${count} 个压缩块${missing ? `，${missing} 个因内联原文被清除而无法还原` : ''}`, count ? 'success' : 'warning');
}
async function stripBackups() {
    const chat = getChat();
    let n = 0;
    for (const m of chat) {
        if (m?.extra?.[MARK] && m.extra.ccx_original) { delete m.extra.ccx_original; n++; }
    }
    try { await getCtx()?.saveChat?.(); } catch { /* noop */ }
    toast(`已清除 ${n} 个压缩块的内联原文（此后只能用快照还原）`, 'success');
    refreshStats();
}

/* ---------------- 原文查看 / 选择性还原 ---------------- */

let archivePreview = [];
let archiveViewerEl = null;

function ccxEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
}
/** 支持：3 / 3-7 / 3,5,9 / 3 5 9 */
function parseFloorSpec(text) {
    const out = new Set();
    String(text ?? '').split(/[,，\s]+/).forEach(part => {
        if (!part) return;
        const range = part.match(/^(\d+)\s*[-~–—]\s*(\d+)$/);
        if (range) {
            let a = Number(range[1]), b = Number(range[2]);
            if (a > b) [a, b] = [b, a];
            for (let i = a; i <= b && out.size < 500; i++) out.add(i);
        } else if (/^\d+$/.test(part) && out.size < 500) {
            out.add(Number(part));
        }
    });
    return [...out].sort((a, b) => a - b);
}
/** 收集压缩块内联保存的原始消息（只读，不改动聊天） */
function collectArchiveEntries(onlyBlockIndex) {
    const chat = getChat();
    const out = [];
    chat.forEach((m, i) => {
        if (!m?.extra?.[MARK]) return;
        if (Number.isInteger(onlyBlockIndex) && i !== onlyBlockIndex) return;
        const originals = m.extra.ccx_original;
        if (!Array.isArray(originals)) return;
        const floors = getBlockFloors(m);
        originals.forEach((orig, k) => {
            out.push({
                blockIndex: i,
                floor: Number(floors[k]),
                isUser: !!orig?.is_user,
                roleName: String(orig?.name || (orig?.is_user ? '用户' : '角色')),
                text: String(orig?.mes ?? ''),
                date: orig?.send_date,
            });
        });
    });
    return out.sort((a, b) => (a.blockIndex - b.blockIndex) || (a.floor - b.floor));
}
function formatArchiveDate(v) {
    if (!v) return '';
    const d = new Date(typeof v === 'number' ? v : String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
}
/**
 * 只把选中的原始楼层还原成聊天消息，其余楼层继续留在压缩块里。
 * 部分还原时原文插到压缩块之后；全部还原时压缩块直接被原文替换。
 */
async function restoreSelectedFloors(blockIndex, wantedFloors, options = {}) {
    const { persistNow = true, silent = false } = options;
    if (busy) { if (!silent) toast('请等待当前任务结束', 'warning'); return 0; }
    const chat = getChat();
    const block = chat[blockIndex];
    if (!block?.extra?.[MARK]) {
        if (!silent) toast('该位置已不是压缩块，请重新预览', 'warning');
        return 0;
    }
    const originals = block.extra.ccx_original;
    if (!Array.isArray(originals) || !originals.length) {
        if (!silent) toast('这个压缩块没有内联原文（可能已被清除），只能用快照整体恢复', 'error');
        return 0;
    }
    const floors = getBlockFloors(block);
    const want = new Set(wantedFloors.map(Number));
    const picked = [];
    const keep = [];
    const keepFloors = [];
    originals.forEach((om, k) => {
        if (want.has(Number(floors[k]))) picked.push({ floor: Number(floors[k]), msg: clone(om) });
        else { keep.push(om); keepFloors.push(floors[k]); }
    });
    if (!picked.length) {
        if (!silent) toast('没有匹配到可还原的楼层', 'warning');
        return 0;
    }
    picked.sort((a, b) => a.floor - b.floor);

    if (keep.length === 0) {
        chat.splice(blockIndex, 1, ...picked.map(p => p.msg));
    } else {
        const already = Array.isArray(block.extra.ccx_restored) ? block.extra.ccx_restored : [];
        const restored = [...new Set([...already, ...picked.map(p => p.floor)])].sort((a, b) => a - b);
        const newBlock = {
            ...block,
            extra: {
                ...block.extra,
                ccx_original: keep,
                ccx_floors: keepFloors,
                ccx_count: keep.length,
                ccx_restored: restored,
            },
        };
        chat.splice(blockIndex, 1, newBlock, ...picked.map(p => p.msg));
    }
    if (persistNow) {
        await persist();
        const target = document.querySelector(`#chat .mes[mesid="${blockIndex}"]`);
        setTimeout(() => target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 120);
        if (!silent) toast(`已还原第 ${picked.map(p => p.floor).join('、')} 楼`, 'success');
    }
    log(`选择性还原：第 ${picked.map(p => p.floor).join('、')} 楼；压缩块剩余 ${keep.length} 条`, 'ok');
    return picked.length;
}
/** 按 blockIndex 降序批量还原，避免前面的还原改变后面的索引 */
async function restoreEntries(entries) {
    if (!entries.length) { toast('请先勾选要还原的楼层', 'warning'); return; }
    const groups = new Map();
    entries.forEach(e => {
        if (!groups.has(e.blockIndex)) groups.set(e.blockIndex, []);
        groups.get(e.blockIndex).push(e.floor);
    });
    const ordered = [...groups.entries()].sort((a, b) => b[0] - a[0]);
    let total = 0;
    try {
        for (const [bi, floors] of ordered) {
            total += await restoreSelectedFloors(bi, floors, { persistNow: false, silent: true });
        }
        await persist();
        if (ordered.length) {
            const firstBi = Math.min(...ordered.map(([bi]) => bi));
            setTimeout(() => {
                const el = document.querySelector(`#chat .mes[mesid="${firstBi}"]`);
                el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            }, 120);
        }
        toast(`已还原 ${total} 个楼层`, total ? 'success' : 'warning');
        log(`批量还原完成：${total} 个楼层`, 'ok');
    } catch (e) {
        toast(`还原失败：${e?.message || e}`, 'error');
    }
    closeArchiveViewer();
    archivePreview = [];
    renderArchivePreview();
    renderArchiveBlocks();
    refreshStats();
}

function renderArchivePreview() {
    const box = $id('ccx-arch-result');
    if (!box) return;
    box.innerHTML = '';
    if (!archivePreview.length) {
        box.appendChild(ccxEl('div', 'ccx-arch-empty', '输入楼层号后点「预览原文」。这里只读取备份，不会改动聊天记录。'));
        return;
    }
    archivePreview.forEach((e, idx) => {
        const row = ccxEl('label', 'ccx-arch-item');
        row.dataset.search = `${e.floor} ${e.roleName} ${e.text}`.toLowerCase();
        if (!e.currentOnly) {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.idx = String(idx);
            row.appendChild(cb);
        } else {
            row.appendChild(ccxEl('span', 'ccx-arch-current', '当前'));
        }
        const main = ccxEl('div', 'ccx-arch-main');
        const d = formatArchiveDate(e.date);
        main.appendChild(ccxEl('div', 'ccx-arch-meta',
            `${e.currentOnly ? '当前' : '原'}第 ${e.floor} 楼 · ${e.roleName}${d ? ` · ${d}` : ''}`));
        main.appendChild(ccxEl('div', 'ccx-arch-body', e.text || '（空消息）'));
        row.appendChild(main);
        box.appendChild(row);
    });
}
function previewFloors() {
    const spec = $id('ccx-arch-floors')?.value ?? '';
    const floors = parseFloorSpec(spec);
    if (!floors.length) {
        archivePreview = [];
        renderArchivePreview();
        toast('请输入有效楼层号，例如 3、3-7 或 3,5,9', 'warning');
        return;
    }
    const all = collectArchiveEntries();
    const chat = getChat();
    const found = [];
    const missing = [];
    for (const f of floors) {
        const hits = all.filter(e => e.floor === f);
        if (hits.length) { found.push(...hits); continue; }
        const cur = chat[f];
        if (!cur) { missing.push(f); continue; }
        if (cur.extra?.[MARK]) {
            const blockEntries = all.filter(e => e.blockIndex === f);
            if (blockEntries.length) found.push(...blockEntries);
            else missing.push(f);
        } else {
            found.push({
                currentOnly: true, floor: f,
                roleName: String(cur.name || (cur.is_user ? '用户' : '角色')),
                text: String(cur.mes ?? ''), date: cur.send_date,
            });
        }
    }
    archivePreview = found.sort((a, b) => a.floor - b.floor);
    renderArchivePreview();
    if (missing.length) toast(`未找到第 ${missing.join('、')} 楼`, 'warning');
    else log(`预览 ${archivePreview.length} 条原文（只读）`);
}
function restoreFromPanel() {
    const box = $id('ccx-arch-result');
    if (!box) return;
    const checked = [...box.querySelectorAll('input[type="checkbox"]:checked')];
    const entries = checked.map(cb => archivePreview[Number(cb.dataset.idx)]).filter(Boolean);
    restoreEntries(entries);
}
function renderArchiveBlocks() {
    const box = $id('ccx-arch-blocks');
    if (!box) return;
    box.innerHTML = '';
    const chat = getChat();
    let n = 0;
    chat.forEach((m, i) => {
        if (!m?.extra?.[MARK]) return;
        n++;
        const range = Array.isArray(m.extra.ccx_range) ? m.extra.ccx_range.join('–') : '?';
        const cnt = Array.isArray(m.extra.ccx_original) ? m.extra.ccx_original.length : 0;
        const restored = Array.isArray(m.extra.ccx_restored) ? m.extra.ccx_restored.length : 0;
        const row = ccxEl('div', 'ccx-snap-item');
        row.appendChild(ccxEl('span', 'ccx-snap-name',
            `当前第 ${i} 楼 · 原 ${range} 楼 · ${cnt} 条原文${restored ? ` · 已还原 ${restored} 楼` : ''}${cnt ? '' : '（无内联原文）'}`));
        const view = ccxEl('button', 'ccx-btn', '查看原文');
        view.type = 'button';
        view.addEventListener('click', () => openArchiveViewer({ blockIndex: i }));
        const allBtn = ccxEl('button', 'ccx-btn ccx-btn-primary', '全部还原');
        allBtn.type = 'button';
        allBtn.addEventListener('click', async () => {
            const entries = collectArchiveEntries(i);
            if (!entries.length) { toast('该压缩块没有内联原文，请用快照恢复', 'error'); return; }
            if (!globalThis.confirm(`把该压缩块的 ${entries.length} 个楼层全部还原成原文？`)) return;
            await restoreEntries(entries);
        });
        row.appendChild(view);
        row.appendChild(allBtn);
        box.appendChild(row);
    });
    if (!n) box.appendChild(ccxEl('div', 'ccx-arch-empty', '当前聊天里还没有压缩块。'));
}
function closeArchiveViewer() {
    try { archiveViewerEl?.remove?.(); } catch { /* noop */ }
    archiveViewerEl = null;
}
function openArchiveViewer({ blockIndex = null, floors = null, title = '' } = {}) {
    closeArchiveViewer();
    let entries = collectArchiveEntries(Number.isInteger(blockIndex) ? blockIndex : null);
    if (Array.isArray(floors) && floors.length) {
        const set = new Set(floors.map(Number));
        entries = entries.filter(e => set.has(e.floor));
    }
    const mask = ccxEl('div', 'ccx-modal-mask');
    const win = ccxEl('div', 'ccx-archive');
    const head = ccxEl('div', 'ccx-archive-head');
    const headText = ccxEl('div');
    headText.appendChild(ccxEl('strong', '', title || '原文查看器 · 柠檬总结'));
    headText.appendChild(ccxEl('div', 'ccx-archive-sub', '只读浏览 · 勾选后才会改动聊天记录'));
    const close = ccxEl('button', 'ccx-icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', closeArchiveViewer);
    head.appendChild(headText);
    head.appendChild(close);
    win.appendChild(head);

    const tools = ccxEl('div', 'ccx-archive-tools');
    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = '搜索楼层号 / 角色 / 内容…';
    const selAll = ccxEl('button', 'ccx-btn', '全选 / 清空');
    selAll.type = 'button';
    tools.appendChild(search);
    tools.appendChild(selAll);
    win.appendChild(tools);

    const list = ccxEl('div', 'ccx-archive-list');
    if (!entries.length) {
        list.appendChild(ccxEl('div', 'ccx-arch-empty',
            '没有可查看的原文。可能是内联备份已清除，或该范围没有压缩块；可用「备份」页的快照整体恢复。'));
    }
    entries.forEach((e, idx) => {
        const row = ccxEl('label', 'ccx-arch-item');
        row.dataset.search = `${e.floor} ${e.roleName} ${e.text}`.toLowerCase();
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.entry = String(idx);
        row.appendChild(cb);
        const main = ccxEl('div', 'ccx-arch-main');
        const d = formatArchiveDate(e.date);
        main.appendChild(ccxEl('div', 'ccx-arch-meta',
            `原第 ${e.floor} 楼 · ${e.roleName}${d ? ` · ${d}` : ''} · 来自当前第 ${e.blockIndex} 楼压缩块`));
        main.appendChild(ccxEl('div', 'ccx-arch-body', e.text || '（空消息）'));
        row.appendChild(main);
        list.appendChild(row);
    });
    win.appendChild(list);

    const foot = ccxEl('div', 'ccx-archive-foot');
    const status = ccxEl('span', 'ccx-archive-status', '');
    const updateStatus = () => {
        status.textContent = `共 ${entries.length} 条 · 已勾选 ${list.querySelectorAll('input[type="checkbox"]:checked').length} 条`;
    };
    list.addEventListener('change', updateStatus);
    const copyBtn = ccxEl('button', 'ccx-btn', '复制选中');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
        const rows = [...list.querySelectorAll('input[type="checkbox"]:checked')];
        const text = rows.map(cb => {
            const row = cb.closest('.ccx-arch-item');
            return `【${row?.querySelector('.ccx-arch-meta')?.textContent ?? ''}】\n${row?.querySelector('.ccx-arch-body')?.textContent ?? ''}`;
        }).join('\n\n');
        if (!text) { toast('没有勾选内容', 'warning'); return; }
        try {
            await globalThis.navigator?.clipboard?.writeText(text);
            toast('已复制选中原文', 'success');
        } catch {
            toast('复制失败，请手动选中文本复制', 'warning');
        }
    });
    const restoreBtn = ccxEl('button', 'ccx-btn ccx-btn-primary', '还原选中楼层');
    restoreBtn.type = 'button';
    restoreBtn.addEventListener('click', async () => {
        const picked = [...list.querySelectorAll('input[type="checkbox"]:checked')]
            .map(cb => entries[Number(cb.dataset.entry)]).filter(Boolean);
        await restoreEntries(picked);
    });
    const restoreAllBtn = ccxEl('button', 'ccx-btn', '全部还原');
    restoreAllBtn.type = 'button';
    restoreAllBtn.addEventListener('click', async () => {
        if (!entries.length) { toast('没有可还原的原文', 'warning'); return; }
        if (!globalThis.confirm(`把 ${entries.length} 个楼层全部还原成原文？`)) return;
        await restoreEntries(entries);
    });
    foot.appendChild(status);
    foot.appendChild(copyBtn);
    foot.appendChild(restoreBtn);
    foot.appendChild(restoreAllBtn);
    win.appendChild(foot);

    search.addEventListener('input', () => {
        const q = String(search.value || '').trim().toLowerCase();
        [...list.querySelectorAll('.ccx-arch-item')].forEach(row => {
            row.hidden = !!q && !String(row.dataset.search || '').includes(q);
        });
    });
    selAll.addEventListener('click', () => {
        const cbs = [...list.querySelectorAll('input[type="checkbox"]')]
            .filter(cb => !cb.closest('.ccx-arch-item')?.hidden);
        const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
        cbs.forEach(cb => { cb.checked = !allChecked; });
        updateStatus();
    });
    mask.addEventListener('click', e => { if (e.target === mask) closeArchiveViewer(); });
    mask.appendChild(win);
    document.body.appendChild(mask);
    archiveViewerEl = mask;
    updateStatus();
    try { search.focus?.(); } catch { /* noop */ }
}

/* ---------------- 统计 / 装饰 ---------------- */

/** 合并同一轮里的多次统计调用，避免每个消息事件都跑一遍 */
function scheduleRefreshStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(refreshStats, 400);
}

async function refreshStats() {
    const chat = getChat();
    const blocks = chat.filter(m => m?.extra?.[MARK]);
    const chars = chat.reduce((s, m) => s + String(m?.mes ?? '').length, 0);
    const saved = blocks.reduce((s, m) => {
        const st = m.extra?.ccx_stats;
        return s + (st ? Math.max(0, (st.beforeChars || 0) - (st.afterChars || 0)) : 0);
    }, 0);
    const set = (id, v) => { const el = $id(id); if (el) el.textContent = v; };
    set('ccx-stat-floors', String(chat.length));
    set('ccx-stat-blocks', String(blocks.length));
    set('ccx-stat-chars', chars.toLocaleString('zh-CN'));
    set('ccx-stat-saved', saved.toLocaleString('zh-CN'));
    set('ccx-stat-tokens', '…');
    const info = getPendingInfo();
    const hint = $id('ccx-auto-hint');
    if (hint) {
        hint.textContent = `待压缩 ${info.pending} 楼（阈值 ${config.auto.interval}）· 上次压缩锚点 ${info.anchor < 0 ? '无' : `${info.anchor} 楼`} · 可压缩区间 ${info.start}–${info.end}`;
    }
    const allText = chat.map(m => String(m?.mes ?? '')).join('\n');
    countTokensSafe(allText).then(n => set('ccx-stat-tokens', n.toLocaleString('zh-CN')));
    const to = $id('ccx-manual-to');
    if (to) to.max = Math.max(0, chat.length - 1);
    const from = $id('ccx-manual-from');
    if (from) from.max = Math.max(0, chat.length - 1);
    updateBadge();
}
function updateBadge() {
    const badge = $id('ccx-ball-badge');
    if (!badge) return;
    if (busy) { badge.hidden = false; badge.textContent = '…'; return; }
    const { pending } = getPendingInfo();
    if (pending > 0) { badge.hidden = false; badge.textContent = String(pending); }
    else badge.hidden = true;
}
function decorateBlocks() {
    const chat = getChat();
    const root = document.getElementById('chat');
    if (!root) return;
    const marked = [];
    chat.forEach((m, i) => { if (m?.extra?.[MARK]) marked.push(i); });
    if (!marked.length) return;
    for (const i of marked) {
        const m = chat[i];
        const el = root.querySelector(`.mes[mesid="${i}"]`);
        if (!el) continue;
        el.classList.add('ccx-block');
        const textEl = el.querySelector('.mes_text');
        if (!textEl || el.querySelector('.ccx-block-bar')) continue;
        const st = m.extra?.ccx_stats || {};
        const restored = Array.isArray(m.extra?.ccx_restored) ? m.extra.ccx_restored.length : 0;
        const bar = ccxEl('div', 'ccx-block-bar');

        const tag = ccxEl('button', 'ccx-block-tag');
        tag.type = 'button';
        tag.textContent = '◈ 柠檬总结 ';
        const small = ccxEl('small');
        const range = Array.isArray(m.extra?.ccx_range) ? m.extra.ccx_range.join('–') : '?';
        small.textContent = `原 ${range} 楼 · ${m.extra?.ccx_count ?? '?'} 条` +
            (st.beforeChars ? ` · ${st.beforeChars}→${st.afterChars} 字` : '') +
            (restored ? ` · 已还原 ${restored} 楼` : '') + ' · 点击折叠';
        tag.appendChild(small);
        tag.addEventListener('click', () => el.classList.toggle('ccx-collapsed'));
        bar.appendChild(tag);

        const viewBtn = ccxEl('button', 'ccx-block-btn', '原文');
        viewBtn.type = 'button';
        viewBtn.title = '只读查看被压缩的聊天记录，可勾选后还原指定楼层';
        viewBtn.addEventListener('click', e => {
            e.stopPropagation();
            openArchiveViewer({ blockIndex: i });
        });
        bar.appendChild(viewBtn);

        const allBtn = ccxEl('button', 'ccx-block-btn', '全部还原');
        allBtn.type = 'button';
        allBtn.title = '把该压缩块的所有楼层还原成原文';
        allBtn.addEventListener('click', async e => {
            e.stopPropagation();
            const entries = collectArchiveEntries(i);
            if (!entries.length) { toast('该压缩块没有内联原文，请用快照恢复', 'error'); return; }
            if (!globalThis.confirm(`把该压缩块的 ${entries.length} 个楼层全部还原成原文？`)) return;
            await restoreEntries(entries);
        });
        bar.appendChild(allBtn);

        textEl.insertBefore(bar, textEl.firstChild);
    }
}
function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateBlocks, 350);
}
function setupObserver() {
    const root = document.getElementById('chat');
    if (!root) { setTimeout(setupObserver, 1200); return; }
    // 极老 WebView 可能没有 MutationObserver：此时仍能正常压缩，只是压缩块样式不会自动重刷
    if (typeof globalThis.MutationObserver === 'function') {
        try {
            const mo = new globalThis.MutationObserver(() => scheduleDecorate());
            mo.observe(root, { childList: true, subtree: true });
        } catch { /* noop */ }
    }
    decorateBlocks();
}

/* ---------------- 自动压缩 ---------------- */

function scheduleAuto(force = false) {
    clearTimeout(autoTimer);
    if (!config.auto.enabled && !force) return;
    autoTimer = setTimeout(async () => {
        // 生成中不触发：避免改 chat / 重绘打断主聊天生成导致重试；生成结束后会再检测
        if (isGenerating) {
            if (force) toast('正在生成回复，结束后会自动检测', 'info');
            return;
        }
        if (busy || autoRunning) return;
        // 冷却：两次自动压缩之间至少间隔设定秒数，避免频繁触发放大请求数
        const cooldown = Math.max(0, Number(config.auto.cooldownSec) || 0) * 1000;
        if (!force && Date.now() - lastAutoRunAt < cooldown) return;
        const info = getPendingInfo();
        const threshold = Math.max(2, Number(config.auto.interval) || 10);
        if (info.pending < threshold || info.end < info.start) {
            if (force) toast(`当前待压缩 ${info.pending} 楼，未达到阈值 ${threshold}`, 'info');
            refreshStats();
            return;
        }
        if (!config.auto.enabled && force) { toast('自动压缩未启用，仅完成检测', 'info'); return; }
        autoRunning = true;
        lastAutoRunAt = Date.now();
        try {
            await runCompression({
                from: info.start, to: info.end,
                chunk: config.auto.chunk, mode: 'chunk', skip: true, reason: '自动',
            });
        } finally {
            autoRunning = false;
        }
    // 自动压缩触发时机也加随机抖动，避免每次都固定在同一秒发起
    }, force ? 50 : 1800 + (config.throttle?.enabled ? Math.floor(Math.random() * 3000) : 0));
}
function onChatEvent(kind) {
    scheduleDecorate();
    scheduleRefreshStats();
    const trigger = config.auto.trigger;
    if (!config.auto.enabled || isGenerating) return;
    if (kind === 'received' && (trigger === 'received' || trigger === 'both')) scheduleAuto();
    if (kind === 'sent' && (trigger === 'sent' || trigger === 'both')) scheduleAuto();
}

/* ---------------- IndexedDB 快照 ---------------- */

function openDB() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) { reject(new Error('IndexedDB 不可用')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
}
function dbTx(db, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(DB_STORE, mode);
        const req = fn(t.objectStore(DB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('快照读写失败'));
    });
}
async function putSnapshot(chat, label) {
    const db = await openDB();
    try {
        const rec = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            time: Date.now(),
            label: String(label || '手动快照'),
            chatId: String(getCtx()?.chatId ?? 'unknown'),
            count: chat.length,
            data: JSON.stringify(chat),
        };
        await dbTx(db, 'readwrite', s => s.put(rec));
        try {
            const all = await dbTx(db, 'readonly', s => s.getAll());
            const old = (all || []).sort((a, b) => b.time - a.time).slice(12);
            for (const r of old) await dbTx(db, 'readwrite', s => s.delete(r.id));
        } catch { /* noop */ }
        return rec;
    } finally { db.close(); }
}
async function listSnapshots() {
    const db = await openDB();
    try {
        const all = await dbTx(db, 'readonly', s => s.getAll());
        return (all || []).sort((a, b) => b.time - a.time);
    } finally { db.close(); }
}
async function deleteSnapshot(id) {
    const db = await openDB();
    try { await dbTx(db, 'readwrite', s => s.delete(id)); } finally { db.close(); }
}
async function getSnapshot(id) {
    const db = await openDB();
    try { return await dbTx(db, 'readonly', s => s.get(id)); } finally { db.close(); }
}
async function refreshSnapshots() {
    const box = $id('ccx-snapshot-list');
    if (!box) return;
    try {
        const list = await listSnapshots();
        box.innerHTML = '';
        if (!list.length) { box.textContent = '暂无快照。'; return; }
        for (const r of list.slice(0, 12)) {
            const row = document.createElement('div');
            row.className = 'ccx-snap-item';
            const name = document.createElement('span');
            name.className = 'ccx-snap-name';
            name.textContent = `${new Date(r.time).toLocaleString('zh-CN', { hour12: false })} · ${r.label} · ${r.count} 楼`;
            const restore = document.createElement('button');
            restore.type = 'button'; restore.className = 'ccx-btn'; restore.textContent = '恢复';
            restore.addEventListener('click', async () => {
                if (!globalThis.confirm('用该快照覆盖当前聊天记录？当前内存中未保存的改动会丢失。')) return;
                try {
                    const rec = await getSnapshot(r.id);
                    const data = JSON.parse(rec.data);
                    const chat = getChat();
                    chat.splice(0, chat.length, ...data);
                    await persist();
                    toast('快照已恢复', 'success');
                } catch (e) { toast(`恢复失败：${e?.message || e}`, 'error'); }
            });
            const del = document.createElement('button');
            del.type = 'button'; del.className = 'ccx-btn ccx-btn-danger'; del.textContent = '删除';
            del.addEventListener('click', async () => {
                try { await deleteSnapshot(r.id); await refreshSnapshots(); } catch (e) { toast(`删除失败：${e?.message || e}`, 'error'); }
            });
            row.appendChild(name);
            row.appendChild(restore);
            row.appendChild(del);
            box.appendChild(row);
        }
    } catch (e) {
        box.textContent = `快照不可用：${e?.message || e}`;
    }
}
function downloadJSON(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
function exportBackup() {
    const chat = getChat();
    const safeConfig = clone(config);
    if (safeConfig.api) safeConfig.api.key = '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJSON(`柠檬总结-完整备份-${stamp}.json`, {
        format: 'context-compressor-backup-v1',
        exportedAt: new Date().toISOString(),
        chatId: String(getCtx()?.chatId ?? 'unknown'),
        chat,
        config: safeConfig,
    });
    toast('完整备份已导出（不含 API 密钥）', 'success');
}

/** 跨设备迁移：设置保存在浏览器 localStorage，不会随插件或聊天文件同步 */
function exportSettings() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadJSON(`柠檬总结-设置-${stamp}.json`, {
        format: 'context-compressor-settings-v1',
        exportedAt: new Date().toISOString(),
        config: clone(config),
    });
    toast('设置已导出 · 文件包含 API 密钥，请妥善保管', 'success');
}
function readFileText(file) {
    return new Promise((resolve, reject) => {
        if (typeof file.text === 'function') {
            file.text().then(resolve, reject);
            return;
        }
        // 老浏览器没有 File.text()，退回 FileReader
        if (typeof globalThis.FileReader !== 'function') {
            reject(new Error('当前浏览器不支持读取本地文件'));
            return;
        }
        const fr = new globalThis.FileReader();
        fr.onload = () => resolve(String(fr.result ?? ''));
        fr.onerror = () => reject(fr.error || new Error('文件读取失败'));
        fr.readAsText(file, 'utf-8');
    });
}
async function importSettings(file) {
    if (!file) return;
    if (!globalThis.confirm('用文件中的设置覆盖当前配置？破限词、压缩提示词、模板与 API 配置都会被替换。')) return;
    try {
        const data = JSON.parse(await readFileText(file));
        const incoming = data?.config ?? data;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            throw new Error('不是有效的设置文件');
        }
        config = mergeConfig(clone(DEFAULT_CONFIG), incoming);
        saveConfig();
        loadConfigToUI();
        applyBallVisibility();
        refreshStats();
        toast('设置已导入并生效', 'success');
    } catch (e) {
        toast(`导入失败：${e?.message || e}`, 'error');
    }
}

/* ---------------- UI ---------------- */

function switchTab(name) {
    // 不用 classList.toggle(name, force)：部分旧浏览器会忽略第二参数
    document.querySelectorAll('.ccx-tab-btn').forEach(b => {
        if (b.dataset.tab === name) b.classList.add('active'); else b.classList.remove('active');
    });
    document.querySelectorAll('.ccx-pane').forEach(p => {
        if (p.dataset.pane === name) p.classList.add('active'); else p.classList.remove('active');
    });
}
function updateLengthFields() {
    const mode = $id('ccx-length-mode')?.value || 'off';
    document.querySelectorAll('.ccx-len-field').forEach(el => { el.hidden = el.dataset.len !== mode; });
}
function updateLengthHint() {
    const el = $id('ccx-length-hint');
    if (el) el.textContent = `当前：${describeLengthMode()}`;
}
function updateThrottleHint() {
    const el = $id('ccx-throttle-hint');
    if (!el) return;
    const t = config.throttle || DEFAULT_CONFIG.throttle;
    const pause = Math.max(0, Number(t.pauseSec) || 0);
    const segText = pause > 0 ? `每段固定停顿 ${pause} 秒` : `段间随机额外 ${t.minSec}～${t.maxSec} 秒`;
    el.textContent = t.enabled
        ? `当前：开启｜生成请求间隔 ${t.gapSec}～${Number(t.gapSec) * 2} 秒，${segText}｜单次超时 ${config.adv.timeout} 秒`
        : `当前：关闭（请求会连续发出）｜单次超时 ${config.adv.timeout} 秒`;
}
function previewLengthTargets() {
    syncFromUI();
    const chat = getChat();
    if (!chat.length) { toast('当前没有聊天记录', 'warning'); return; }
    let from = clampInt(config.manual.from, 0, chat.length - 1, 0);
    let to = clampInt(config.manual.to, 0, chat.length - 1, chat.length - 1);
    if (from > to) [from, to] = [to, from];
    const segs = splitSegments(chat, from, to, config.manual.chunk,
        config.manual.skipCompressed, config.manual.mode === 'merge');
    if (!segs.length) { toast('范围内没有可压缩的楼层', 'warning'); return; }
    const targets = segs.map(s => computeTargetChars(formatOriginal(chat, s.indices).length, segs.length));
    const total = targets.reduce((a, b) => a + (b || 0), 0);
    const head = targets.slice(0, 4).join(' / ');
    const text = `当前：${describeLengthMode()}｜${from}–${to} 楼共 ${segs.length} 段，`
        + (targets[0] ? `每段目标 ${head}${targets.length > 4 ? ' …' : ''} 字，合计约 ${total} 字` : '不限制');
    const hint = $id('ccx-length-hint');
    if (hint) hint.textContent = text;
    log(`字数预览：${text}`, 'ok');
}
function loadConfigToUI() {
    const set = (id, v, checked = false) => {
        const el = $id(id);
        if (!el) return;
        if (checked) el.checked = !!v;
        else el.value = v ?? '';
    };
    // 手动
    set('ccx-manual-from', config.manual.from);
    set('ccx-manual-to', config.manual.to);
    set('ccx-chunk-size', config.manual.chunk);
    set('ccx-mode', config.manual.mode);
    set('ccx-skip-compressed', config.manual.skipCompressed, true);
    // 输出字数
    const len = config.length || DEFAULT_CONFIG.length;
    set('ccx-length-mode', len.mode);
    set('ccx-length-ratio', len.ratio);
    set('ccx-length-perchunk', len.perChunk);
    set('ccx-length-total', len.total);
    set('ccx-length-override', len.override, true);
    updateLengthFields();
    updateLengthHint();
    // 请求节流
    const thr = config.throttle || DEFAULT_CONFIG.throttle;
    set('ccx-throttle-enabled', thr.enabled, true);
    set('ccx-throttle-gap', thr.gapSec);
    set('ccx-throttle-min', thr.minSec);
    set('ccx-throttle-max', thr.maxSec);
    set('ccx-throttle-pause', thr.pauseSec);
    updateThrottleHint();
    // API
    set('ccx-api-url', config.api.url);
    set('ccx-api-key', config.api.key);
    set('ccx-api-models-path', config.api.modelsPath);
    set('ccx-api-chat-path', config.api.chatPath);
    set('ccx-model-custom', config.api.model);
    const ms = $id('ccx-model-status');
    if (ms) ms.textContent = `当前模型：${config.api.model || '未选择'}`;
    setStatus(config.api.url || config.api.proxy ? `已配置：${String(config.api.url || config.api.proxy).slice(0, 70)}（未测试）` : '未配置');
    // 提示词
    set('ccx-jailbreak', config.jailbreak);
    set('ccx-preset-select', config.preset);
    set('ccx-task-prompt', config.taskPrompt);
    set('ccx-block-template', config.blockTemplate);
    set('ccx-recompress-prompt', config.recompressPrompt);
    // 自动
    set('ccx-auto-enabled', config.auto.enabled, true);
    set('ccx-auto-interval', config.auto.interval);
    set('ccx-auto-chunk', config.auto.chunk);
    set('ccx-auto-keep', config.auto.keep);
    set('ccx-auto-trigger', config.auto.trigger);
    set('ccx-auto-cooldown', config.auto.cooldownSec);
    set('ccx-auto-maxchunks', config.auto.maxChunks);
    const al = $id('ccx-auto-log');
    if (al) al.textContent = (config.auto.log || []).join('\n') || '暂无自动压缩记录。';
    // 备份 / 高级
    set('ccx-inline-backup', config.adv.inlineBackup, true);
    set('ccx-adv-temperature', config.adv.temperature);
    set('ccx-adv-send-temp', config.adv.sendTemp, true);
    set('ccx-adv-max-tokens', config.adv.maxTokens);
    set('ccx-adv-token-field', config.adv.tokenField);
    set('ccx-adv-timeout', config.adv.timeout);
    set('ccx-adv-max-input', config.adv.maxInput);
    set('ccx-adv-proxy', config.api.proxy);
    set('ccx-adv-block-role', config.adv.blockRole);
    set('ccx-adv-add-guide', config.adv.addGuide, true);
    set('ccx-adv-ball', config.adv.showBall, true);

    const chat = getChat();
    const to = $id('ccx-manual-to');
    if (to && chat.length && !config.manual.to) to.value = Math.max(0, chat.length - 1);
    fillModelSelect([]);
}
function syncFromUI() {
    const v = id => $id(id)?.value ?? '';
    const c = id => !!$id(id)?.checked;
    const n = (id, fallback) => { const x = Number(v(id)); return Number.isFinite(x) ? x : fallback; };
    config.manual.from = n('ccx-manual-from', 0);
    config.manual.to = n('ccx-manual-to', 0);
    config.manual.chunk = Math.max(1, n('ccx-chunk-size', 10));
    config.manual.mode = v('ccx-mode') || 'chunk';
    config.manual.skipCompressed = c('ccx-skip-compressed');
    config.length = config.length || clone(DEFAULT_CONFIG.length);
    config.length.mode = v('ccx-length-mode') || 'off';
    config.length.ratio = clampInt(v('ccx-length-ratio'), 1, 100, 20);
    config.length.perChunk = clampInt(v('ccx-length-perchunk'), 30, 1000000, 300);
    config.length.total = clampInt(v('ccx-length-total'), 30, 10000000, 800);
    config.length.override = c('ccx-length-override');
    config.throttle = config.throttle || clone(DEFAULT_CONFIG.throttle);
    config.throttle.enabled = c('ccx-throttle-enabled');
    config.throttle.gapSec = clampInt(v('ccx-throttle-gap'), 0, 600, 2);
    config.throttle.minSec = clampInt(v('ccx-throttle-min'), 0, 3600, 5);
    config.throttle.maxSec = clampInt(v('ccx-throttle-max'), 0, 3600, 15);
    config.throttle.pauseSec = clampInt(v('ccx-throttle-pause'), 0, 3600, 0);
    if (config.throttle.maxSec < config.throttle.minSec) config.throttle.maxSec = config.throttle.minSec;
    config.api.url = v('ccx-api-url').trim();
    config.api.key = v('ccx-api-key').trim();
    config.api.modelsPath = v('ccx-api-models-path') || '/models';
    config.api.chatPath = v('ccx-api-chat-path') || '/chat/completions';
    config.api.proxy = v('ccx-adv-proxy').trim();
    // 手动填写的模型名即时生效，无需额外点「使用此模型」
    const customModel = v('ccx-model-custom').trim();
    if (customModel && customModel !== config.api.model) config.api.model = customModel;
    config.jailbreak = v('ccx-jailbreak');
    config.taskPrompt = v('ccx-task-prompt');
    config.preset = v('ccx-preset-select') || 'custom';
    config.blockTemplate = v('ccx-block-template') || DEFAULT_BLOCK_TEMPLATE;
    config.recompressPrompt = v('ccx-recompress-prompt') || DEFAULT_RECOMPRESS_PROMPT;
    config.auto.enabled = c('ccx-auto-enabled');
    config.auto.interval = Math.max(2, n('ccx-auto-interval', 10));
    config.auto.chunk = Math.max(1, n('ccx-auto-chunk', 10));
    config.auto.keep = Math.max(0, n('ccx-auto-keep', 6));
    config.auto.trigger = v('ccx-auto-trigger') || 'received';
    config.auto.cooldownSec = clampInt(v('ccx-auto-cooldown'), 0, 86400, 120);
    config.auto.maxChunks = clampInt(v('ccx-auto-maxchunks'), 0, 1000, 3);
    config.adv.temperature = n('ccx-adv-temperature', 0.3);
    config.adv.sendTemp = c('ccx-adv-send-temp');
    config.adv.maxTokens = Math.max(256, n('ccx-adv-max-tokens', 4096));
    config.adv.tokenField = v('ccx-adv-token-field') || 'max_tokens';
    config.adv.timeout = Math.max(10, n('ccx-adv-timeout', 600));
    config.adv.maxInput = Math.max(0, n('ccx-adv-max-input', 0));
    config.adv.blockRole = v('ccx-adv-block-role') || 'assistant';
    config.adv.addGuide = c('ccx-adv-add-guide');
    config.adv.inlineBackup = c('ccx-inline-backup');
    config.adv.showBall = c('ccx-adv-ball');
    saveConfig();
    applyBallVisibility();
}
function applyBallVisibility() {
    if (ballEl) ballEl.style.display = config.adv.showBall ? '' : 'none';
}
/** 把坐标收敛进当前视口；跨设备（分辨率不同）恢复保存的位置时必须调用 */
function clampToViewport(pos, w = 60, h = 60) {
    const vw = Number(globalThis.innerWidth) || 1024;
    const vh = Number(globalThis.innerHeight) || 768;
    const maxX = Math.max(0, vw - w);
    const maxY = Math.max(0, vh - h);
    return {
        x: Math.min(Math.max(0, Number(pos?.x) || 0), maxX),
        y: Math.min(Math.max(0, Number(pos?.y) || 0), maxY),
    };
}

function makeDraggable(handle, target, onEnd) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
    // iOS 12 及部分老 WebView 没有 Pointer Events，需降级到 mouse / touch
    const hasPointer = typeof globalThis.PointerEvent === 'function';

    const start = (x, y, ev) => {
        if (ev?.target?.closest?.('button, input, select, textarea, a')) return;
        const r = target.getBoundingClientRect();
        target.style.left = `${r.left}px`;
        target.style.top = `${r.top}px`;
        target.style.right = 'auto';
        target.style.bottom = 'auto';
        sx = x; sy = y; ox = r.left; oy = r.top;
        dragging = true; moved = false;
        if (hasPointer && ev?.pointerId !== undefined) {
            try { handle.setPointerCapture?.(ev.pointerId); } catch { /* noop */ }
        }
        target.classList.add('ccx-dragging');
    };
    const move = (x, y, ev) => {
        if (!dragging) return;
        if (ev?.cancelable) { try { ev.preventDefault(); } catch { /* noop */ } }
        const dx = x - sx, dy = y - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        const p = clampToViewport({ x: ox + dx, y: oy + dy }, 40, 30);
        target.style.left = `${p.x}px`;
        target.style.top = `${p.y}px`;
    };
    const end = () => {
        if (!dragging) return;
        dragging = false;
        target.classList.remove('ccx-dragging');
        onEnd?.({ x: parseFloat(target.style.left), y: parseFloat(target.style.top), moved });
    };

    if (hasPointer) {
        handle.addEventListener('pointerdown', e => start(e.clientX, e.clientY, e));
        handle.addEventListener('pointermove', e => move(e.clientX, e.clientY, e));
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    } else {
        handle.addEventListener('mousedown', e => start(e.clientX, e.clientY, e));
        handle.addEventListener('touchstart', e => {
            const t = e.touches?.[0] || e.changedTouches?.[0];
            if (t) start(t.clientX, t.clientY, e);
        }, { passive: false });
        const doc = globalThis.document;
        doc?.addEventListener?.('mousemove', e => move(e.clientX, e.clientY, e));
        doc?.addEventListener?.('mouseup', end);
        doc?.addEventListener?.('touchmove', e => {
            const t = e.touches?.[0];
            if (t) move(t.clientX, t.clientY, e);
        }, { passive: false });
        doc?.addEventListener?.('touchend', end);
        doc?.addEventListener?.('touchcancel', end);
    }
}
function createBall() {
    const ball = document.createElement('div');
    ball.id = 'ccx-ball';
    ball.title = '柠檬总结 · 点击打开，拖动可移动';
    ball.innerHTML = '<span class="ccx-ball-glyph">◈</span><span id="ccx-ball-badge" hidden></span>';
    document.body.appendChild(ball);
    ballEl = ball;
    if (uiState.ball && Number.isFinite(uiState.ball.x)) {
        const p = clampToViewport(uiState.ball, 58, 58);
        ball.style.left = `${p.x}px`;
        ball.style.top = `${p.y}px`;
        ball.style.right = 'auto';
        ball.style.bottom = 'auto';
    }
    makeDraggable(ball, ball, ({ x, y, moved }) => {
        if (moved) { uiState.ball = { x, y }; saveUI(); }
        else togglePanel();
    });
    applyBallVisibility();
    updateBadge();
}
function applyPanelPosition() {
    if (!panelEl) return;
    if (uiState.panel && Number.isFinite(uiState.panel.x)) {
        const vw = Number(globalThis.innerWidth) || 1024;
        const p = clampToViewport(uiState.panel, Math.min(560, Math.max(120, vw - 32)), 200);
        panelEl.style.left = `${p.x}px`;
        panelEl.style.top = `${p.y}px`;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
    }
}
function togglePanel(forceOpen) {
    if (!panelEl) return;
    const shouldOpen = forceOpen ?? panelEl.hidden;
    panelEl.hidden = !shouldOpen;
    if (shouldOpen) {
        panelEl.classList.remove('ccx-minimized');
        refreshStats();
        renderArchiveBlocks();
        renderArchivePreview();
        try { refreshSnapshots(); } catch { /* noop */ }
    }
}
function mountSettingsEntry() {
    const host = document.getElementById('extensions_settings2');
    if (!host || document.getElementById('ccx-settings-entry')) return;
    const box = document.createElement('div');
    box.id = 'ccx-settings-entry';
    box.className = 'ccx-settings-entry';
    const h = document.createElement('h4');
    h.textContent = '柠檬总结 (Ningmeng Summary)';
    const p = document.createElement('p');
    p.textContent = '就地压缩聊天记录以减少上下文 token，结果直接显示在聊天里，不写入世界书。通常通过右下角悬浮球打开。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ccx-btn ccx-btn-primary';
    btn.textContent = '打开柠檬总结面板';
    btn.addEventListener('click', () => togglePanel(true));
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(btn);
    host.appendChild(box);
}
function bindUI() {
    // Tab
    document.querySelectorAll('.ccx-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $id('ccx-btn-close')?.addEventListener('click', () => togglePanel(false));
    $id('ccx-btn-min')?.addEventListener('click', () => panelEl?.classList.toggle('ccx-minimized'));
    $id('ccx-btn-clear-log')?.addEventListener('click', () => { const b = $id('ccx-log'); if (b) b.innerHTML = ''; });
    makeDraggable($id('ccx-drag-handle'), panelEl, ({ x, y, moved }) => {
        if (moved) { uiState.panel = { x, y }; saveUI(); }
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (archiveViewerEl) { closeArchiveViewer(); return; }
        if (panelEl && !panelEl.hidden) togglePanel(false);
    });

    // 全量同步：任何控件变化都写回配置
    panelEl.querySelectorAll('input, select, textarea').forEach(el => {
        el.addEventListener('change', () => syncFromUI());
    });

    // 手动压缩
    $id('ccx-btn-all')?.addEventListener('click', () => {
        const len = getChat().length;
        const f = $id('ccx-manual-from'), t = $id('ccx-manual-to');
        if (f) f.value = 0;
        if (t) t.value = Math.max(0, len - 1);
        syncFromUI();
        toast('已全选上文；建议用「保留最近 10 楼」避免压缩最近对话', 'info');
    });
    $id('ccx-btn-recent')?.addEventListener('click', () => {
        const len = getChat().length;
        const f = $id('ccx-manual-from'), t = $id('ccx-manual-to');
        if (f) f.value = 0;
        if (t) t.value = Math.max(0, len - 11);
        syncFromUI();
    });
    $id('ccx-btn-refresh')?.addEventListener('click', () => { refreshStats(); toast('统计已刷新', 'success'); });
    $id('ccx-btn-run')?.addEventListener('click', () => {
        syncFromUI();
        runCompression({
            from: config.manual.from, to: config.manual.to,
            chunk: config.manual.chunk, mode: config.manual.mode,
            skip: config.manual.skipCompressed, reason: '手动',
        });
    });
    $id('ccx-btn-stop')?.addEventListener('click', () => {
        stopFlag = true;
        try { activeController?.abort('user-stop'); } catch { /* noop */ }
        log('已请求停止，将在当前请求结束后停止');
    });
    $id('ccx-btn-recompress')?.addEventListener('click', recompress);

    // 输出字数
    $id('ccx-length-mode')?.addEventListener('change', () => {
        syncFromUI();
        updateLengthFields();
        updateLengthHint();
    });
    $id('ccx-btn-length-save')?.addEventListener('click', () => {
        syncFromUI();
        updateLengthFields();
        updateLengthHint();
        toast('字数设置已保存', 'success');
    });
    $id('ccx-btn-length-preview')?.addEventListener('click', previewLengthTargets);

    // 请求节流
    ['ccx-throttle-enabled', 'ccx-throttle-gap', 'ccx-throttle-min', 'ccx-throttle-max', 'ccx-throttle-pause', 'ccx-adv-timeout']
        .forEach(id => $id(id)?.addEventListener('change', updateThrottleHint));
    $id('ccx-btn-throttle-save')?.addEventListener('click', () => {
        syncFromUI();
        updateThrottleHint();
        toast('节流设置已保存', 'success');
    });

    // API
    $id('ccx-key-toggle')?.addEventListener('click', () => {
        const el = $id('ccx-api-key');
        if (el) el.type = el.type === 'password' ? 'text' : 'password';
    });
    $id('ccx-btn-save-api')?.addEventListener('click', async () => {
        syncFromUI();
        if (!config.api.url && !config.api.proxy) { toast('请先填写 API 基础 URL', 'error'); return; }
        toast('连接配置已保存，正在测试…', 'success');
        await testConnection(true);
    });
    $id('ccx-btn-test')?.addEventListener('click', () => { syncFromUI(); testConnection(); });
    $id('ccx-btn-testgen')?.addEventListener('click', () => { syncFromUI(); testGeneration(); });
    $id('ccx-btn-clear-api')?.addEventListener('click', () => {
        if (!globalThis.confirm('清除 API 地址、密钥和已选模型？')) return;
        config.api = clone(DEFAULT_CONFIG.api);
        saveConfig();
        ['ccx-api-url', 'ccx-api-key', 'ccx-model-custom', 'ccx-adv-proxy'].forEach(id => { const el = $id(id); if (el) el.value = ''; });
        fillModelSelect([]);
        setStatus('未配置');
        toast('API 配置已清除', 'success');
    });
    $id('ccx-btn-models')?.addEventListener('click', async () => {
        syncFromUI();
        setStatus('正在加载模型列表…');
        const ids = await testConnection(true);
        if (ids) toast(`已加载 ${ids.length} 个模型`, 'success');
    });
    $id('ccx-model-select')?.addEventListener('change', e => {
        if (!e.target.value) return;
        config.api.model = e.target.value;
        const c = $id('ccx-model-custom'); if (c) c.value = e.target.value;
        saveConfig();
        const st = $id('ccx-model-status'); if (st) st.textContent = `当前模型：${config.api.model}`;
    });
    $id('ccx-btn-use-model')?.addEventListener('click', () => {
        const manual = $id('ccx-model-custom')?.value?.trim();
        const selected = $id('ccx-model-select')?.value;
        const model = manual || selected;
        if (!model) { toast('请填写或选择模型名', 'error'); return; }
        config.api.model = model;
        saveConfig();
        fillModelSelect([...($id('ccx-model-select')?.options ? Array.from($id('ccx-model-select').options).map(o => o.value).filter(Boolean) : [])]);
        const st = $id('ccx-model-status'); if (st) st.textContent = `当前模型：${model}`;
        toast(`已选择模型：${model}`, 'success');
    });

    // 提示词
    $id('ccx-btn-save-jb')?.addEventListener('click', () => { syncFromUI(); toast('破限词已保存', 'success'); });
    $id('ccx-btn-clear-jb')?.addEventListener('click', () => {
        const el = $id('ccx-jailbreak'); if (el) el.value = '';
        syncFromUI(); toast('已清空破限词', 'success');
    });
    $id('ccx-preset-select')?.addEventListener('change', e => {
        const key = e.target.value;
        if (key !== 'custom' && PRESETS[key]) {
            const el = $id('ccx-task-prompt'); if (el) el.value = PRESETS[key];
        }
        syncFromUI();
    });
    $id('ccx-task-prompt')?.addEventListener('input', () => {
        const sel = $id('ccx-preset-select'); if (sel) sel.value = 'custom';
    });
    $id('ccx-btn-save-task')?.addEventListener('click', () => { syncFromUI(); toast('压缩提示词已保存', 'success'); });
    $id('ccx-btn-reset-task')?.addEventListener('click', () => {
        const key = $id('ccx-preset-select')?.value;
        const el = $id('ccx-task-prompt');
        if (el) el.value = PRESETS[key] || PRESETS.balanced;
        syncFromUI(); toast('已恢复预设', 'success');
    });
    $id('ccx-btn-save-tpl')?.addEventListener('click', () => { syncFromUI(); toast('显示模板已保存', 'success'); });
    $id('ccx-btn-reset-tpl')?.addEventListener('click', () => {
        const el = $id('ccx-block-template'); if (el) el.value = DEFAULT_BLOCK_TEMPLATE;
        syncFromUI(); toast('模板已恢复默认', 'success');
    });
    $id('ccx-btn-save-re')?.addEventListener('click', () => { syncFromUI(); toast('二次压缩提示词已保存', 'success'); });
    $id('ccx-btn-reset-re')?.addEventListener('click', () => {
        const el = $id('ccx-recompress-prompt'); if (el) el.value = DEFAULT_RECOMPRESS_PROMPT;
        syncFromUI(); toast('已恢复默认', 'success');
    });

    // 自动
    $id('ccx-btn-save-auto')?.addEventListener('click', () => { syncFromUI(); refreshStats(); toast('自动压缩设置已保存', 'success'); });
    $id('ccx-btn-check-auto')?.addEventListener('click', () => { syncFromUI(); scheduleAuto(true); toast('已触发一次检测', 'info'); });

    // 备份
    $id('ccx-btn-restore-all')?.addEventListener('click', async () => {
        if (!globalThis.confirm('把所有压缩块还原成原始消息？此操作会改变聊天楼层编号。')) return;
        await restoreAll();
    });
    $id('ccx-btn-export')?.addEventListener('click', exportBackup);
    $id('ccx-btn-strip-backups')?.addEventListener('click', async () => {
        if (!globalThis.confirm('清除所有压缩块内保存的原文？清除后无法再逐块还原（快照仍可整体恢复）。')) return;
        await stripBackups();
    });
    $id('ccx-btn-snapshot')?.addEventListener('click', async () => {
        try { await putSnapshot(getChat(), '手动快照'); await refreshSnapshots(); toast('快照已创建', 'success'); }
        catch (e) { toast(`快照失败：${e?.message || e}`, 'error'); }
    });
    $id('ccx-btn-snapshot-refresh')?.addEventListener('click', refreshSnapshots);

    // 原文预览 / 选择性还原
    $id('ccx-btn-arch-preview')?.addEventListener('click', previewFloors);
    $id('ccx-arch-floors')?.addEventListener('keydown', e => { if (e.key === 'Enter') previewFloors(); });
    $id('ccx-btn-arch-viewer')?.addEventListener('click', () => {
        const floors = parseFloorSpec($id('ccx-arch-floors')?.value ?? '');
        openArchiveViewer(floors.length ? { floors, title: '原文查看器 · 指定楼层' } : {});
    });
    $id('ccx-btn-arch-selectall')?.addEventListener('click', () => {
        const box = $id('ccx-arch-result');
        if (!box) return;
        const cbs = [...box.querySelectorAll('input[type="checkbox"]')];
        const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
        cbs.forEach(cb => { cb.checked = !allChecked; });
    });
    $id('ccx-btn-arch-restore')?.addEventListener('click', restoreFromPanel);
    $id('ccx-btn-arch-refresh')?.addEventListener('click', renderArchiveBlocks);

    // 高级
    $id('ccx-btn-save-adv')?.addEventListener('click', () => { syncFromUI(); toast('高级设置已保存', 'success'); });
    $id('ccx-btn-export-settings')?.addEventListener('click', exportSettings);
    $id('ccx-btn-import-settings')?.addEventListener('click', () => $id('ccx-import-file')?.click());
    $id('ccx-import-file')?.addEventListener('change', e => {
        const f = e.target.files?.[0];
        if (f) importSettings(f);
        e.target.value = '';
    });
    $id('ccx-btn-reset-ball')?.addEventListener('click', () => {
        delete uiState.ball; delete uiState.panel; saveUI();
        if (ballEl) { ballEl.style.left = ''; ballEl.style.top = ''; ballEl.style.right = ''; ballEl.style.bottom = ''; }
        if (panelEl) { panelEl.style.left = ''; panelEl.style.top = ''; panelEl.style.right = ''; panelEl.style.bottom = ''; }
        toast('悬浮球与面板位置已重置', 'success');
    });
    $id('ccx-btn-reload-chat')?.addEventListener('click', async () => {
        if (!globalThis.confirm('从服务器重新载入当前聊天？内存中未保存的改动会丢失。')) return;
        try { await getCtx()?.reloadCurrentChat?.(); await refreshStats(); toast('聊天已重新载入', 'success'); }
        catch (e) { toast(`重载失败：${e?.message || e}`, 'error'); }
    });
    $id('ccx-btn-reset-all')?.addEventListener('click', () => {
        if (!globalThis.confirm('恢复全部默认设置？（不会改动聊天记录，API 密钥会被清除）')) return;
        localStorage.removeItem(LS_CONFIG);
        config = loadConfig();
        loadConfigToUI();
        toast('设置已恢复默认', 'success');
    });
}

/* ---------------- 启动 ---------------- */

async function boot() {
    if (!getCtx()) {
        console.warn('[ContextCompressor] SillyTavern.getContext() 不可用，扩展未启动');
        return;
    }
    try {
        // 传字符串而非 URL 对象：部分旧 WebView 的 fetch 不接受 URL 实例
        const res = await fetch(PANEL_FILE_URL.href, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`panel.html HTTP ${res.status}`);
        const html = await res.text();
        const root = document.createElement('div');
        root.id = 'ccx-root';
        root.innerHTML = html;
        document.body.appendChild(root);
        panelEl = $id('ccx-panel');
        if (panelEl) { panelEl.hidden = true; panelEl.classList.remove('ccx-minimized'); }
        createBall();
        applyPanelPosition();
        loadConfigToUI();
        bindUI();
        mountSettingsEntry();
        panelReady = true;
    } catch (e) {
        console.error('[ContextCompressor] 界面初始化失败', e);
        try { toast(`界面初始化失败：${e?.message || e}`, 'error'); } catch { /* noop */ }
        return;
    }

    const ctx = getCtx();
    const et = ctx.eventTypes ?? ctx.event_types ?? {};
    try {
        ctx.eventSource?.on?.(et.MESSAGE_RECEIVED, () => onChatEvent('received'));
        ctx.eventSource?.on?.(et.MESSAGE_SENT, () => onChatEvent('sent'));
        const reload = () => { scheduleRefreshStats(); scheduleDecorate(); };
        [et.CHAT_CHANGED, et.CHAT_LOADED, et.MESSAGE_EDITED, et.MESSAGE_DELETED, et.APP_READY, et.MORE_MESSAGES_LOADED]
            .filter(Boolean).forEach(ev => ctx.eventSource?.on?.(ev, reload));
        // 生成期间禁止改动 chat 与重绘；结束后统一补一次自动检测
        const onGenStart = () => { isGenerating = true; };
        const onGenEnd = () => {
            isGenerating = false;
            scheduleRefreshStats();
            if (config.auto.enabled) scheduleAuto();
        };
        [et.GENERATION_STARTED].filter(Boolean).forEach(ev => ctx.eventSource?.on?.(ev, onGenStart));
        [et.GENERATION_ENDED, et.GENERATION_STOPPED].filter(Boolean).forEach(ev => ctx.eventSource?.on?.(ev, onGenEnd));
    } catch (e) {
        console.warn('[ContextCompressor] 事件绑定异常', e);
    }

    try { setupObserver(); } catch (e) { console.warn('[ContextCompressor] 装饰监听不可用', e); }
    refreshStats();
    try { await refreshSnapshots(); } catch { /* noop */ }
    log('柠檬总结已就绪 · 压缩结果直接写入聊天记录，不写世界书', 'ok');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot(); }, { once: true });
} else {
    boot();
}
