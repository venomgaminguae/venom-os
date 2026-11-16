# Authentication Patterns

When deciding how an agent connects to its model provider, use this decision table.

| Provider | Method | Best Use Case | Key Configuration |
|---|---|---|---|
| **Anthropic** | API Key | Standard Hermes/Claude agents | `ANTHROPIC_API_KEY` in `.env` |
| **Google (Personal)** | **OAuth** | Using Gemini via **Antigravity CLI (`agy`)** on a Pro/Ultra plan | Use `geminiEnv()` to strip API keys and force OAuth via `agy` |
| **Google (Enterprise)** | **Vertex AI** | Using Gemini in a corporate environment | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_GENAI_USE_VERTEXAI=true` |
| **Google (Developer)** | **API Key** | Using Gemini via Google AI Studio | `GEMINI_API_KEY` in `.env` |
| **OpenAI** | API Key | Standard OpenAI agents | `OPENAI_API_KEY` in `.env` |
| **Local Models** | Local Server | Running Ollama, Llama.cpp, etc. | `base_url` + `api_key` (usually dummy) |

## Implementation Note: Stripping Keys

When bridging a non-Anthropic provider (like Gemini via `agy`), it is **critical** to strip the existing `ANTHROPIC_API_KEY` from the environment. If the agent's binary sees an Anthropic key, it may attempt to use it for its own auth, causing authentication failures.

**Correct Pattern:**
```javascript
function providerEnv() {
  const env = childEnv();
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC|CLAUDE)/i.test(k)) delete env[k];
  }
  return env;
}
```
