import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes
} from "node:crypto";

export const PROTOCOL_VERSION = 3;
export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function transcript(fields) {
  return stableStringify({
    connectionId: fields.connectionId,
    clientNonce: fields.clientNonce,
    serverNonce: fields.serverNonce,
    extensionNonce: fields.extensionNonce,
    extensionId: fields.extensionId,
    protocolVersion: PROTOCOL_VERSION
  });
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function pairingKey(code, value) {
  const salt = createHash("sha256")
    .update(`tabward-pairing:${value}`)
    .digest();
  return pbkdf2Sync(code, salt, 150_000, 32, "sha256").toString("base64url");
}

function nonce() {
  return randomBytes(32).toString("base64url");
}

export function nextSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function request(socket, message) {
  const reply = nextSocketMessage(socket);
  socket.send(JSON.stringify(message));
  return await reply;
}

export async function pairSocket(
  socket,
  getPairingCode,
  extensionVersion = "0.4.0"
) {
  const clientNonce = nonce();
  const challenge = await request(socket, {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionId: EXTENSION_ID,
    extensionVersion,
    clientNonce,
    hasPairingToken: false
  });
  assert.equal(challenge.kind, "pairing_required");
  assert.equal(challenge.clientNonce, clientNonce);
  assert.equal("token" in challenge, false);
  const extensionNonce = nonce();
  const fields = {
    connectionId: challenge.connectionId,
    clientNonce,
    serverNonce: challenge.serverNonce,
    extensionNonce,
    extensionId: EXTENSION_ID
  };
  const value = transcript(fields);
  const key = pairingKey(await getPairingCode(), value);
  const approved = await request(socket, {
    kind: "pairing_approve",
    protocolVersion: PROTOCOL_VERSION,
    code: await getPairingCode(),
    connectionId: fields.connectionId,
    clientNonce,
    serverNonce: fields.serverNonce,
    extensionNonce
  });
  assert.equal(approved.kind, "pairing_approved");
  assert.equal("token" in approved, false);
  assert.equal(
    approved.brokerProof,
    hmac(key, `broker-pairing:${value}`)
  );
  const complete = await request(socket, {
    kind: "pairing_confirm",
    protocolVersion: PROTOCOL_VERSION,
    connectionId: fields.connectionId,
    extensionProof: hmac(key, `extension-pairing:${value}`)
  });
  assert.equal(complete.kind, "pairing_complete");
  assert.equal(typeof complete.token, "string");
  return complete.token;
}

export async function authenticateSocket(
  socket,
  token,
  extensionVersion = "0.4.0"
) {
  const clientNonce = nonce();
  const challenge = await request(socket, {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    extensionId: EXTENSION_ID,
    extensionVersion,
    clientNonce,
    hasPairingToken: true
  });
  assert.equal(challenge.kind, "auth_challenge");
  assert.equal(challenge.clientNonce, clientNonce);
  assert.equal("token" in challenge, false);
  const extensionNonce = nonce();
  const fields = {
    connectionId: challenge.connectionId,
    clientNonce,
    serverNonce: challenge.serverNonce,
    extensionNonce,
    extensionId: EXTENSION_ID
  };
  const value = transcript(fields);
  const brokerProof = await request(socket, {
    kind: "auth_response",
    protocolVersion: PROTOCOL_VERSION,
    connectionId: fields.connectionId,
    clientNonce,
    serverNonce: fields.serverNonce,
    extensionNonce,
    extensionProof: hmac(token, `extension:${value}`)
  });
  assert.equal(brokerProof.kind, "broker_proof");
  assert.equal(brokerProof.proof, hmac(token, `broker:${value}`));
  const ready = await request(socket, {
    kind: "auth_confirm",
    protocolVersion: PROTOCOL_VERSION,
    connectionId: fields.connectionId,
    proof: hmac(token, `confirm:${value}`)
  });
  assert.equal(ready.kind, "ready");
}
