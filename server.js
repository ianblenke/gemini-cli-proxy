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

// In-memory token cache
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let projectId = null;

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

    console.log('Refreshing OAuth access token...');
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

    // Update the creds file so the gemini CLI can also benefit from the refresh
    try {
        creds.access_token = data.access_token;
        creds.expiry_date = tokenExpiresAt;
        if (data.id_token) creds.id_token = data.id_token;
        fs.writeFileSync(OAUTH_CREDS_PATH, JSON.stringify(creds, null, 2));
    } catch (e) {
        console.warn('Could not update oauth_creds.json:', e.message);
    }

    return cachedAccessToken;
}

async function discoverProjectId(token) {
    if (projectId) return projectId;

    console.log('Discovering project ID via loadCodeAssist...');
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
    console.log(`Discovered project ID: ${projectId}`);
    return projectId;
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
        } else {
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }],
            });
        }
    }

    return { contents, systemInstruction };
}

function buildRequestBody(model, project, messages, thinkingBudget) {
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

    return body;
}

// --- Non-streaming path ---

function parseSSEResponse(sseText) {
    const lines = sseText.split('\n');
    let contentText = '';
    let thinkingText = '';
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
                    if (part.text && part.thought) {
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

    return { contentText, thinkingText, usage, modelVersion };
}

async function handleNonStreaming(req, res, token, project) {
    const { model, messages } = req.body;
    const geminiModel = model || DEFAULT_MODEL;
    const thinkingBudget = req.body.thinking?.budget_tokens || 0;

    const body = buildRequestBody(geminiModel, project, messages, thinkingBudget);

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
    const { contentText, thinkingText, usage, modelVersion } = parseSSEResponse(sseText);

    const message = {
        role: 'assistant',
        content: contentText,
    };
    if (thinkingText) {
        message.reasoning_content = thinkingText;
    }

    res.json({
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelVersion || geminiModel,
        choices: [{
            index: 0,
            message,
            finish_reason: 'stop',
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
    const { model, messages } = req.body;
    const geminiModel = model || DEFAULT_MODEL;
    const thinkingBudget = req.body.thinking?.budget_tokens || 0;
    const chatId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    const body = buildRequestBody(geminiModel, project, messages, thinkingBudget);

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

    // Process the SSE stream from Gemini
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line in buffer

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
                    if (!part.text) continue;

                    if (!sentRole) {
                        sendChunk({ role: 'assistant' }, null);
                        sentRole = true;
                    }

                    if (part.thought) {
                        sendChunk({ reasoning_content: part.text }, null);
                    } else {
                        sendChunk({ content: part.text }, null);
                    }
                }
            }
        }
    } catch (streamErr) {
        console.error(`Stream error: ${streamErr.message}`);
    }

    // Send finish chunk
    sendChunk({}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
}

// --- Routes ---

app.use(bodyParser.json());

app.post('/v1/chat/completions', async (req, res) => {
    const { model, messages, stream } = req.body;
    const geminiModel = model || DEFAULT_MODEL;

    const promptPreview = messages[messages.length - 1]?.content?.substring(0, 80);
    console.log(`Request: model=${geminiModel}, stream=${!!stream}, prompt="${promptPreview}"`);

    try {
        const token = await getAccessToken();
        const project = await discoverProjectId(token);

        if (stream) {
            await handleStreaming(req, res, token, project);
        } else {
            await handleNonStreaming(req, res, token, project);
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
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
    console.log(`Gemini CLI Proxy listening at http://0.0.0.0:${port}`);
    console.log(`Using OAuth creds from: ${OAUTH_CREDS_PATH}`);
    console.log(`Default model: ${DEFAULT_MODEL}`);
});
