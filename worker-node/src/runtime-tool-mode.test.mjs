import assert from "node:assert/strict";

import {
  capabilitiesForProvider,
  providerDefaultsFor,
  resolveRuntimeToolMode,
  runtimeToolModeReason,
  runtimeToolProtocol,
} from "./worker.mjs";

const official = capabilitiesForProvider({
  apiProtocol: "responses",
  providerProfile: "official",
  responsesRelayMode: false,
  sendServiceTier: true,
});
assert.equal(official.officialRuntimeTools, true);
assert.equal(resolveRuntimeToolMode({ value: "auto", apiProtocol: "responses", providerCapabilities: official }), "sdk");
assert.equal(runtimeToolProtocol("sdk"), "openai.shell/apply_patch");
assert.match(runtimeToolModeReason("sdk", official, "responses"), /official Responses/);

const relayDefaults = providerDefaultsFor({
  providerLabel: "new-api-codex",
  providerProfile: "auto",
});
assert.equal(relayDefaults.providerProfile, "codex-responses");
const relay = capabilitiesForProvider({
  apiProtocol: "responses",
  providerProfile: relayDefaults.providerProfile,
  responsesRelayMode: relayDefaults.responsesRelayMode,
  sendServiceTier: false,
});
assert.equal(relay.officialRuntimeTools, false);
assert.equal(resolveRuntimeToolMode({ value: "auto", apiProtocol: "responses", providerCapabilities: relay }), "function");
assert.equal(runtimeToolProtocol("function"), "function.shell/apply_patch");
assert.match(runtimeToolModeReason("function", relay, "responses"), /relay/);

assert.equal(resolveRuntimeToolMode({ value: "function", apiProtocol: "responses", providerCapabilities: official }), "function");
assert.equal(resolveRuntimeToolMode({ value: "sdk", apiProtocol: "responses", providerCapabilities: relay }), "sdk");
assert.throws(
  () => resolveRuntimeToolMode({ value: "sdk", apiProtocol: "chat_completions", providerCapabilities: relay }),
  /requires OPENAI_API_PROTOCOL=responses/
);
assert.equal(resolveRuntimeToolMode({ value: "auto", apiProtocol: "chat_completions", providerCapabilities: official }), "function");

console.log("runtime tool mode ok");
