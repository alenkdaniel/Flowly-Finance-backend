import express from "express";
import {
  scheduleVideoKyc,
  rescheduleVideoKyc,
  cancelVideoKyc,
  listSessions,
  getMySession,
  getSession,
  joinSession,
  giveRecordingConsent,
  updateChecklist,
  uploadRecording,
  endSession,
} from "../controllers/videoKycController.js";
import { protect, authorize } from "../middleware/authMiddleware.js";
import { uploadRecordingFile } from "../middleware/recordingUploadMiddleware.js";

const router = express.Router();

// Officer / admin
router.post("/schedule", protect, authorize("worker", "admin"), scheduleVideoKyc);
router.get("/sessions", protect, authorize("worker", "admin"), listSessions);
router.put("/sessions/:id/reschedule", protect, authorize("worker", "admin"), rescheduleVideoKyc);
router.put("/sessions/:id/cancel", protect, authorize("worker", "admin"), cancelVideoKyc);
router.put("/sessions/:id/checklist", protect, authorize("worker", "admin"), updateChecklist);
router.post(
  "/sessions/:id/recording",
  protect,
  authorize("worker", "admin"),
  uploadRecordingFile,
  uploadRecording
);
router.put("/sessions/:id/end", protect, authorize("worker", "admin"), endSession);

// Customer
router.get("/my-session", protect, authorize("customer"), getMySession);
router.post("/sessions/:id/consent", protect, authorize("customer"), giveRecordingConsent);

// Both sides (the controller checks who is who)
router.get("/sessions/:id", protect, getSession);
router.post("/sessions/:id/join", protect, joinSession);

export default router;