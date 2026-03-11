const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 4000;

// OAuth client credentials — set via environment variables
// These match the gemini CLI's own OAuth client (public "installed app" credentials)
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GEMINI_API_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const DEFAULT_MODEL = 'gemini-2.5-flash';

const OAUTH_CREDS_PATH = process.env.OAUTH_CREDS_PATH ||
    path.join(process.env.HOME || '/home/node', '.gemini', 'oauth_creds.json');

const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
// RATE_LIMIT=0 means wait for quota instead of returning 429
const RATE_LIMIT_WAIT = process.env.RATE_LIMIT === '0';

// --- Logging ---

function timestamp() {
    return new Date().toISOString();
}

function log(level, msg, meta) {
    const entry = { time: timestamp(), level, msg };
    if (meta) Object.assign(entry, meta);
    console.log(JSON.stringify(entry));
}

// Available models exposed via /v1/models
const AVAILABLE_MODELS = [
    { id: 'gemini-2.5-pro', owned_by: 'google' },
    { id: 'gemini-2.5-flash', owned_by: 'google' },
    { id: 'gemini-2.5-flash-lite', owned_by: 'google' },
    { id: 'gemini-3-pro-preview', owned_by: 'google' },
    { id: 'gemini-3-flash-preview', owned_by: 'google' },
    { id: 'gemini-3.1-pro-preview', owned_by: 'google' },
];

// In-memory token cache
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let projectId = null;

// Cache thought parts (with thought_signature) keyed by tool call ID.
// Gemini 3.x requires thought_signature on round-trips but the OpenAI format has no way
// to carry it, so we cache server-side and re-inject when the client echoes back tool_calls.
const thoughtCache = new Map();
const THOUGHT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// --- Auth middleware ---

function authenticate(req, res, next) {
    if (!PROXY_API_KEY) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        log('warn', 'Auth rejected: missing header', { ip: req.ip, path: req.path });
        return res.status(401).json({ error: { message: 'Missing Authorization header', type: 'auth_error' } });
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (token !== PROXY_API_KEY) {
        log('warn', 'Auth rejected: invalid key', { ip: req.ip, path: req.path });
        return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
    }

    next();
}

// --- OAuth token management ---

function loadOauthCreds() {
    const raw = fs.readFileSync(OAUTH_CREDS_PATH, 'utf8');
    return JSON.parse(raw);
}

async function getAccessToken() {
    if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedAccessToken;
    }

    const creds = loadOauthCreds();

    if (creds.access_token && creds.expiry_date && Date.now() < creds.expiry_date - 60000) {
        cachedAccessToken = creds.access_token;
        tokenExpiresAt = creds.expiry_date;
        return cachedAccessToken;
    }

    log('info', 'Refreshing OAuth access token');
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: creds.refresh_token,
    });

    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Token refresh failed (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    cachedAccessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in * 1000);

    try {
        creds.access_token = data.access_token;
        creds.expiry_date = tokenExpiresAt;
        if (data.id_token) creds.id_token = data.id_token;
        fs.writeFileSync(OAUTH_CREDS_PATH, JSON.stringify(creds, null, 2));
    } catch (e) {
        log('warn', 'Could not update oauth_creds.json', { error: e.message });
    }

    return cachedAccessToken;
}

async function discoverProjectId(token) {
    if (projectId) return projectId;

    log('info', 'Discovering project ID via loadCodeAssist');
    const resp = await fetch(`${GEMINI_API_BASE}:loadCodeAssist`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`loadCodeAssist failed (${resp.status}): ${err}`);
    }

    const data = await resp.json();
    projectId = data.cloudaicompanionProject || data.project;
    if (!projectId) {
        throw new Error(`No project ID in loadCodeAssist response: ${JSON.stringify(data)}`);
    }
    log('info', 'Discovered project ID', { projectId });
    return projectId;
}

// --- Retry and fallback logic ---

const MAX_RETRIES = 5;
const RETRY_STATUS_CODES = new Set([429, 499, 500, 502, 503, 504]);

// Model fallback chain — when a model is rate-limited, try the next one
const MODEL_FALLBACKS = {
    'gemini-3.1-pro-preview':   'gemini-3-pro-preview',
    'gemini-3-pro-preview':     'gemini-2.5-pro',
    'gemini-2.5-pro':           'gemini-2.5-flash',
    'gemini-3-flash-preview':   'gemini-2.5-flash',
    'gemini-2.5-flash':         'gemini-2.5-flash-lite',
};

// Per-model cooldown: tracks when each model's quota resets
// { model: expiresAtTimestamp }
const modelCooldowns = new Map();

