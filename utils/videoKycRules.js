import crypto from "crypto";

const MINUTE = 60 * 1000;

const envNumber = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const idOf = (value) => String(value?._id || value || "");

/**
 * The time window in which a scheduled call can be joined:
 * from a few minutes before the slot until a grace period after it ends.
 */
export const getJoinWindow = (session) => {
  const early = envNumber("VIDEO_KYC_JOIN_EARLY_MIN", 10);
  const grace = envNumber("VIDEO_KYC_GRACE_MIN", 30);
  const start = new Date(session.scheduledAt).getTime();
  const duration = session.durationMinutes || 30;

  return {
    opensAt: new Date(start - early * MINUTE),
    closesAt: new Date(start + (duration + grace) * MINUTE),
  };
};

/** Can this session be joined right now? */
export const canJoinSession = (session, now = new Date()) => {
  if (!session) return { ok: false, code: "not_found", reason: "Session not found" };

  if (["cancelled", "completed", "missed"].includes(session.status)) {
    return {
      ok: false,
      code: session.status,
      reason: `This video KYC session is ${session.status}`,
    };
  }

  const { opensAt, closesAt } = getJoinWindow(session);

  // A call that already started can be re-joined after a network drop
  if (session.status === "in_progress") {
    const maxMs = 3 * 60 * MINUTE;
    if (session.startedAt && now - new Date(session.startedAt) > maxMs) {
      return { ok: false, code: "expired", reason: "This call has been open too long", opensAt, closesAt };
    }
    return { ok: true, opensAt, closesAt };
  }

  if (now < opensAt) {
    return {
      ok: false,
      code: "too_early",
      reason: "It is too early to join. Please come back at the scheduled time.",
      opensAt,
      closesAt,
    };
  }

  if (now > closesAt) {
    return {
      ok: false,
      code: "expired",
      reason: "The scheduled time slot has passed",
      opensAt,
      closesAt,
    };
  }

  return { ok: true, opensAt, closesAt };
};

/** "customer", "officer" or null for someone who is not part of the session */
export const getParticipantRole = (session, user) => {
  if (!session || !user) return null;
  const userId = idOf(user);
  if (idOf(session.customer) === userId) return "customer";
  if (idOf(session.officer) === userId || user.role === "admin") return "officer";
  return null;
};

/** Officer-side actions: the assigned officer or any admin */
export const isSessionOfficer = (session, user) =>
  Boolean(user) && (user.role === "admin" || idOf(session.officer) === idOf(user));

export const validateScheduledAt = (value, now = new Date()) => {
  if (!value) return { ok: false, message: "scheduledAt is required (ISO date-time)" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, message: "scheduledAt is not a valid date-time" };
  }
  if (date.getTime() < now.getTime() - MINUTE) {
    return { ok: false, message: "scheduledAt must be in the future" };
  }
  if (date.getTime() > now.getTime() + 30 * 24 * 60 * MINUTE) {
    return { ok: false, message: "scheduledAt cannot be more than 30 days ahead" };
  }
  return { ok: true, date };
};

/** Has the video KYC been completed properly? Used before final approval. */
export const evaluateVideoKyc = (session) => {
  const missing = [];

  if (!session) {
    return { passed: false, missing: ["Video KYC has not been done"] };
  }
  if (session.status !== "completed") missing.push("Video KYC call is not completed");
  if (!session.checklist?.faceVerified) missing.push("Face verification");
  if (!session.checklist?.documentVerified) missing.push("Document verification");
  if (!session.checklist?.livenessPassed) missing.push("Liveness check");
  if (!session.recordingConsent?.given) missing.push("Customer recording consent");
  if (!session.recording?.url) missing.push("Call recording");

  return { passed: missing.length === 0, missing };
};

/** STUN (and optional TURN) servers handed to the browsers / mobile apps */
export const getIceServers = () => {
  const servers = [
    { urls: (process.env.STUN_URL || "stun:stun.l.google.com:19302").split(",").map((s) => s.trim()) },
  ];

  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(",").map((s) => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return servers;
};

const CHALLENGES = {
  blink_twice: "Please blink your eyes twice",
  turn_left: "Please slowly turn your head to the left",
  turn_right: "Please slowly turn your head to the right",
  smile: "Please smile",
  read_number: (code) => `Please say this number aloud: ${code}`,
  show_pan: "Please show your original PAN card to the camera",
  show_aadhaar: "Please show your original Aadhaar card to the camera",
};

export const LIVENESS_CHALLENGE_TYPES = Object.keys(CHALLENGES);

/** A liveness prompt for the customer. read_number gets a random code each time. */
export const buildLivenessChallenge = (type) => {
  const entry = CHALLENGES[type];
  if (!entry) return null;

  const code = type === "read_number" ? String(crypto.randomInt(1000, 10000)) : undefined;

  return {
    id: crypto.randomUUID(),
    type,
    text: typeof entry === "function" ? entry(code) : entry,
    code,
  };
};