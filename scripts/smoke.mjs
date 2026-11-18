// Smoke test: checks a running server end to end. Exits 0 on pass, 1 on fail.
//
//   node scripts/smoke.mjs
//   BASE_URL=http://localhost:8080 node scripts/smoke.mjs


const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const WIDTH = 100;
const HEIGHT = 100;
const COLORS = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

// Polls /readyz until the server is up and connected to Redis
async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/readyz`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`server not ready after ${timeoutMs} ms`);
}

// Opens a WebSocket and keeps every message it receives in an inbox
function openClient(userId) {
  const client = {
    ws: new WebSocket(`${WS_URL}/?userId=${userId}`),
    inbox: [],
    closeCode: null,
  };
  client.ws.onmessage = (event) => client.inbox.push(JSON.parse(event.data));
  client.ws.onclose = (event) => {
    client.closeCode = event.code;
  };
  return client;
}

// Resolves with (and removes) the first message where match(msg) is true
async function waitForMessage(client, match, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const i = client.inbox.findIndex(match);
    if (i !== -1) return client.inbox.splice(i, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail(`timed out waiting for ${what}`);
}

// Resolves with the close code once the socket closes
async function waitForClose(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.closeCode !== null) return client.closeCode;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fail("timed out waiting for the socket to close");
}

function send(client, message) {
  client.ws.send(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  await waitForReady();
  console.log("ok   server ready");

  // liveness endpoint
  const res =  await fetch(`${BASE_URL}/healthz`);
  if(res.status !== 200 || await res.text() !== "ok"){
    fail(`/healthz returned ${res.status}`);
  }
  console.log("ok healthz");

  // snapshot on connect
  const userId = crypto.randomUUID();
  const client = openClient(userId);
  const snapshot = await waitForMessage(client,(msg) => msg.type === "snapshot", "snapshot" );
  if (snapshot.width !== WIDTH || snapshot.height !== HEIGHT || snapshot.pixels.length !== WIDTH*HEIGHT){
    fail(`snapshot was ${snapshot.width}x${snapshot.height} with ${snapshot.pixels.length} pixels`);
  }
  console.log("ok snapshot");
  // placed pixel comes back in a batch
  const place = { type: "place", x: randomInt(WIDTH), y: randomInt(HEIGHT), color: randomInt(COLORS) };
  send(client,place);
  const pixelPlace = await waitForMessage(client, (msg) => msg.type === "pixels" && msg.pixels.some((p) => p.x === place.x && p.y === place.y && p.color === place.color), "my pixel in a batch");

  console.log("ok pixel broadcast");
  // second placement hits the cooldown
  await waitForMessage(client, (msg) => msg.type === "cooldown", "first cooldown");
  send(client, place);
  const cooldown = await waitForMessage(client, (msg) => msg.type === "cooldown", "cooldown after second place");
  if(cooldown.seconds <= 0){
    fail(`cooldown was ${cooldown.seconds} seconds`);
  }
  client.ws.close();
  console.log("ok cooldown");

  // new client's snapshot includes the pixel
  const id = crypto.randomUUID();
  const newClient = openClient(id);
  const newSnapshot = await waitForMessage(newClient, (msg) => msg.type === "snapshot", "second snapshot");
  const savedColor = newSnapshot.pixels[place.y * WIDTH + place.x];
  if(savedColor !== place.color){
    fail(`pixel saved as color ${savedColor}, expected ${place.color}`);
  }
  newClient.ws.close();
  console.log("ok persisted");
  
  // invalid user ID is rejected
  const badClient = openClient("not-a-uuid");
  const code = await waitForClose(badClient);
  if(code !== 1008){
    fail(`bad user id closed with ${code}, expected 1008`);
  }
  console.log("ok bad user id rejected");

}

const timeout = setTimeout(() => {
  console.error("FAIL smoke test took longer than 30 s");
  process.exit(1);
}, 30000);

try {
  await main();
  console.log("PASS");
  clearTimeout(timeout);
  process.exit(0);
} catch (err) {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
}