function isQuotaExhausted(errBody) {
    return errBody.includes('RATE_LIMIT_EXCEEDED') ||
           errBody.includes('exhausted your capacity') ||
           errBody.includes('QuotaFailure');
}

function parseResetSeconds(errBody) {
    const match = errBody.match(/after (\d+)s/);
    return match ? parseInt(match[1]) : 0;
}

function setModelCooldown(model, resetSeconds) {
    const expiresAt = Date.now() + (resetSeconds * 1000);
    modelCooldowns.set(model, expiresAt);
}

function isModelCoolingDown(model) {
    const expiresAt = modelCooldowns.get(model);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
        modelCooldowns.delete(model);
        return false;
    }
    return true;
}

// Walk the fallback chain to find the best available model
function resolveAvailableModel(requestedModel) {
    let model = requestedModel;
    while (isModelCoolingDown(model)) {
        const fallback = MODEL_FALLBACKS[model];
        if (!fallback) break;
        model = fallback;
    }
    return model;
}

function swapModelInBody(bodyStr, newModel) {
    const body = JSON.parse(bodyStr);
    body.model = newModel;

    // Fix thinkingConfig when crossing Gemini 3 ↔ 2.5 boundary
    const tc = body.request?.generationConfig?.thinkingConfig;
    if (tc) {
        if (isGemini3Model(newModel)) {
            // Gemini 3 uses thinkingLevel, not thinkingBudget
            delete tc.thinkingBudget;
            tc.thinkingLevel = tc.thinkingLevel || 'HIGH';
        } else {
            // Gemini 2.5 uses thinkingBudget, not thinkingLevel
            delete tc.thinkingLevel;
            tc.thinkingBudget = tc.thinkingBudget || 8192;
        }
    }

    return JSON.stringify(body);
}

async function fetchWithRetry(url, options, reqId) {
    let lastResp;
    let currentBody = options.body;
    let requestedModel = null;
    try { requestedModel = JSON.parse(currentBody).model; } catch (e) {}

    // Skip models known to be cooling down
    let currentModel = resolveAvailableModel(requestedModel);
    if (currentModel !== requestedModel) {
        log('info', 'Skipping cooled-down model', {
            reqId, requested: requestedModel, using: currentModel,
        });
        currentBody = swapModelInBody(currentBody, currentModel);
    }

    const maxAttempts = RATE_LIMIT_WAIT ? Infinity : MAX_RETRIES;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        lastResp = await fetch(url, { ...options, body: currentBody });
        if (lastResp.ok || !RETRY_STATUS_CODES.has(lastResp.status)) {
            lastResp._actualModel = currentModel;
            return lastResp;
        }

        if (attempt >= MAX_RETRIES && !RATE_LIMIT_WAIT) break;

        let errBody = '';
        try { errBody = await lastResp.text(); } catch (e) {}

        if (lastResp.status === 429 && isQuotaExhausted(errBody) && currentModel) {
            // Record cooldown for this model
            const resetSecs = parseResetSeconds(errBody);
            if (resetSecs > 0) {
                setModelCooldown(currentModel, resetSecs);
            }

            // Try fallback model
            const fallback = MODEL_FALLBACKS[currentModel];
            if (fallback && !isModelCoolingDown(fallback)) {
                log('warn', 'Model quota exhausted, falling back', {
                    reqId, from: currentModel, to: fallback,
                    cooldownSecs: resetSecs,
                });
                currentBody = swapModelInBody(currentBody, fallback);
                currentModel = fallback;
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            // All models exhausted
            if (RATE_LIMIT_WAIT && resetSecs > 0) {
                // Wait for the shortest cooldown to expire, then retry
                log('warn', 'All models quota exhausted, waiting for reset', {
                    reqId, model: currentModel, waitSecs: resetSecs,
                });
                await new Promise(r => setTimeout(r, resetSecs * 1000 + 500));
                // Reset cooldowns and try the best model again
                currentModel = resolveAvailableModel(requestedModel);
                currentBody = swapModelInBody(options.body, currentModel);
                continue;
            }
            log('warn', 'All models quota exhausted', {
                reqId, model: currentModel, cooldownSecs: resetSecs,
            });
            throw new Error(`Gemini API error (429): All models quota exhausted. Retry after ${resetSecs}s.`);
        }

        // Transient error (not quota) — retry with short backoff
        let delayMs = 100 * Math.pow(2, attempt);
        log('warn', 'Retrying request (transient)', {
            reqId, attempt: attempt + 1, status: lastResp.status,
            model: currentModel, delayMs,
        });
        await new Promise(r => setTimeout(r, delayMs));
    }
    return lastResp;
}

