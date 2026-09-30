import { DefaultExecutor } from "./default.js";

export class AzureExecutor extends DefaultExecutor {
  constructor() {
    super("azure");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const azureEndpoint = credentials?.providerSpecificData?.azureEndpoint
      || process.env.AZURE_ENDPOINT
      || "https://api.openai.com";

    const apiVersion = credentials?.providerSpecificData?.apiVersion
      || process.env.AZURE_API_VERSION
      || "2024-10-01-preview";

    const deployment = credentials?.providerSpecificData?.deployment
      || model
      || process.env.AZURE_DEPLOYMENT
      || "gpt-4";

    const endpoint = azureEndpoint.replace(/\/$/, "");
    // Azure v1 API (".../openai/v1"): OpenAI-style path, deployment goes in body.model, no api-version
    if (/\/openai\/v1$/.test(endpoint)) return `${endpoint}/chat/completions`;
    return `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    const apiKey = credentials?.apiKey
      || credentials?.accessToken
      || process.env.OPENAI_API_KEY;

    if (apiKey) {
      headers["api-key"] = apiKey;
    }

    const organization = credentials?.providerSpecificData?.organization
      || process.env.AZURE_ORGANIZATION;

    if (organization) {
      headers["OpenAI-Organization"] = organization;
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    // Reasoning models (gpt-5+, o-series) reject max_tokens; deployment names don't reveal the model,
    // so always send max_completion_tokens (accepted by all models since api-version 2024-09-01-preview)
    if (body.max_tokens !== undefined) {
      const { max_tokens, ...rest } = body;
      body = { max_completion_tokens: max_tokens, ...rest };
    }
    // gpt-5.x on /chat/completions rejects function tools + reasoning_effort (400) — drop reasoning when tools are sent.
    // ponytail: tools requests lose reasoning; upgrade = route tools+reasoning requests to Azure /responses.
    if (body.tools?.length && (body.reasoning_effort !== undefined || body.reasoning !== undefined)) {
      const { reasoning_effort, reasoning, ...rest } = body;
      body = rest;
    }
    const deployment = credentials?.providerSpecificData?.deployment;
    if (deployment && /\/openai\/v1\/?$/.test(credentials?.providerSpecificData?.azureEndpoint || "")) {
      return { ...body, model: deployment };
    }
    return body;
  }
}
