export function event(type, payload = {}, options = {}) {
  return {
    type,
    visibility: options.visibility ?? "user",
    itemId: options.itemId,
    parentId: options.parentId,
    status: options.status,
    payload
  };
}

export async function postEvent(eventBody) {
  const apiBaseUrl = mustEnv("API_BASE_URL");
  const runId = mustEnv("RUN_ID");
  const workerToken = mustEnv("WORKER_TOKEN");

  const response = await fetch(`${apiBaseUrl}/internal/runs/${runId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${workerToken}`
    },
    body: JSON.stringify(eventBody)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to post event ${eventBody.type}: ${response.status} ${body}`);
  }
}

export async function postEvents(eventBodies) {
  for (const eventBody of eventBodies) {
    await postEvent(eventBody);
  }
}

export function mustEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function optionalEnv(name, fallback = undefined) {
  return process.env[name] || fallback;
}