// --- OpenAI <-> Gemini format conversion ---

function convertToolsToGemini(tools) {
    if (!tools || tools.length === 0) return undefined;

    const functionDeclarations = tools
        .filter(t => t.type === 'function')
        .map(t => ({
            name: t.function.name,
            description: t.function.description || '',
            parametersJsonSchema: t.function.parameters,
        }));

    if (functionDeclarations.length === 0) return undefined;
    return [{ functionDeclarations }];
}

function convertContentToParts(content) {
    if (!content) return [{ text: '' }];
    if (typeof content === 'string') return [{ text: content }];

    // OpenAI multi-modal content array
    const parts = [];
    for (const item of content) {
        if (item.type === 'text') {
            parts.push({ text: item.text });
        } else if (item.type === 'image_url') {
            const url = item.image_url?.url || '';
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
        }
    }
    return parts.length > 0 ? parts : [{ text: '' }];
}

function convertMessages(messages) {
    const contents = [];
    let systemInstruction = null;

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction = {
                role: 'system',
                parts: [{ text: msg.content }],
            };
        } else if (msg.role === 'assistant' && msg.tool_calls) {
            // Assistant message with tool calls -> model message with functionCall parts
            // Re-inject thought parts and thoughtSignature that Gemini 3.x requires on round-trips
            const parts = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            // Inject cached thought parts before function calls (fallback)
            let thoughtsInjected = false;
            for (const tc of msg.tool_calls) {
                if (!thoughtsInjected) {
                    const cached = thoughtCache.get(tc.id);
                    if (cached && cached.expires > Date.now() && cached.thoughtParts) {
                        parts.push(...cached.thoughtParts);
                        thoughtsInjected = true;
                    }
                }
                const fcPart = {
                    functionCall: {
                        id: tc.id,
                        name: tc.function.name,
                        args: typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments,
                    },
                };
                // Use thought_signature from client (passed through), or fall back to cache
                if (tc.thought_signature) {
                    fcPart.thoughtSignature = tc.thought_signature;
                } else {
                    const cached = thoughtCache.get(tc.id);
                    if (cached && cached.expires > Date.now() && cached.thoughtSignature) {
                        fcPart.thoughtSignature = cached.thoughtSignature;
                    }
                }
                parts.push(fcPart);
            }
            contents.push({ role: 'model', parts });
        } else if (msg.role === 'tool') {
            // Tool result -> user message with functionResponse part
            // Resolve function name: use msg.name, or look it up from the preceding assistant tool_calls
            let funcName = msg.name || '';
            if (!funcName && msg.tool_call_id) {
                for (let i = messages.indexOf(msg) - 1; i >= 0; i--) {
                    const prev = messages[i];
                    if (prev.role === 'assistant' && prev.tool_calls) {
                        const tc = prev.tool_calls.find(t => t.id === msg.tool_call_id);
                        if (tc) { funcName = tc.function.name; break; }
                    }
                }
            }
            // Try to merge consecutive tool messages into one user turn
            const lastContent = contents[contents.length - 1];
            const part = {
                functionResponse: {
                    id: msg.tool_call_id,
                    name: funcName,
                    response: { output: msg.content },
                },
            };
            if (lastContent && lastContent.role === 'user' && lastContent.parts[0]?.functionResponse) {
                lastContent.parts.push(part);
            } else {
                contents.push({ role: 'user', parts: [part] });
            }
        } else {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: convertContentToParts(msg.content),
            });
        }
    }

    return { contents, systemInstruction };
}

function convertGeminiFunctionCallsToOpenAI(parts) {
    const toolCalls = [];
    // Collect thought parts (with thought_signature data) for round-trip preservation
    const thoughtParts = parts.filter(p => p.thought);

    for (const part of parts) {
        if (part.functionCall) {
            const callId = part.functionCall.id || `call_${uuidv4().slice(0, 8)}`;
            const tc = {
                id: callId,
                type: 'function',
                function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                },
            };

            // Pass thoughtSignature through to the client so it can echo it back.
            // Gemini 3.x requires this on tool-call round-trips.
            if (part.thoughtSignature) {
                tc.thought_signature = part.thoughtSignature;
            }

            toolCalls.push(tc);
        }
    }

    // Also cache thought parts server-side as fallback (client may not echo them)
    if (thoughtParts.length > 0 && toolCalls.length > 0) {
        for (const tc of toolCalls) {
            thoughtCache.set(tc.id, {
                thoughtParts,
                expires: Date.now() + THOUGHT_CACHE_TTL,
            });
        }
    }

    // Prune expired entries
    for (const [key, val] of thoughtCache) {
        if (val.expires < Date.now()) thoughtCache.delete(key);
    }

    return toolCalls;
}

