import { Server } from "socket.io";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import VideoKycSession from "../models/VideoKycSession.js";
import {
  canJoinSession,
  getParticipantRole,
  buildLivenessChallenge,
} from "../utils/videoKycRules.js";
import { markInProgress, expireIfMissed } from "../services/videoKycService.js";

/**
 * WebRTC signaling for Video KYC.
 *
 * The audio/video itself flows directly between the customer's and the
 * officer's devices (peer-to-peer). This server only passes the small
 * setup messages (offer / answer / ICE candidates) between the two people
 * in a room, and relays the officer's liveness prompts.
 *
 * NOTE: room state is kept in this process's memory, so this works with a
 * single server instance. For several instances, add the Socket.IO Redis adapter.
 */

let io = null;
const rooms = new Map(); // roomName -> { officer: socketId | null, customer: socketId | null }

const roomName = (sessionId) => `vkyc:${sessionId}`;
const reply = (ack, payload) => typeof ack === "function" && ack(payload);

export const getIO = () => io;

/** Send an event to everyone in a session's room (used by the REST controllers) */
export const emitToRoom = (sessionId, event, payload) => {
  if (io) io.to(roomName(sessionId)).emit(event, payload);
};

export const initVideoKycSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e5, // signaling messages are tiny
  });

  // Only logged-in users may connect (same JWT as the REST API)
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");

      if (!token) return next(new Error("Unauthorized: no token"));

      const secret = process.env.JWT_SECRET || "flowly_secret_key_12345";
      const decoded = jwt.verify(token, secret);
      const user = await User.findById(decoded.id).select("-password -pinHash");

      if (!user || user.status === "blocked") return next(new Error("Unauthorized"));

      socket.data.user = user;
      next();
    } catch (err) {
      next(new Error("Unauthorized: invalid token"));
    }
  });

  io.on("connection", (socket) => {
    // ---- join a video KYC room ------------------------------------------
    socket.on("join-room", async (payload, ack) => {
      try {
        const sessionId = payload?.sessionId;
        if (!mongoose.isValidObjectId(sessionId)) {
          return reply(ack, { ok: false, message: "Invalid sessionId" });
        }

        let session = await VideoKycSession.findById(sessionId);
        const role = getParticipantRole(session, socket.data.user);
        if (!session || !role) {
          return reply(ack, { ok: false, message: "You are not part of this video KYC session" });
        }

        session = await expireIfMissed(session);
        const check = canJoinSession(session);
        if (!check.ok) return reply(ack, { ok: false, code: check.code, message: check.reason });

        // The call starts when the officer joins
        if (role === "officer") await markInProgress(session);

        const name = roomName(session._id);
        const state = rooms.get(name) || { officer: null, customer: null };

        // Same person reconnecting (or opening a second tab): the newest wins
        const previousId = state[role];
        if (previousId && previousId !== socket.id) {
          const old = io.sockets.sockets.get(previousId);
          if (old) {
            old.emit("replaced");
            old.leave(name);
          }
        }

        state[role] = socket.id;
        rooms.set(name, state);

        socket.join(name);
        socket.data.room = { name, role, sessionId: String(session._id) };

        const other = role === "officer" ? "customer" : "officer";
        const peerPresent = Boolean(state[other]);
        if (peerPresent) socket.to(name).emit("peer-joined", { role });

        reply(ack, {
          ok: true,
          role,
          peerPresent,
          recordingConsent: session.recordingConsent?.given === true,
        });
      } catch (err) {
        console.error("video-kyc join-room error:", err);
        reply(ack, { ok: false, message: "Could not join the room" });
      }
    });

    // ---- WebRTC offer / answer / ICE candidates ---------------------------
    socket.on("signal", (message) => {
      const ctx = socket.data.room;
      if (!ctx || !message) return;
      if (!["offer", "answer", "candidate"].includes(message.type)) return;
      if (JSON.stringify(message.data ?? null).length > 20000) return;

      socket.to(ctx.name).emit("signal", {
        type: message.type,
        data: message.data,
        from: ctx.role,
      });
    });

    // ---- officer sends a liveness prompt to the customer ------------------
    socket.on("liveness-challenge", async (payload, ack) => {
      try {
        const ctx = socket.data.room;
        if (!ctx || ctx.role !== "officer") {
          return reply(ack, { ok: false, message: "Only the officer can send liveness prompts" });
        }

        const challenge = buildLivenessChallenge(payload?.type);
        if (!challenge) return reply(ack, { ok: false, message: "Unknown challenge type" });

        await VideoKycSession.updateOne(
          { _id: ctx.sessionId },
          {
            $push: {
              livenessChallenges: {
                $each: [{ ...challenge, sentAt: new Date() }],
                $slice: -50,
              },
            },
          }
        );

        socket.to(ctx.name).emit("liveness-challenge", challenge);
        reply(ack, { ok: true, challenge });
      } catch (err) {
        console.error("liveness-challenge error:", err);
        reply(ack, { ok: false, message: "Could not send the challenge" });
      }
    });

    // ---- customer says the prompt has been done ---------------------------
    socket.on("challenge-done", (payload) => {
      const ctx = socket.data.room;
      if (!ctx || ctx.role !== "customer") return;
      socket.to(ctx.name).emit("challenge-done", { id: payload?.id, at: new Date() });
    });

    // ---- officer tells the customer recording has started / stopped -------
    socket.on("recording-state", async (payload, ack) => {
      try {
        const ctx = socket.data.room;
        if (!ctx || ctx.role !== "officer") {
          return reply(ack, { ok: false, message: "Only the officer can record" });
        }

        const recording = payload?.recording === true;

        if (recording) {
          const session = await VideoKycSession.findById(ctx.sessionId).select("recordingConsent");
          if (!session?.recordingConsent?.given) {
            return reply(ack, {
              ok: false,
              message: "The customer has not given consent to record this call",
            });
          }
        }

        socket.to(ctx.name).emit("recording-state", { recording });
        reply(ack, { ok: true });
      } catch (err) {
        reply(ack, { ok: false, message: "Could not update recording state" });
      }
    });

    // ---- someone left / lost connection -----------------------------------
    socket.on("disconnect", () => {
      const ctx = socket.data.room;
      if (!ctx) return;

      const state = rooms.get(ctx.name);
      // Ignore sockets that were already replaced by a newer connection
      if (!state || state[ctx.role] !== socket.id) return;

      state[ctx.role] = null;
      if (!state.officer && !state.customer) rooms.delete(ctx.name);

      socket.to(ctx.name).emit("peer-left", { role: ctx.role });
    });
  });

  return io;
};