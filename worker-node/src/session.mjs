export class BackendConversationSession {
  constructor({ conversationId, apiBaseUrl, workerToken }) {
    this.conversationId = conversationId;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.workerToken = workerToken;
  }

  async getSessionId() {
    return this.conversationId;
  }

  async getItems(limit) {
    const query = Number.isInteger(limit) && limit > 0 ? `?limit=${limit}` : "";
    const data = await this.requestJson(`/internal/conversations/${this.encodedConversationId}/agent-session/items${query}`);
    return Array.isArray(data.items) ? data.items : [];
  }

  async addItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }
    await this.requestJson(`/internal/conversations/${this.encodedConversationId}/agent-session/items`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  async popItem() {
    const data = await this.requestJson(`/internal/conversations/${this.encodedConversationId}/agent-session/pop`, {
      method: "POST",
    });
    return data.item ?? undefined;
  }

  async clearSession() {
    await this.requestJson(`/internal/conversations/${this.encodedConversationId}/agent-session`, {
      method: "DELETE",
    });
  }

  get encodedConversationId() {
    return encodeURIComponent(this.conversationId);
  }

  async requestJson(path, options = {}) {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.workerToken}`,
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Agent session request failed: ${response.status} ${body}`);
    }
    return response.json();
  }
}