// --- Request building ---

function isGemini3Model(model) {
    return model && (model.startsWith('gemini-3-') || model.startsWith('gemini-3.'));
}

function buildRequestBody(model, project, messages, thinkingBudget, tools) {
    const { contents, systemInstruction } = convertMessages(messages);

    const body = {
        model,
        project,
        user_prompt_id: uuidv4(),
        request: {
            contents,
            generationConfig: {
                temperature: 1,
                topP: 0.95,
                topK: 64,
                maxOutputTokens: 65535,
            },
            safetySettings: [],
        },
        enabled_credit_types: ['GOOGLE_ONE_AI'],
    };

    if (thinkingBudget > 0) {
        if (isGemini3Model(model)) {
            body.request.generationConfig.thinkingConfig = {
                thinkingLevel: 'HIGH',
                includeThoughts: true,
            };
        } else {
            body.request.generationConfig.thinkingConfig = {
                thinkingBudget,
                includeThoughts: true,
            };
        }
    }

    if (systemInstruction) {
        body.request.systemInstruction = systemInstruction;
    }

    const geminiTools = convertToolsToGemini(tools);
    if (geminiTools) {
        body.request.tools = geminiTools;
    }

    return body;
}

// --- Model safety for tool-call round-trips ---

// Gemini 3.x requires thought_signature on tool-call round-trips.
// If the client sends a round-2 request to a 3.x model but the tool_calls
// lack thought_signature (e.g. because round-1 was served by a 2.5 fallback),
// downgrade to a 2.5 model to avoid the 400 error.
function safeModelForMessages(model, messages) {
    if (!isGemini3Model(model)) return model;

    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.tool_calls) {
            const hasSignature = msg.tool_calls.some(tc =>
                tc.thought_signature || thoughtCache.get(tc.id)?.thoughtSignature
            );
            if (!hasSignature) {
                const fallback = 'gemini-2.5-flash';
                log('warn', 'Downgrading model for tool round-trip (missing thought_signature)', {
                    from: model, to: fallback,
                });
                return fallback;
            }
        }
    }
    return model;
}

// --- Non-streaming path ---

function parseSSEResponse(sseText) {
    const lines = sseText.split('\n');
    let contentText = '';
    let thinkingText = '';
    let allParts = [];
    let usage = {};
    let modelVersion = '';

    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
            const data = JSON.parse(line.slice(6));
            const resp = data.response || data;
            const candidate = resp.candidates?.[0];
            if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                    allParts.push(part);
                    if (part.functionCall) {
                        // collected in allParts
                    } else if (part.thought) {
                        if (part.text) thinkingText += part.text;
                    } else if (part.text) {
                        contentText += part.text;
                    }
                }
            }
            if (resp.usageMetadata) usage = resp.usageMetadata;
            if (resp.modelVersion) modelVersion = resp.modelVersion;
        } catch (e) {
            // skip unparseable lines
        }
    }

    return { contentText, thinkingText, allParts, usage, modelVersion };
}

