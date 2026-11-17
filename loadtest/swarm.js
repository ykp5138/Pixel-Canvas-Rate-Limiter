// k6 bot swarm. Every user here is simulated.
//
//   docker compose run --rm k6 run /scripts/swarm.js
//   docker compose run --rm -e BOTS=lurker,placer -e SCALE=5 k6 run /scripts/swarm.js
//   docker compose run --rm -e BOTS=lurker,placer -e PROFILE=ramp -e SCALE=50 k6 run /scripts/swarm.js
//
// After `--scale app=N`, add --no-deps, or `run` resets app back to the compose file's replica count.

import { WebSocket } from "k6/websockets";
import { setTimeout, clearTimeout, setInterval, clearInterval } from "k6/timers";
import { Counter, Trend } from "k6/metrics";

const TARGET = __ENV.TARGET || "ws://localhost:8080";
const DURATION = __ENV.DURATION || "1m";
const SCALE = Number(__ENV.SCALE || 1);
const BOTS = (__ENV.BOTS || "lurker,placer,spammer,hopper,garbage").split(",");
// "constant": full SCALE for DURATION. "ramp": climb to SCALE in STEPS steps, holding each for STEP.
const PROFILE = __ENV.PROFILE || "constant";
const STEPS = Number(__ENV.STEPS || 5);
const STEP = __ENV.STEP || "1m";

const WIDTH = 100;
const HEIGHT = 100;
const COLORS = 16;
const COOLDOWN_SECONDS = 30;

// ---------------------------------------------------------------------------
// Metrics (client side)
// ---------------------------------------------------------------------------

const snapshotTime = new Trend("snapshot_time", true);
const pixelRoundTrip = new Trend("pixel_round_trip", true);
const placesSent = new Counter("places_sent");
const pixelsAccepted = new Counter("pixels_accepted");
const errorsReceived = new Counter("errors_received");
const policyCloses = new Counter("policy_closes");

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const ALL_SCENARIOS = {
  lurker: { exec: "lurker", vus: 20 },
  placer: { exec: "placer", vus: 10 },
  spammer: { exec: "spammer", vus: 2 },
  hopper: { exec: "hopper", vus: 2 },
  garbage: { exec: "garbage", vus: 1 },
};

function rampStages(peak) {
  const stages = [];
  for (let i = 1; i <= STEPS; i++) {
    const target = Math.max(1, Math.round((peak * i) / STEPS));
    stages.push({ duration: "30s", target }); // climb
    stages.push({ duration: STEP, target }); // hold
  }
  stages.push({ duration: "30s", target: 0 });
  return stages;
}

const scenarios = {};
const thresholds = {};
for (const name of BOTS) {
  const s = ALL_SCENARIOS[name];
  if (!s) throw new Error(`unknown bot type: ${name}`);
  const peak = Math.max(1, Math.round(s.vus * SCALE));
  scenarios[name] =
    PROFILE === "ramp"
      ? { executor: "ramping-vus", exec: s.exec, startVUs: 0, stages: rampStages(peak), gracefulRampDown: "10s" }
      : { executor: "constant-vus", exec: s.exec, vus: peak, duration: DURATION, gracefulStop: "10s" };

  // No-op thresholds so the summary breaks these down per bot type
  if (["placer", "spammer", "hopper"].includes(name)) {
    thresholds[`places_sent{scenario:${name}}`] = ["count>=0"];
    thresholds[`pixels_accepted{scenario:${name}}`] = ["count>=0"];
  }
}

export const options = { scenarios, thresholds };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

// Random duration in milliseconds between min and max seconds
function randomMs(minSeconds, maxSeconds) {
  return (minSeconds + Math.random() * (maxSeconds - minSeconds)) * 1000;
}

// 30% of placements go to a small "hot" corner, like real users crowding one spot
function randomPlace() {
  const hot = Math.random() < 0.3;
  return {
    type: "place",
    x: hot ? randomInt(10) : randomInt(WIDTH),
    y: hot ? randomInt(10) : randomInt(HEIGHT),
    color: randomInt(COLORS),
  };
}

