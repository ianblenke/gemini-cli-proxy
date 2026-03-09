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

function parseSSEResponse(sseText) {
    // Parse SSE lines: "data: {...}\n\n"
    const lines = sseText.split('\n');
    let fullText = '';
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
                    if (part.text && !part.thought) {
                        fullText += part.text;
                    }
                }
            }
            if (resp.usageMetadata) {
                usage = resp.usageMetadata;
            }
            if (resp.modelVersion) {
                modelVersion = resp.modelVersion;
            }
        } catch (e) {
            // skip unparseable lines
        }
    }

    return { text: fullText, usage, modelVersion };
}

async function callGeminiApi(token, project, model, messages) {
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

    if (systemInstruction) {
        body.request.systemInstruction = systemInstruction;
    }

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
    return parseSSEResponse(sseText);
}

app.use(bodyParser.json());

app.post('/v1/chat/completions', async (req, res) => {
    const { model, messages } = req.body;
    const geminiModel = model || DEFAULT_MODEL;

    const promptPreview = messages[messages.length - 1]?.content?.substring(0, 80);
    console.log(`Request: model=${geminiModel}, prompt="${promptPreview}"`);

    try {
        const token = await getAccessToken();
        const project = await discoverProjectId(token);
        const { text, usage, modelVersion } = await callGeminiApi(token, project, geminiModel, messages);

        const openaiResponse = {
            id: `chatcmpl-${uuidv4()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelVersion || geminiModel,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: text,
                    },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: usage.promptTokenCount || -1,
                completion_tokens: usage.candidatesTokenCount || -1,
                total_tokens: usage.totalTokenCount || -1,
            },
        };

        res.json(openaiResponse);
    } catch (err) {
        console.error(`Error: ${err.message}`);
        res.status(500).json({
            error: {
                message: err.message,
                type: 'internal_error',
            },
        });
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