async function handleNonStreaming(req, res, token, project, reqId) {
    const { model, messages, tools } = req.body;
    const geminiModel = safeModelForMessages(model || DEFAULT_MODEL, messages);
    const thinkingBudget = req.body.thinking?.budget_tokens || 0;

    const body = buildRequestBody(geminiModel, project, messages, thinkingBudget, tools);

    const resp = await fetchWithRetry(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    }, reqId);

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error (${resp.status}): ${err}`);
    }

    const actualModel = resp._actualModel || geminiModel;
    const sseText = await resp.text();
    const { contentText, thinkingText, allParts, usage, modelVersion } = parseSSEResponse(sseText);

    const toolCalls = convertGeminiFunctionCallsToOpenAI(allParts);

    const message = {
        role: 'assistant',
        content: contentText || null,
    };
    if (thinkingText) {
        message.reasoning_content = thinkingText;
    }
    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    res.json({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelVersion || actualModel,
        choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        }],
        usage: {
            prompt_tokens: usage.promptTokenCount || -1,
            completion_tokens: usage.candidatesTokenCount || -1,
            total_tokens: usage.totalTokenCount || -1,
        },
    });
}

// --- Streaming path ---

async function handleStreaming(req, res, token, project, reqId) {
    const { model, messages, tools } = req.body;
    const geminiModel = safeModelForMessages(model || DEFAULT_MODEL, messages);
    const thinkingBudget = req.body.thinking?.budget_tokens || 0;
    const chatId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    const body = buildRequestBody(geminiModel, project, messages, thinkingBudget, tools);

    const resp = await fetchWithRetry(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    }, reqId);

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error (${resp.status}): ${err}`);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let resolvedModel = resp._actualModel || geminiModel;
    let sentRole = false;
    let toolCallIndex = 0;
    let hasToolCalls = false;
    let streamThoughtParts = []; // collect thought parts for thought_signature caching

    function sendChunk(delta, finishReason) {
        const chunk = {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: resolvedModel,
            choices: [{
                index: 0,
                delta,
                finish_reason: finishReason || null,
            }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let data;
                try {
                    data = JSON.parse(line.slice(6));
                } catch (e) {
                    continue;
                }

                const geminiResp = data.response || data;
                if (geminiResp.modelVersion) resolvedModel = geminiResp.modelVersion;

                const candidate = geminiResp.candidates?.[0];
                if (!candidate?.content?.parts) continue;

                for (const part of candidate.content.parts) {
                    if (!sentRole) {
                        sendChunk({ role: 'assistant' }, null);
                        sentRole = true;
                    }

                    if (part.functionCall) {
                        hasToolCalls = true;
                        const callId = part.functionCall.id || `call_${uuidv4().slice(0, 8)}`;
                        // Cache thought parts for round-trip fallback
                        if (streamThoughtParts.length > 0) {
                            thoughtCache.set(callId, {
                                thoughtParts: [...streamThoughtParts],
                                expires: Date.now() + THOUGHT_CACHE_TTL,
                            });
                        }
                        const tcObj = {
                            index: toolCallIndex,
                            id: callId,
                            type: 'function',
                            function: {
                                name: part.functionCall.name,
                                arguments: JSON.stringify(part.functionCall.args || {}),
                            },
                        };
                        // Pass thoughtSignature through so client can echo it back
                        if (part.thoughtSignature) {
                            tcObj.thought_signature = part.thoughtSignature;
                        }
                        sendChunk({ tool_calls: [tcObj] }, null);
                        toolCallIndex++;
                    } else if (part.text && part.thought) {
                        streamThoughtParts.push(part);
                        sendChunk({ reasoning_content: part.text }, null);
                    } else if (part.text) {
                        sendChunk({ content: part.text }, null);
                    }
                }
            }
        }
    } catch (streamErr) {
        log('error', 'Stream error', { error: streamErr.message });
    }

    sendChunk({}, hasToolCalls ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
}

// --- Routes ---

app.use(bodyParser.json({ limit: '100mb' }));

app.get('/v1/models', authenticate, (req, res) => {
    log('info', 'GET /v1/models', { ip: req.ip });
    res.json({
        object: 'list',
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: m.owned_by,
        })),
    });
});

app.post('/v1/chat/completions', authenticate, async (req, res) => {
    const { model, messages, stream, tools } = req.body;
    const geminiModel = model || DEFAULT_MODEL;
    const startTime = Date.now();
    const reqId = uuidv4().slice(0, 8);

    const lastMsg = messages[messages.length - 1];
    const lastContent = lastMsg?.content;
    const promptPreview = typeof lastContent === 'string'
        ? lastContent.substring(0, 100)
        : Array.isArray(lastContent)
            ? '(multi-modal)'
            : '(tool result)';

    log('info', 'Request', {
        reqId,
        ip: req.ip,
        model: geminiModel,
        stream: !!stream,
        messages: messages.length,
        tools: tools?.length || 0,
        prompt: promptPreview,
    });

    try {
        const token = await getAccessToken();
        const project = await discoverProjectId(token);

        if (stream) {
            await handleStreaming(req, res, token, project, reqId);
        } else {
            await handleNonStreaming(req, res, token, project, reqId);
        }

        const durationMs = Date.now() - startTime;
        log('info', 'Response', { reqId, model: geminiModel, stream: !!stream, durationMs });
    } catch (err) {
        const durationMs = Date.now() - startTime;
        log('error', 'Request failed', { reqId, model: geminiModel, durationMs, error: err.message });
        if (!res.headersSent) {
            const status = err.message.includes('429') ? 429 : 500;
            const type = status === 429 ? 'rate_limit_error' : 'internal_error';
            res.status(status).json({
                error: {
                    message: err.message,
                    type,
                },
            });
        } else {
            res.end();
        }
    }
});

app.get('/health/readiness', (req, res) => {
    res.status(200).send('OK');
});

app.listen(port, '0.0.0.0', () => {
    log('info', 'Server started', {
        port,
        oauthCreds: OAUTH_CREDS_PATH,
        defaultModel: DEFAULT_MODEL,
        auth: PROXY_API_KEY ? 'enabled' : 'disabled',
    });
});
