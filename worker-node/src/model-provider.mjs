export function createModelProvider({ provider, debugModelRequests = false }) {
  return new RequestInspectingModelProvider({ provider, debugModelRequests });
}

class RequestInspectingModelProvider {
  constructor({ provider, debugModelRequests }) {
    this.provider = provider;
    this.debugModelRequests = debugModelRequests;
  }

  async getModel(modelName) {
    const model = await this.provider.getModel(modelName);
    return new RequestInspectingModel({ model, debugModelRequests: this.debugModelRequests });
  }

  async close() {
    if (typeof this.provider.close === "function") {
      await this.provider.close();
    }
  }
}

class RequestInspectingModel {
  constructor({ model, debugModelRequests }) {
    this.model = model;
    this.debugModelRequests = debugModelRequests;
  }

  async getResponse(request) {
    this.logRequest("response", request);
    return this.model.getResponse(request);
  }

  getStreamedResponse(request) {
    this.logRequest("stream", request);
    return this.model.getStreamedResponse(request);
  }

  getRetryAdvice(args) {
    if (typeof this.model.getRetryAdvice !== "function") {
      return undefined;
    }
    return this.model.getRetryAdvice.call(this.model, args);
  }

  logRequest(mode, request) {
    if (!this.debugModelRequests) {
      return;
    }
    console.error(`[model-request:${mode}] ${JSON.stringify(summarizeRequest(request))}`);
  }
}

function summarizeRequest(request) {
  const input = Array.isArray(request.input) ? request.input : [{ type: "text" }];
  return {
    previousResponseId: request.previousResponseId ?? null,
    conversationId: request.conversationId ?? null,
    store: request.modelSettings?.store ?? null,
    serviceTier: request.modelSettings?.providerData?.service_tier ?? null,
    reasoning: request.modelSettings?.reasoning ?? null,
    inputCount: input.length,
    inputTypes: input.map((item) => item?.type ?? typeof item),
    toolCount: request.tools?.length ?? 0,
  };
}
