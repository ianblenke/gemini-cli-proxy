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
    { id: 'gemini-3.1-flash-lite-preview', owned_by: 'google' },
];

// In-memory token cache
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let projectId = null;

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
            const parts = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            for (const tc of msg.tool_calls) {
                parts.push({
                    functionCall: {
                        id: tc.id,
                        name: tc.function.name,
                        args: typeof tc.function.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : tc.function.arguments,
                    },
                });
            }
            contents.push({ role: 'model', parts });
        } else if (msg.role === 'tool') {
            // Tool result -> user message with functionResponse part
            // Try to merge consecutive tool messages into one user turn
            const lastContent = contents[contents.length - 1];
            const part = {
                functionResponse: {
                    id: msg.tool_call_id,
                    name: msg.name || '',
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
                parts: [{ text: msg.content || '' }],
            });
        }
    }

    return { contents, systemInstruction };
}

function convertGeminiFunctionCallsToOpenAI(parts) {
    const toolCalls = [];
    for (const part of parts) {
        if (part.functionCall) {
            toolCalls.push({
                id: part.functionCall.id || `call_${uuidv4().slice(0, 8)}`,
                type: 'function',
                function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                },
            });
        }
    }
    return toolCalls;
}

// --- Request building ---

function buildRequestBody(model, project, messages, thinkingBudget, tools) {
    const { contents, systemInstruction } = convertMessages(messages);

    const body = {
        model,
        project,
        request: {
            contents,
            generationConfig: {
                temperature: 1,
                maxOutputTokens: 65536,
            },
            safetySettings: [],
        },
        enabled_credit_types: ['GOOGLE_ONE_AI'],
    };

    if (thinkingBudget > 0) {
        body.request.generationConfig.thinkingConfig = {
            thinkingBudget,
            includeThoughts: true,
        };
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
                    } else if (part.text && part.thought) {
                        thinkingText += part.text;
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

async function handleNonStreaming(req, res, token, project) {
    const { model, messages, tools } = req.body;
    const geminiModel = model || DEFAULT_MODEL;
    const thinkingBudget = req.body.thinking?.budget_tokens || 0;

    const body = buildRequestBody(geminiModel, project, messages, thinkingBudget, tools);

    const resp = await fetch(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error (${resp.status}): ${err}`);
    }

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
        model: modelVersion || geminiModel,
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

async function handleStreaming(req, res, token, project) {
    const { model, messages, tools } = req.body;
    const geminiModel = model || DEFAULT_MODEL;
    const thinkingBudget = req.body.thinking?.budget_tokens || 0;
    const chatId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    const body = buildRequestBody(geminiModel, project, messages, thinkingBudget, tools);

    const resp = await fetch(`${GEMINI_API_BASE}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Gemini API error (${resp.status}): ${err}`);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let resolvedModel = geminiModel;
    let sentRole = false;
    let toolCallIndex = 0;
    let hasToolCalls = false;

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
                        sendChunk({
                            tool_calls: [{
                                index: toolCallIndex,
                                id: callId,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: JSON.stringify(part.functionCall.args || {}),
                                },
                            }],
                        }, null);
                        toolCallIndex++;
                    } else if (part.text && part.thought) {
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

app.use(bodyParser.json());

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
    const promptPreview = lastMsg?.content?.substring(0, 100) || '(tool result)';

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
            await handleStreaming(req, res, token, project);
        } else {
            await handleNonStreaming(req, res, token, project);
        }

        const durationMs = Date.now() - startTime;
        log('info', 'Response', { reqId, model: geminiModel, stream: !!stream, durationMs });
    } catch (err) {
        const durationMs = Date.now() - startTime;
        log('error', 'Request failed', { reqId, model: geminiModel, durationMs, error: err.message });
        if (!res.headersSent) {
            res.status(500).json({
                error: {
                    message: err.message,
                    type: 'internal_error',
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