function openSocket(userId) {
  return new WebSocket(`${TARGET}/?userId=${userId}`);
}

function sendJson(ws, message) {
  ws.send(JSON.stringify(message));
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

// TODO C1: lurker
export function lurker() {
  const userId = crypto.randomUUID();
  const startTime = Date.now();
  const ws = openSocket(userId);
  ws.onopen = () => {
    setTimeout(() => {
      ws.close();
    }, randomMs(20, 60));
  };
  ws.onmessage = (event) => {
    const snapshot = JSON.parse(event.data);
    if (snapshot.type !== "snapshot") return;
    snapshotTime.add(Date.now() - startTime);
  };

}

let placerId = null;
export function placer() {
  if (!placerId) placerId = crypto.randomUUID();
  let timerId = null;
  let pendingPixel = null;
  const ws = openSocket(placerId);
  ws.onopen = () => {
    setTimeout(() => {
      ws.close();
    }, randomMs(60,120));
  };
  
  function placeNow() {
    if (ws.readyState !== 1){
      return
    }
    const msg = randomPlace();
    sendJson(ws, msg);
    placesSent.add(1);
    pendingPixel = { ...msg, sentAt: Date.now() };

  }

  function planPlacement(delayMs) {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      placeNow();
    }, delayMs);
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      planPlacement(randomMs(1,5));
    } else if (msg.type === "cooldown"){
      planPlacement(msg.seconds * 1000 + randomMs(1,5));
    } else if (msg.type === "pixels") {
      if(pendingPixel && msg.pixels.some(p=> p.x === pendingPixel.x && p.y === pendingPixel.y && p.color === pendingPixel.color)){
        pixelRoundTrip.add(Date.now() - pendingPixel.sentAt);
        pixelsAccepted.add(1);
        pendingPixel = null;
      };
    }
  }

  ws.onclose = (event) => {
    clearTimeout(timerId);
  }
  

}

let spammerId = null;
export function spammer() {
  if (!spammerId) spammerId = crypto.randomUUID();
  const ws = openSocket(spammerId);
  let timerId = null;
  ws.onopen = () => {
    setTimeout(() => {
      ws.close();
    }, randomMs(60,120));
    timerId = setInterval(() => {
      const randomPixel = randomPlace();
      if(ws.readyState !== 1){
        return
      }
      sendJson(ws, randomPixel);
      placesSent.add(1);
    }, 200);
  };
  ws.onclose = () => {
    clearInterval(timerId);
  };
}


export function hopper() {
  const userId = crypto.randomUUID();
  let pendingPixel = null;
  const ws = openSocket(userId);
  let alarmId = setTimeout(() => {
    ws.close();
  }, 5000);

  ws.onclose = () => {
    clearTimeout(alarmId);
  }
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "snapshot") {
      const randomPixel = randomPlace();
      sendJson(ws, randomPixel);
      placesSent.add(1);
      pendingPixel = { ...randomPixel, sentAt: Date.now() };
    }
    if (msg.type === "pixels") {
      if(pendingPixel && msg.pixels.some(p=> p.x === pendingPixel.x && p.y === pendingPixel.y && p.color === pendingPixel.color)){
        pixelsAccepted.add(1);
        ws.close();
      }
    }
  };
}


export function garbage() {
  const coinFlip = Math.random();
  if (coinFlip < 0.5) {
    const ws =openSocket("not-a-uuid");
    ws.onclose = (event) => {
      if (event.code === 1008){
        policyCloses.add(1);
      }
    }
  } else {
    const validId = crypto.randomUUID();
    const ws = openSocket(validId);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "snapshot") {
        sendJson(ws, { type: "place", x: 500, y: -1, color: 0});
        sendJson(ws, { type: "place", x: 0, y: 0, color: 100 });
        sendJson(ws, {type: "explode"})
        ws.send("not json");
        setTimeout(() => {
        ws.close();
        },2000);
      }
      if (msg.type === "error") {
        errorsReceived.add(1);
      }
    }

  }
}

